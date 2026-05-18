// SSE decoder for OpenAI Chat Completions streaming.
//
// Single-sourced in Zig: SseDecoder now delegates to the streaming wasm core
// over the codec boundary (see wasm/sse_bridge.ts). The ~95-line pure-TS port
// (frame scanning, JSON parsing, finish-reason mapping) was deleted after the
// differential test (test/sse.diff.test.ts) proved byte/behavior equivalence
// across one-shot and multi-chunk feeds (incl. the [DONE] cross-call latch).
//
// The exported surface is UNCHANGED — `new SseDecoder()` + `feed(bytes)` ->
// `Event[]`, stateful and streaming-safe (chunks may straddle UTF-8
// codepoints / SSE frame boundaries; feeding after [DONE] is a no-op). The
// only consumer, send_stream.ts, and its tests are untouched.
//
// Handle lifecycle: WasmSseDecoder owns a wasm Decoder handle. It is freed
// eagerly the moment the [DONE] sentinel is seen (the normal-completion
// path — no GC wait). For the abort/error path, send_stream.ts drops the
// SseDecoder without [DONE] and (being unmodifiable) never calls free(); a
// FinalizationRegistry below reclaims the handle when the SseDecoder is
// garbage-collected, so an aborted/errored stream cannot leak wasm memory.
//
// Loss table (openai stream → luv stream) is enforced in Zig
// (core/src/morphisms/openai/openai_stream.zig):
//   - id, object, created, model, system_fingerprint, service_tier — dropped.
//   - obfuscation — dropped.
//   - choice.index, choice.logprobs — dropped.
//   - delta.refusal — coerced to text (lossy: not tagged).
//   - data: [DONE] terminator — consumed without emitting an event.

import { WasmSseDecoder } from "./wasm/sse_bridge.ts";
import type { Event } from "./types.ts";

// Safety net for the cancel/abort path: send_stream.ts cannot be modified to
// call free(), so reclaim any still-open wasm handle when the owning
// SseDecoder is collected. The eager [DONE] free() makes this a no-op for the
// common case; free() is idempotent so a double-free is impossible.
const reclaim = new FinalizationRegistry<WasmSseDecoder>((inner) => {
  inner.free();
});

export class SseDecoder {
  private readonly inner = new WasmSseDecoder();

  constructor() {
    reclaim.register(this, this.inner);
  }

  /** Feed raw response-body bytes. Returns 0+ events emitted by this chunk. */
  feed(bytes: Uint8Array): Event[] {
    return this.inner.feed(bytes);
  }
}
