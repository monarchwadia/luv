---
title: Middleware
description: Provider → Provider wrappers in luv-js/middleware.
---

import from `luv-js/middleware`. See the [middleware guide](/guide/middleware/)
for usage patterns.

## `retry(provider, opts?)`

Retries failed `send` calls with backoff. Honors `RateLimitError.retryAfterMs`.

```ts
retry(provider, {
  attempts?: number,                        // default 3
  baseDelayMs?: number,                     // default 500
  backoff?: "exponential" | "linear" | "fixed",  // default "exponential"
  maxDelayMs?: number,                      // default 30_000
  shouldRetry?: (err, attempt) => boolean,  // optional
});
```

## `cache(provider, opts?)`

Memoize identical `send` calls.

```ts
cache(provider, {
  store?: CacheStore,
  maxEntries?: number,                       // default 100
  keyFn?: (req) => string,
});

// Bring-your-own store interface:
interface CacheStore {
  get(key: string): Reply | undefined;
  set(key: string, value: Reply): void;
  delete(key: string): boolean;
  size: number;
}
```

## `rateLimit(provider, opts)`

Throttle calls to at most `rps` per second.

```ts
rateLimit(provider, { rps: 10 });
```

## `meter(provider, opts)`

Count calls + tokens; fire `onUsage` after each successful call.

```ts
meter(provider, {
  onUsage: (event: MeterEvent) => void,
});

// MeterEvent shape:
{
  model: string,
  kind: "send" | "sendStream",
  usage: Usage | undefined,
  totals: { calls, promptTokens, completionTokens, totalTokens },
}
```

## `trace(provider, opts)`

Emit a `Span` after each call.

```ts
trace(provider, {
  onSpan: (span: Span) => void,
});

// Span shape:
{
  kind: "send" | "sendStream",
  model: string,
  conversationLength: number,
  durationMs: number,
  ok: boolean,
  error?: Error,
}
```

## `record(provider, opts)` and `replay(opts)`

Capture a real session to a tape; replay it deterministically in tests.

```ts
record(provider, { writer: TapeWriter });
replay({ reader: TapeReader, match?: (req, candidates) => TapeEntry | undefined });
```

`memoryTape()` returns an in-memory `TapeWriter & TapeReader`.

## `fallbackChain(providers, opts?)`

Try providers in order, advancing on error.

```ts
fallbackChain([primary, secondary, tertiary], {
  shouldAdvance?: (err) => boolean,
});
```
