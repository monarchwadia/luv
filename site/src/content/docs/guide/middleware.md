---
title: Provider middleware
description: Composable wrappers for retry, cache, rate limiting, recording, and more.
---

Every middleware in `luv-js/middleware` takes a `Provider` and returns a
`Provider`. Compose them however you want.

```ts
import { retry, cache, rateLimit, meter, trace } from "luv-js/middleware";

const provider = retry(
  rateLimit(
    cache(
      meter(trace(rawProvider, { onSpan: log })),
    ),
    { rps: 10 },
  ),
  { attempts: 3, baseDelayMs: 500 },
);

await runAgent({ provider, ... });
```

## Available middleware

### `retry(provider, opts)`

Retries failed `send` calls with exponential backoff. Honors
`RateLimitError.retryAfterMs`. Skips known-non-retryable errors
(`AuthError`, `ContextWindowExceededError`, `ContentFilterError`).

```ts
retry(provider, {
  attempts: 3,
  baseDelayMs: 500,
  backoff: "exponential" | "linear" | "fixed",
  maxDelayMs: 30_000,
  shouldRetry: (err, attempt) => boolean,  // optional override
});
```

### `cache(provider, opts)`

Memoizes identical `send` requests by `(model, conversation, tools)` shape.

```ts
import { cache, memoryStore } from "luv-js/middleware";

cache(provider, {
  maxEntries: 100,                            // default 100
  // store: customCacheStore,                 // bring your own
  // keyFn: (req) => `${req.model}:${...}`,   // bring your own key
});
```

### `rateLimit(provider, opts)`

Throttles outgoing calls to at most N per second (sliding window).

```ts
rateLimit(provider, { rps: 10 });
```

### `meter(provider, opts)`

Counts calls + tokens. Fires `onUsage` after every successful call.

```ts
meter(provider, {
  onUsage: (event) => {
    // event.kind, event.usage, event.totals.{calls, totalTokens, ...}
  },
});
```

### `trace(provider, opts)`

Emits a `Span` after every call (success or failure) with timing + status.

```ts
trace(provider, {
  onSpan: (span) => {
    // span.kind, span.model, span.durationMs, span.ok, span.error?
  },
});
```

### `record(provider, opts)` + `replay(opts)`

Capture every (request, reply) to a tape, replay it later. Makes
integration tests deterministic without needing API keys.

```ts
import { record, replay, memoryTape } from "luv-js/middleware";

// In dev — capture
const tape = memoryTape();
const dev = record(rawProvider, { writer: tape });
await runAgent({ provider: dev, ... });
await Bun.write("./tape.json", JSON.stringify(tape.read()));

// In tests — replay
const entries = JSON.parse(await Bun.file("./tape.json").text());
const test = replay({ reader: { read: () => entries } });
const result = await runAgent({ provider: test, ... });
```

### `fallbackChain(providers)`

Try providers in order, advancing on error.

```ts
import { fallbackChain } from "luv-js/middleware";

fallbackChain([primary, secondary, tertiary]);
```

## When to apply which

Order matters. Conventional outermost-first stack:

```
retry(            ← retry around everything else
  rateLimit(      ← throttle the original (and retry'd) calls
    cache(        ← cache results so retries hit cache
      meter(      ← count what actually went out
        trace(    ← span every call
          provider
        )
      )
    )
  )
)
```

Pick what your app actually needs; don't compose blindly.
