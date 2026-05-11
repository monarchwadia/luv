// Item B: middleware suite tests.

import { test, expect } from "bun:test";
import {
  cache,
  fallbackChain,
  memoryStore,
  memoryTape,
  meter,
  rateLimit,
  record,
  replay,
  retry,
  trace,
} from "../../src/middleware/index.ts";
import { AuthError, RateLimitError, ServiceUnavailableError } from "../../src/errors.ts";
import type { Provider, ProviderSendOptions, Reply, Tool } from "../../src/types.ts";

const reply = (text: string, usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 }): Reply => ({
  message: { role: "assistant", text },
  stopReason: "end_turn",
  usage,
});

function counterProvider(): Provider & { calls: number } {
  const state = { calls: 0 };
  const p: Provider & { calls: number } = {
    async send() {
      state.calls++;
      return reply(`call ${state.calls}`);
    },
    sendStream() { throw new Error("not used"); },
    get calls() { return state.calls; },
  } as Provider & { calls: number };
  Object.defineProperty(p, "calls", { get: () => state.calls });
  return p;
}

function failNTimesProvider(failures: number, err: Error = new ServiceUnavailableError(503, "")): Provider & { calls: number } {
  const state = { calls: 0 };
  const p: Provider & { calls: number } = {
    async send() {
      state.calls++;
      if (state.calls <= failures) throw err;
      return reply(`ok after ${state.calls}`);
    },
    sendStream() { throw new Error("not used"); },
    get calls() { return state.calls; },
  } as Provider & { calls: number };
  Object.defineProperty(p, "calls", { get: () => state.calls });
  return p;
}

const req: ProviderSendOptions = {
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "hi" }],
};

// ---------------------------------------------------------------------------
// trace

test("trace: emits a span with timing on success", async () => {
  const provider = counterProvider();
  let span: import("../../src/middleware/trace.ts").Span | null = null;
  const traced = trace(provider, { onSpan: (s) => { span = s; } });
  await traced.send(req);
  expect(span).not.toBeNull();
  expect(span!.kind).toBe("send");
  expect(span!.ok).toBe(true);
  expect(span!.durationMs).toBeGreaterThanOrEqual(0);
  expect(span!.model).toBe("gpt-4o-mini");
});

test("trace: emits a span with error on failure", async () => {
  const failing: Provider = {
    async send() { throw new Error("boom"); },
    sendStream() { throw new Error("not used"); },
  };
  let span: import("../../src/middleware/trace.ts").Span | null = null;
  const traced = trace(failing, { onSpan: (s) => { span = s; } });
  await expect(traced.send(req)).rejects.toThrow("boom");
  expect(span).not.toBeNull();
  expect(span!.ok).toBe(false);
  expect(span!.error?.message).toBe("boom");
});

// ---------------------------------------------------------------------------
// meter

