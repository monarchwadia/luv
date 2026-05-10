---
title: Errors
description: Error class hierarchy + classifyError mapper.
---

All upstream HTTP failures throw a subclass of `HttpError`. Use `instanceof`
to discriminate.

## Hierarchy

```
HttpError
├── AuthError                       (401, 403)
├── RateLimitError                  (429; carries .retryAfterMs)
├── ContextWindowExceededError      (400 + code: "context_length_exceeded")
├── ContentFilterError              (400 + type: "content_filter_error")
└── ServiceUnavailableError         (5xx)
```

Each subclass has:

- `.status: number` — HTTP status
- `.body: string` — full response body (truncated only in `.message`, not here)
- `.message: string` — `"luv-js: HTTP <status> (<label>): <body…>"`, body truncated
- `.hint: string` — human/LLM-actionable recovery suggestion
- (RateLimitError only) `.retryAfterMs: number | undefined` — parsed from
  `Retry-After` header

## Example: handling errors

```ts
import {
  HttpError, AuthError, RateLimitError,
  ContextWindowExceededError, ContentFilterError, ServiceUnavailableError,
} from "luv-js";

try {
  await luv.send({ model, conversation });
} catch (err) {
  if (err instanceof RateLimitError) {
    await sleep(err.retryAfterMs ?? 1000);
    // retry
  } else if (err instanceof ContextWindowExceededError) {
    // trim or summarize the conversation, then retry
  } else if (err instanceof AuthError) {
    // bad / missing key
  } else if (err instanceof ContentFilterError) {
    // surface to user
  } else if (err instanceof HttpError) {
    // unknown HTTP error — log err.status + err.body
  } else {
    throw err;
  }
}
```

For ergonomic catching without imports, the same classes are exposed on
`createClient`:

```ts
const luv = createClient({ apiKey });
try {
  await luv.send({...});
} catch (err) {
  if (err instanceof luv.RateLimitError) { ... }
}
```

## `classifyError(status, body, retryAfterHeader)`

Map an HTTP failure into the most-specific subclass. Used internally by
`send` / `sendStream`; exposed for custom transport code that wants the
same classification.

```ts
import { classifyError } from "luv-js";

const err = classifyError(429, body, "30");
err instanceof RateLimitError;  // true
err.retryAfterMs;               // 30000
```

## `MorphismError`

Thrown by the Anthropic morphism when wire data is malformed (e.g.
`tool_use` block missing `id` or `name`). Subclass of `Error`.

## `GenerateObjectError`

Thrown by `generateObject` when the model returns invalid JSON or the
result doesn't match the schema. Subclass of `Error`.

## `ToolArgsError`

Thrown by `parseArguments` when a value doesn't match the supplied schema.
Has a `.path` field naming the failing JSON path (e.g. `"profile.name"`).

## `WasmCallError` / etc.

Pre-pure-TS artifacts. Removed in 0.2+ — should not appear in current code.
