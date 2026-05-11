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

test("SseDecoder.feed: multi-byte UTF-8 character split across feed() calls decodes correctly", () => {
  const dec = new SseDecoder();
  // The "🚀" rocket is 4 bytes in UTF-8 (0xF0 0x9F 0x9A 0x80).
  const chunkText = `data: {"choices":[{"delta":{"role":"assistant","content":"🚀"},"finish_reason":null}]}\n\n`;
  const allBytes = new TextEncoder().encode(chunkText);
  // Split mid-rocket
  const rocketStart = allBytes.indexOf(0xf0);
  expect(rocketStart).toBeGreaterThan(0);
  // Two feeds: first ends mid-character, second completes it + the rest of the line.
  const events1 = dec.feed(allBytes.slice(0, rocketStart + 2));
  // Should not have emitted a text event yet — line not complete.
  expect(events1.filter((e) => e.type === "text").length).toBe(0);
  const events2 = dec.feed(allBytes.slice(rocketStart + 2));
  const text = events2.find((e) => e.type === "text");
  expect(text).toBeDefined();
  if (text?.type === "text") expect(text.delta).toBe("🚀");
});

test("SseDecoder.feed: finish_reason='length' maps to max_tokens", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(sse);
  const stop = events.find((e) => e.type === "stop");
  expect(stop).toBeDefined();
  if (stop?.type === "stop") expect(stop.stopReason).toBe("max_tokens");
});

test("SseDecoder.feed: finish_reason='content_filter' maps to content_filter", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(sse);
  const stop = events.find((e) => e.type === "stop");
  if (stop?.type === "stop") expect(stop.stopReason).toBe("content_filter");
});

test("SseDecoder.feed: finish_reason='tool_calls' maps to tool_use", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(sse);
  const stop = events.find((e) => e.type === "stop");
  if (stop?.type === "stop") expect(stop.stopReason).toBe("tool_use");
});

test("SseDecoder.feed: unknown finish_reason maps to 'other'", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"some_future_reason"}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events = new SseDecoder().feed(sse);
  const stop = events.find((e) => e.type === "stop");
  if (stop?.type === "stop") expect(stop.stopReason).toBe("other");
});

test("SseDecoder.feed: feeding after [DONE] is a no-op", () => {
  const dec = new SseDecoder();
  const sse1 = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`,
  );
  const events1 = dec.feed(sse1);
  expect(events1.length).toBeGreaterThan(0);
  // After [DONE], any further feed should be ignored.
  const events2 = dec.feed(new TextEncoder().encode(
    `data: {"choices":[{"delta":{"content":"more"},"finish_reason":null}]}\n\n`,
  ));
  expect(events2.length).toBe(0);
});

test("SseDecoder.feed: \\r\\n\\r\\n frame terminator is also recognized", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":"a"},"finish_reason":null}]}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`,
  );
  const events = new SseDecoder().feed(sse);
  // start + 1 text
  expect(events.length).toBe(2);
});

test("SseDecoder.feed: chunks with no choices array are tolerated (e.g. usage-only chunk)", () => {
  const sse = new TextEncoder().encode(
    `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n` +
      `data: {"id":"chatcmpl-x","usage":{"prompt_tokens":1}}\n\n` +
      `data: [DONE]\n\n`,
  );
  // Should not throw when a chunk has no `choices` field (OpenAI emits one
  // such chunk at the end when `stream_options.include_usage = true`).
  expect(() => new SseDecoder().feed(sse)).not.toThrow();
});