test("meter: accumulates token totals across calls", async () => {
  const provider: Provider = {
    async send() {
      return reply("x", { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    },
    sendStream() { throw new Error(""); },
  };
  const events: import("../../src/middleware/meter.ts").MeterEvent[] = [];
  const metered = meter(provider, { onUsage: (e) => events.push(e) });
  await metered.send(req);
  await metered.send(req);
  expect(events.length).toBe(2);
  expect(events[1]!.totals.calls).toBe(2);
  expect(events[1]!.totals.totalTokens).toBe(30);
  expect(events[0]!.usage?.promptTokens).toBe(10);
});

// ---------------------------------------------------------------------------
// retry

test("retry: retries on ServiceUnavailableError up to attempts", async () => {
  const provider = failNTimesProvider(2);
  const retried = retry(provider, { attempts: 3, baseDelayMs: 1 });
  const r = await retried.send(req);
  expect(r.message.role).toBe("assistant");
  expect(provider.calls).toBe(3);
});

test("retry: gives up after attempts and rethrows last error", async () => {
  const provider = failNTimesProvider(10);
  const retried = retry(provider, { attempts: 2, baseDelayMs: 1 });
  await expect(retried.send(req)).rejects.toBeInstanceOf(ServiceUnavailableError);
  expect(provider.calls).toBe(2);
});

test("retry: does not retry on AuthError", async () => {
  const provider = failNTimesProvider(10, new AuthError(401, ""));
  const retried = retry(provider, { attempts: 5, baseDelayMs: 1 });
  await expect(retried.send(req)).rejects.toBeInstanceOf(AuthError);
  expect(provider.calls).toBe(1);
});

test("retry: respects RateLimitError.retryAfterMs (capped by maxDelayMs)", async () => {
  let calls = 0;
  const p: Provider = {
    async send() {
      calls++;
      if (calls === 1) throw new RateLimitError(429, "", 5);
      return reply("ok");
    },
    sendStream() { throw new Error(""); },
  };
  const start = Date.now();
  await retry(p, { attempts: 2, baseDelayMs: 1000, maxDelayMs: 50 }).send(req);
  const dur = Date.now() - start;
  expect(dur).toBeLessThan(40);  // honored 5ms, not the 1000ms base
  expect(calls).toBe(2);
});

// ---------------------------------------------------------------------------
// rateLimit

test("rateLimit: spaces calls so they don't exceed RPS", async () => {
  const provider = counterProvider();
  const limited = rateLimit(provider, { rps: 100 }); // 10ms apart
  const start = Date.now();
  await Promise.all([limited.send(req), limited.send(req), limited.send(req)]);
  const dur = Date.now() - start;
  // Expect ~20ms minimum (3 slots, 10ms apart, first immediate).
  expect(dur).toBeGreaterThanOrEqual(15);
});

// ---------------------------------------------------------------------------
// cache

test("cache: identical request returns cached reply, provider called once", async () => {
  const provider = counterProvider();
  const cached = cache(provider);
  const r1 = await cached.send(req);
  const r2 = await cached.send(req);
  expect(provider.calls).toBe(1);
  expect(r2).toBe(r1);
});

test("cache: different conversation → cache miss, provider called twice", async () => {
  const provider = counterProvider();
  const cached = cache(provider);
  await cached.send(req);
  await cached.send({ ...req, conversation: [{ role: "user", text: "different" }] });
  expect(provider.calls).toBe(2);
});

test("memoryStore: enforces maxEntries cap (LRU)", () => {
  const store = memoryStore(2);
  store.set("a", reply("a"));
  store.set("b", reply("b"));
  store.set("c", reply("c"));
  expect(store.size).toBe(2);
  expect(store.get("a")).toBeUndefined();
  expect(store.get("b")).toBeDefined();
  expect(store.get("c")).toBeDefined();
});

// ---------------------------------------------------------------------------
// fallbackChain

test("fallbackChain: tries providers in order, advancing on error", async () => {
  const fail: Provider = {
    async send() { throw new Error("first failed"); },
    sendStream() { throw new Error(""); },
  };
  const ok = counterProvider();
  const chained = fallbackChain([fail, ok]);
  const r = await chained.send(req);
  expect(r.message.role).toBe("assistant");
  expect(ok.calls).toBe(1);
});

test("fallbackChain: throws the last error when all fail", async () => {
  const fail1: Provider = { async send() { throw new Error("a"); }, sendStream() { throw new Error(""); } };
  const fail2: Provider = { async send() { throw new Error("b"); }, sendStream() { throw new Error(""); } };
  await expect(fallbackChain([fail1, fail2]).send(req)).rejects.toThrow("b");
});

test("fallbackChain: throws when constructed with no providers", () => {
  expect(() => fallbackChain([])).toThrow();
});

// ---------------------------------------------------------------------------
// record + replay

test("record + replay: round-trip via memory tape", async () => {
  const provider = counterProvider();
  const tape = memoryTape();
  const recording = record(provider, { writer: tape });
  await recording.send(req);
  await recording.send({ ...req, conversation: [{ role: "user", text: "second" }] });
  expect(tape.read().length).toBe(2);
  expect(provider.calls).toBe(2);

  const replaying = replay({ reader: tape });
  const r = await replaying.send(req);
  if (r.message.role !== "assistant") throw new Error("expected assistant");
  expect(r.message.text).toBe("call 1");
  // Replay does not call the underlying provider:
  expect(provider.calls).toBe(2);
});

test("replay: throws when no tape entry matches the request", async () => {
  const tape = memoryTape();
  await expect(replay({ reader: tape }).send(req)).rejects.toThrow(/no tape entry/);
});

// ---------------------------------------------------------------------------
// Composition

test("middleware compose: retry(cache(meter(provider))) all work together", async () => {
  let calls = 0;
  const provider: Provider = {
    async send() {
      calls++;
      if (calls === 1) throw new ServiceUnavailableError(503, "");
      return reply("ok", { promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    },
    sendStream() { throw new Error(""); },
  };
  const events: import("../../src/middleware/meter.ts").MeterEvent[] = [];
  const composed = retry(
    cache(meter(provider, { onUsage: (e) => events.push(e) })),
    { attempts: 3, baseDelayMs: 1 },
  );
  // First call: provider fails, retried, succeeds. Cache stores result.
  await composed.send(req);
  // Second call: cached, provider not called again.
  await composed.send(req);
  expect(calls).toBe(2);  // 1 fail + 1 success, then cached
  expect(events.length).toBe(1);  // only one underlying success
  expect(events[0]!.totals.totalTokens).toBe(8);
});

// ---------------------------------------------------------------------------
// retry — additional backoff strategies and overrides

test("retry: 'fixed' backoff uses baseDelayMs every time", async () => {
  const provider = failNTimesProvider(3);
  const start = Date.now();
  await retry(provider, {
    attempts: 4,
    baseDelayMs: 20,
    backoff: "fixed",
  }).send(req);
  const dur = Date.now() - start;
  // 3 retries × 20ms = ~60ms (plus call latency)
  expect(dur).toBeGreaterThanOrEqual(50);
  expect(dur).toBeLessThan(200);
});

test("retry: 'linear' backoff grows linearly", async () => {
  const provider = failNTimesProvider(3);
  const start = Date.now();
  // baseDelayMs=10, attempts indices 0,1,2 → delays 10*(0+1)=10, 10*(1+1)=20, 10*(2+1)=30 = 60ms total
  await retry(provider, {
    attempts: 4,
    baseDelayMs: 10,
    backoff: "linear",
  }).send(req);
  const dur = Date.now() - start;
  expect(dur).toBeGreaterThanOrEqual(50);
  expect(dur).toBeLessThan(200);
});

test("retry: maxDelayMs caps the exponential growth", async () => {
  const provider = failNTimesProvider(5);
  const start = Date.now();
  // base=100ms, exponential: 100, 200, 400, 800, 1600 — but cap at 50ms each.
  await retry(provider, {
    attempts: 6,
    baseDelayMs: 100,
    backoff: "exponential",
    maxDelayMs: 50,
  }).send(req);
  const dur = Date.now() - start;
  // 5 retries × 50ms (cap) = 250ms-ish. Without cap would be 3100ms.
  expect(dur).toBeLessThan(500);
});

test("retry: shouldRetry override can force a non-default decision", async () => {
  // Tell retry to retry on AuthError (which it normally never does).
  const provider = failNTimesProvider(1, new AuthError(401, ""));
  const result = await retry(provider, {
    attempts: 3,
    baseDelayMs: 1,
    shouldRetry: (err) => err instanceof AuthError,
  }).send(req);
  expect(result.message.role).toBe("assistant");
  expect(provider.calls).toBe(2);
});

test("retry: shouldRetry returning false stops retries even on retryable errors", async () => {
  const provider = failNTimesProvider(10);  // would normally retry
  await expect(
    retry(provider, {
      attempts: 5,
      baseDelayMs: 1,
      shouldRetry: () => false,  // never retry
    }).send(req),
  ).rejects.toBeInstanceOf(ServiceUnavailableError);
  expect(provider.calls).toBe(1);
});

test("retry: HttpError with status 4xx (non-special) is not retried", async () => {
  const { HttpError } = await import("../../src/errors.ts");
  const provider = failNTimesProvider(10, new HttpError(418, "I'm a teapot"));
  await expect(
    retry(provider, { attempts: 3, baseDelayMs: 1 }).send(req),
  ).rejects.toBeInstanceOf(HttpError);
  expect(provider.calls).toBe(1);
});

test("retry: HttpError with status 5xx is retried", async () => {
  const { HttpError } = await import("../../src/errors.ts");
  const provider = failNTimesProvider(2, new HttpError(503, "down"));
  await retry(provider, { attempts: 3, baseDelayMs: 1 }).send(req);
  expect(provider.calls).toBe(3);
});

// ---------------------------------------------------------------------------
// cache — key sensitivity

test("cache: different model is a cache miss", async () => {
  const provider = counterProvider();
  const cached = cache(provider);
  await cached.send(req);
  await cached.send({ ...req, model: "different-model" });
  expect(provider.calls).toBe(2);
});

test("cache: different maxTokens is a cache miss", async () => {
  const provider = counterProvider();
  const cached = cache(provider);
  await cached.send({ ...req, maxTokens: 100 });
  await cached.send({ ...req, maxTokens: 200 });
  expect(provider.calls).toBe(2);
});

test("cache: different temperature is a cache miss", async () => {
  const provider = counterProvider();
  const cached = cache(provider);
  await cached.send({ ...req, temperature: 0 });
  await cached.send({ ...req, temperature: 0.7 });
  expect(provider.calls).toBe(2);
});

test("cache: different tools array is a cache miss", async () => {
  const tool: Tool = {
    name: "x", description: "", inputSchema: {}, handler: async () => ({ ok: true, content: "" }),
  };
  const tool2: Tool = { ...tool, name: "y" };
  const provider = counterProvider();
  const cached = cache(provider);
  await cached.send({ ...req, tools: [tool] });
  await cached.send({ ...req, tools: [tool2] });
  expect(provider.calls).toBe(2);
});

test("cache: custom keyFn controls what's considered identical", async () => {
  const provider = counterProvider();
  // keyFn ignores conversation entirely — every call hits the cache.
  const cached = cache(provider, { keyFn: (r) => r.model });
  await cached.send(req);
  await cached.send({ ...req, conversation: [{ role: "user", text: "totally different" }] });
  expect(provider.calls).toBe(1);
});

// ---------------------------------------------------------------------------
// fallbackChain — shouldAdvance override

test("fallbackChain: shouldAdvance returning false stops the chain on that error", async () => {
  const a: Provider = { async send() { throw new AuthError(401, ""); }, sendStream() { throw new Error(""); } };
  const b: Provider = { async send() { throw new ServiceUnavailableError(503, ""); }, sendStream() { throw new Error(""); } };
  // Refuse to advance past auth errors — surface them immediately.
  const chained = fallbackChain([a, b], {
    shouldAdvance: (err) => !(err instanceof AuthError),
  });
  await expect(chained.send(req)).rejects.toBeInstanceOf(AuthError);
});

// ---------------------------------------------------------------------------
// meter — failed calls don't accumulate; missing usage doesn't crash

test("meter: failed send call does NOT fire onUsage", async () => {
  const provider: Provider = {
    async send() { throw new Error("boom"); },
    sendStream() { throw new Error(""); },
  };
  const events: import("../../src/middleware/meter.ts").MeterEvent[] = [];
  await expect(
    meter(provider, { onUsage: (e) => events.push(e) }).send(req),
  ).rejects.toThrow("boom");
  expect(events.length).toBe(0);
});

test("meter: reply with no usage still increments call count, totals stay zero", async () => {
  const provider: Provider = {
    async send() {
      // Simulate provider that didn't report usage
      return { message: { role: "assistant", text: "x" }, stopReason: "end_turn" };
    },
    sendStream() { throw new Error(""); },
  };
  const events: import("../../src/middleware/meter.ts").MeterEvent[] = [];
  await meter(provider, { onUsage: (e) => events.push(e) }).send(req);
  expect(events[0]?.usage).toBeUndefined();
  expect(events[0]?.totals.calls).toBe(1);
  expect(events[0]?.totals.totalTokens).toBe(0);
});

// ---------------------------------------------------------------------------
// memoryStore — explicit delete

test("memoryStore: delete removes the entry", () => {
  const store = memoryStore(10);
  store.set("k", reply("x"));
  expect(store.get("k")).toBeDefined();
  expect(store.delete("k")).toBe(true);
  expect(store.get("k")).toBeUndefined();
  expect(store.delete("k")).toBe(false);
});

// ---------------------------------------------------------------------------
// trace — sendStream coverage

test("trace: emits a sendStream span when the stream completes", async () => {
  const provider: Provider = {
    async send() { throw new Error(""); },
    sendStream() {
      const stream: import("../../src/types.ts").LuvStream = {
        async *[Symbol.asyncIterator]() {},
        cancel() {},
        get aborted() { return false; },
        done: Promise.resolve(reply("done")),
        text(): AsyncIterable<string> {
          return { async *[Symbol.asyncIterator]() {} };
        },
      };
      return stream;
    },
  };
  const spans: import("../../src/middleware/trace.ts").Span[] = [];
  const traced = trace(provider, { onSpan: (s) => spans.push(s) });
  const stream = traced.sendStream({ model: "x", conversation: [{ role: "user", text: "x" }] });
  await stream.done;
  // Wait one microtask for span to land
  await new Promise((r) => setTimeout(r, 5));
  expect(spans.length).toBe(1);
  expect(spans[0]?.kind).toBe("sendStream");
  expect(spans[0]?.ok).toBe(true);
});
