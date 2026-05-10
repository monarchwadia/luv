---
title: createClient
description: Bundle credentials with send / sendStream / runAgent / generateObject.
---

```ts
import { createClient } from "luv-js";

const luv = createClient({
  apiKey: string,
  baseUrl?: string,   // default "https://api.openai.com"
});
```

The returned `LuvClient` has methods that take per-call options without
re-passing credentials:

- `luv.send(opts)`
- `luv.sendStream(opts)`
- `luv.runAgent(opts)`
- `luv.generateObject(opts)`
- `luv.provider` — the underlying `Provider` (pass to anything that takes a Provider)
- `luv.HttpError`, `luv.AuthError`, `luv.RateLimitError`, etc. — error
  classes re-exposed for ergonomic `instanceof` use

## When to use createClient vs the bare functions

| Need | Use |
|---|---|
| One round-trip; no streaming, no tool loop | `send` |
| Incremental text deltas | `sendStream` |
| Multi-turn loop where the model calls tools | `runAgent` |
| Many calls with the same key — bundle them | `createClient` |

If you're making more than one call with the same credentials, prefer
`createClient`. It's a thin wrapper — no extra cost.
