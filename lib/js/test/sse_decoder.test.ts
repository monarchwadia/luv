// Phase I red tests: pure-TS SSE decoder mirroring core/src/morphisms/openai/openai_stream.zig.

import { test, expect } from "bun:test";
import { SseDecoder } from "../src/sse_decoder.ts";

const FIXTURE_011 = "/workspaces/luv/core/fixtures/openai/011_stream_basic/response.sse.txt";

async function loadFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

test("SseDecoder.feed: 011 fixture decodes to start + text deltas + stop end_turn", async () => {
  const bytes = await loadFixture(FIXTURE_011);
  const dec = new SseDecoder();
  const events = dec.feed(bytes);

  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events[0]!.type).toBe("start");
  if (events[0]!.type === "start") expect(events[0]!.role).toBe("assistant");

  const last = events[events.length - 1]!;
  expect(last.type).toBe("stop");
  if (last.type === "stop") expect(last.stopReason).toBe("end_turn");

  const concat = events
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta)
    .join("");
  expect(concat).toBe("1, 2, 3, 4, 5");
});

test("SseDecoder.feed: partial-feed yields the same total event count as one-shot", async () => {
  const bytes = await loadFixture(FIXTURE_011);
  const oneShot = new SseDecoder().feed(bytes);

  const dec = new SseDecoder();
  const collected: typeof oneShot = [];
  const chunkSize = 37;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const events = dec.feed(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    collected.push(...events);
  }
  expect(collected.length).toBe(oneShot.length);
});

test("SseDecoder.feed: data: [DONE] terminator does not emit an event", () => {
  const bytes = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(bytes);
  // start + 1 text + stop = 3
  expect(events.length).toBe(3);
});

test("SseDecoder.feed: empty input emits nothing", () => {
  const events = new SseDecoder().feed(new Uint8Array());
  expect(events).toEqual([]);
});

test("SseDecoder.feed: comment lines (`:keep-alive`) are ignored", () => {
  const bytes = new TextEncoder().encode(
    `: this is a comment\n` +
      `data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n` +
      `: another comment\n` +
      `data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(bytes);
  expect(events.length).toBe(2);
});
