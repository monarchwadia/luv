import { test, expect } from "bun:test";
import { sendStream } from "../src/send_stream.ts";
import type { Event } from "../src/types.ts";

const FIXTURE_011 = "/workspaces/luv/core/fixtures/openai/011_stream_basic/response.sse.txt";

async function loadFixture(path: string): Promise<Uint8Array> {
  const data = await Bun.file(path).arrayBuffer();
  return new Uint8Array(data);
}

interface MockFetchOptions {
  status?: number;
  chunkSize?: number;
  capture?: { value: { url: string; headers: Headers; body: Uint8Array } | null };
}

function makeMockSseFetch(body: Uint8Array, opts: MockFetchOptions = {}): typeof fetch {
  const { status = 200, chunkSize = 64, capture } = opts;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let bodyBytes: Uint8Array;
    if (init?.body instanceof Uint8Array) bodyBytes = init.body;
    else bodyBytes = new Uint8Array();
    if (capture) {
      capture.value = { url, headers: new Headers(init?.headers), body: bodyBytes };
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < body.length; i += chunkSize) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          controller.enqueue(body.slice(i, Math.min(i + chunkSize, body.length)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status });
  };
}

test("sendStream: iterator yields start + text deltas + stop end_turn", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const stream = sendStream(
    {
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "Count to 5" }],
    },
    { fetch: makeMockSseFetch(fixture) },
  );

  const events: Event[] = [];
  for await (const e of stream) events.push(e);

  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events[0]!.type).toBe("start");
  if (events[0]!.type === "start") expect(events[0]!.role).toBe("assistant");

  const last = events[events.length - 1]!;
  expect(last.type).toBe("stop");
  if (last.type === "stop") expect(last.stopReason).toBe("end_turn");

  const concatenated = events
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta)
    .join("");
  expect(concatenated).toBe("1, 2, 3, 4, 5");
});

test("sendStream: .done resolves with assembled Reply", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const stream = sendStream(
    {
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
    },
    { fetch: makeMockSseFetch(fixture) },
  );

  const reply = await stream.done;
  expect(reply.message.role).toBe("assistant");
  expect(reply.message.text).toBe("1, 2, 3, 4, 5");
  expect(reply.stopReason).toBe("end_turn");
});

test("sendStream: hooks fire for start, each delta, and stop", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const deltas: string[] = [];
  let startCount = 0;
  let stopReason: string | null = null;

  const stream = sendStream(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
      onStart: () => startCount++,
      onDelta: (d) => deltas.push(d),
      onStop: (r) => (stopReason = r),
    },
    { fetch: makeMockSseFetch(fixture) },
  );

  await stream.done;
  expect(startCount).toBe(1);
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.join("")).toBe("1, 2, 3, 4, 5");
  expect(stopReason).toBe("end_turn");
});

test("sendStream: outgoing request has stream=true and Accept: text/event-stream", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const captured: { value: { url: string; headers: Headers; body: Uint8Array } | null } = { value: null };

  const stream = sendStream(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
    },
    { fetch: makeMockSseFetch(fixture, { capture: captured }) },
  );
  await stream.done;

  expect(captured.value).toBeDefined();
  expect(captured.value!.headers.get("Accept")).toBe("text/event-stream");
  // Body is the openai wire JSON built by wasm — verify stream flag made it through.
  const wireJson = new TextDecoder().decode(captured.value!.body);
  expect(wireJson).toContain('"stream":true');
});

test("sendStream: cancel() aborts the iterator without throwing", async () => {
  const fixture = await loadFixture(FIXTURE_011);
  const stream = sendStream(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "x" }],
    },
    // tiny chunk size so cancel can land between chunks
    { fetch: makeMockSseFetch(fixture, { chunkSize: 8 }) },
  );

  let count = 0;
  for await (const _ of stream) {
    count++;
    if (count === 1) stream.cancel();
  }
  expect(stream.aborted).toBe(true);
  expect(count).toBeGreaterThanOrEqual(1);
});
