// Differential gate for the sse_decoder brick swap.
// Compares the pure-TS port (src/sse_decoder.ts SseDecoder) against the
// streaming wasm path (wasm/sse_bridge.ts WasmSseDecoder) over a
// representative set of SSE byte streams — including multi-chunk splits
// across event boundaries, the start/text*/stop sequence, and the [DONE]
// sentinel. Its JOB is to enumerate divergences BEFORE the wrapper flips —
// nothing is swapped/deleted until this is green. Additive; no existing
// test touched.

import { test, expect } from "bun:test";
import { SseDecoder } from "../src/sse_decoder.ts";
import { WasmSseDecoder } from "../src/wasm/sse_bridge.ts";
import type { Event } from "../src/types.ts";

const FIXTURE_011 =
  "/workspaces/luv/core/fixtures/openai/011_stream_basic/response.sse.txt";

async function loadFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Drain a whole byte buffer through a decoder in fixed-size chunks.
function drainTs(bytes: Uint8Array, chunkSize: number): Event[] {
  const dec = new SseDecoder();
  const out: Event[] = [];
  if (chunkSize <= 0) return dec.feed(bytes);
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out.push(...dec.feed(bytes.subarray(i, Math.min(i + chunkSize, bytes.length))));
  }
  return out;
}

function drainWasm(bytes: Uint8Array, chunkSize: number): Event[] {
  const dec = new WasmSseDecoder();
  const out: Event[] = [];
  try {
    if (chunkSize <= 0) {
      out.push(...dec.feed(bytes));
    } else {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        out.push(...dec.feed(bytes.subarray(i, Math.min(i + chunkSize, bytes.length))));
      }
    }
  } finally {
    dec.free();
  }
  return out;
}

const START_TEXT_STOP =
  `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{"content":", "},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
  `data: [DONE]\n\n`;

const cases: { name: string; bytes: Uint8Array }[] = [
  { name: "start/text*/stop + [DONE]", bytes: enc(START_TEXT_STOP) },
  {
    name: "finish_reason=length",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "finish_reason=tool_calls",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "unknown finish_reason -> other",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"some_future_reason"}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "comment lines ignored",
    bytes: enc(
      `: keep-alive\n` +
        `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n` +
        `: another comment\n` +
        `data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "usage-only chunk (no choices) tolerated",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
        `data: {"id":"chatcmpl-x","usage":{"prompt_tokens":1}}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "CRLF frame terminators",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":"a"},"finish_reason":null}]}\r\n\r\n` +
        `data: [DONE]\r\n\r\n`,
    ),
  },
  {
    name: "multibyte UTF-8 content",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":"🚀✨"},"finish_reason":null}]}\n\n` +
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
        `data: [DONE]\n\n`,
    ),
  },
  {
    name: "feed continues to be ignored after [DONE]",
    bytes: enc(
      `data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
        `data: [DONE]\n\n` +
        `data: {"choices":[{"delta":{"content":"ignored"},"finish_reason":null}]}\n\n`,
    ),
  },
];

// Chunk sizes: one-shot, tiny (split mid-codepoint & mid-frame), small, and
// a prime to straggle across event boundaries.
const CHUNK_SIZES = [0, 1, 3, 13, 37];

for (const c of cases) {
  for (const cs of CHUNK_SIZES) {
    test(`sse parity: ${c.name} @ chunk=${cs}`, () => {
      const ts = drainTs(c.bytes, cs);
      const wasm = drainWasm(c.bytes, cs);
      expect(wasm).toEqual(ts);
    });
  }
}

// Real fixture, including multi-chunk splits across event boundaries.
test("sse parity: 011 fixture across chunk sizes", async () => {
  const bytes = await loadFixture(FIXTURE_011);
  for (const cs of [0, 1, 7, 37, 256]) {
    const ts = drainTs(bytes, cs);
    const wasm = drainWasm(bytes, cs);
    expect(wasm).toEqual(ts);
  }
});

// Lifecycle: free() is idempotent and post-free feed() is a no-op (mirrors
// the TS port's post-[DONE] latch so the swapped surface stays identical).
test("WasmSseDecoder: free() idempotent + post-free feed() is a no-op", () => {
  const dec = new WasmSseDecoder();
  const ev = dec.feed(enc(START_TEXT_STOP));
  expect(ev.length).toBeGreaterThan(0);
  dec.free();
  dec.free(); // idempotent — must not throw / double-free
  expect(dec.feed(enc(START_TEXT_STOP))).toEqual([]);
});
