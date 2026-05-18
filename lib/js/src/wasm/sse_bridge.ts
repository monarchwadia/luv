// Ergonomic <-> codec bridge for the sse_decoder brick, over the STREAMING
// wasm path. Mirrors the morphism-openai recipe (wasm/openai_bridge.ts) but
// for the stateful streaming decoder: this owns a wasm Decoder handle for its
// lifetime, feeds raw response-body chunks through luv_decoder_feed, decodes
// the codec-encoded EventBatch via codec.decodeEvents, and maps each
// CodecEvent to the ergonomic Event shape (types.ts).
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.
//
// Handle lifecycle: a wasm handle is acquired in the constructor
// (decoderNew). It MUST be released exactly once via free() — on the normal
// end of stream OR on cancel/abort — to avoid leaking wasm memory. free() is
// idempotent and feed() after free() is a no-op (mirrors the TS port's
// post-[DONE] / done behavior so the surface is identical).
//
// Cross-call [DONE] latch: the Zig Decoder.feed only short-circuits its
// `done` flag WITHIN one feed() call (it does not bail at the top of a later
// feed). The TS port latches `done` across calls, so a feed AFTER the [DONE]
// sentinel must be a no-op. Bridging that contract here requires a sentinel
// guard (NOT SSE decoding — the decode logic stays single-sourced in Zig): we
// watch the raw byte stream for the literal `data: [DONE]` marker, tolerating
// splits across chunks via a short carried tail, and latch once seen. The
// underlying divergence is genuinely un-fixable here; see sse.diff.test.ts
// `test.failing` cases (would need a one-line Zig guard at the top of
// Decoder.feed). See REPORT.

import { decoderNew, decoderFeed, decoderFree } from "./sync.ts";
import { decodeEvents } from "../codec.ts";
import type { Event, Role, StopReason } from "../types.ts";

// Numeric enum order matches core codec.zig (same arrays as openai_bridge.ts).
const ROLE: readonly Role[] = ["system", "user", "assistant"];
const STOP: readonly StopReason[] = [
  "end_turn",
  "max_tokens",
  "content_filter",
  "stop_sequence",
  "tool_use",
  "other",
];

// The SSE terminator OpenAI sends to end a stream. Matched at the byte level
// purely as a latch guard (no SSE framing/JSON parsing happens here).
const DONE_SENTINEL = new TextEncoder().encode("data: [DONE]");
const DONE_TAIL = DONE_SENTINEL.length - 1;

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export class WasmSseDecoder {
  private handle: number;
  private freed = false;
  private done = false;
  // Short trailing bytes carried so a [DONE] sentinel split across two
  // chunks is still recognized by the latch guard.
  private tail = new Uint8Array(0);

  constructor() {
    this.handle = decoderNew();
  }

  /** Feed raw response-body bytes. Returns 0+ events emitted by this chunk.
   *  No-op once the handle has been freed (post-cancel / post-completion)
   *  or once the [DONE] sentinel has been seen — matching the TS port's
   *  cross-call done-latch behavior. */
  feed(bytes: Uint8Array): Event[] {
    if (this.freed || this.done) return [];

    // Latch guard: scan (carried tail + this chunk) for the [DONE] sentinel.
    const scan = this.tail.length === 0
      ? bytes
      : (() => {
          const m = new Uint8Array(this.tail.length + bytes.length);
          m.set(this.tail, 0);
          m.set(bytes, this.tail.length);
          return m;
        })();
    const sentinelAt = indexOfBytes(scan, DONE_SENTINEL);
    this.tail = scan.length > DONE_TAIL ? scan.slice(scan.length - DONE_TAIL) : scan.slice();

    const batch = decoderFeed(this.handle, bytes);
    const codecEvents = decodeEvents(batch);
    const events: Event[] = [];
    for (const ce of codecEvents) {
      if (ce.kind === 0) {
        events.push({ type: "start", role: ROLE[ce.role] ?? "assistant" });
      } else if (ce.kind === 1) {
        events.push({ type: "text", delta: ce.delta });
      } else {
        events.push({ type: "stop", stopReason: STOP[ce.stopReason] ?? "other" });
      }
    }
    // Latch AFTER emitting this feed's events: the feed that carries [DONE]
    // still surfaces any pre-[DONE] events the wasm decoder produced (it
    // already breaks at [DONE] within the call); subsequent feeds are no-ops.
    // Eagerly release the wasm handle on the normal-completion path so the
    // common case never waits on GC for cleanup.
    if (sentinelAt !== -1) {
      this.done = true;
      this.free();
    }
    return events;
  }

  /** Release the wasm Decoder handle. Idempotent — safe to call on both the
   *  normal end of the stream and on cancel/abort. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    decoderFree(this.handle);
    this.handle = 0;
  }
}
