# Migrating from Vercel AI SDK to luv-js

Side-by-side patterns. Most things translate one-to-one; the differences
are explained where they matter.

## Setup

```typescript
// Vercel AI SDK
import { openai } from "@ai-sdk/openai";

// luv-js
import { createClient } from "luv-js";
const luv = createClient({ apiKey: process.env.OPENAI_API_KEY! });
```

In Vercel AI SDK, the API key is read from `OPENAI_API_KEY` automatically by
the provider. In luv-js you pass it explicitly to `createClient` (or to each
call if you don't use the wrapper). This is deliberate — luv-js never reaches
into env vars on its own.

## One-shot text completion

```typescript
// Vercel AI SDK
import { generateText } from "ai";

const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "say hi",
});
```

```typescript
// luv-js
const reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "say hi" }],
});
const text = reply.message.role === "assistant" ? reply.message.text : "";
```

luv-js requires the conversation array even for one-shot calls (the `Message[]`
shape is the universal API). The narrowing on `reply.message.role` is required
because `Message` is a discriminated union.

## Streaming

```typescript
// Vercel AI SDK
import { streamText } from "ai";

const { textStream } = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "count to five",
});
for await (const chunk of textStream) process.stdout.write(chunk);
```

```typescript
// luv-js
const stream = luv.sendStream({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "count to five" }],
});
for await (const chunk of stream.text()) process.stdout.write(chunk);
```

`stream.text()` mirrors Vercel's `textStream`. luv-js's `LuvStream` also
exposes `.cancel()`, `.aborted`, `.done` (resolves with the assembled `Reply`),
and full event iteration via `for await (const event of stream)`.

## Structured output

```typescript
// Vercel AI SDK
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: openai("gpt-4o-mini"),
  schema: z.object({
    name: z.string(),
    ingredients: z.array(z.string()),
  }),
  prompt: "give me a recipe",
});
```

```typescript
// luv-js
const result = await luv.generateObject({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "give me a recipe" }],
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      ingredients: { type: "array", items: { type: "string" } },
    },
    required: ["name", "ingredients"],
  },
});
const object = result.object;  // typed: { name: string; ingredients: string[] }
```

Vercel uses zod (~30KB dep). luv-js uses a JSON Schema literal — same type
inference quality (`object.name` is `string`), zero runtime deps. luv-js
auto-injects `additionalProperties: false` deeply so OpenAI's strict mode
doesn't complain.

## Tool calling

```typescript
// Vercel AI SDK
import { generateText, tool } from "ai";
import { z } from "zod";

await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "what's 17 * 23?",
  tools: {
    calc: tool({
      description: "evaluates an arithmetic expression",
      parameters: z.object({ expr: z.string() }),
      execute: async ({ expr }) => String(eval(expr)),
    }),
  },
  maxSteps: 5,
});
```

```typescript
// luv-js
import { tool } from "luv-js";

const calc = tool({
  name: "calc",
  description: "evaluates an arithmetic expression",
  inputSchema: {
    type: "object",
    properties: { expr: { type: "string" } },
    required: ["expr"],
  },
  handler: async ({ expr }) => ({ ok: true, content: String(eval(expr)) }),
});

await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "what's 17 * 23?" }],
  tools: [calc],
  maxIterations: 5,
});
```

Differences:
- luv-js tool `handler` returns `{ ok: true, content }` or `{ ok: false, error }`
  instead of just returning a value or throwing. Errors propagate to the
  model as ok=false results rather than exceptions.
- `tools` is an array, not an object — order is irrelevant either way.
- `maxIterations` instead of `maxSteps`.

## Cancellation

```typescript
// Vercel AI SDK
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "x",
  abortSignal: ctl.signal,
});

// luv-js — same standard AbortSignal
const reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "x" }],
  signal: ctl.signal,
});
```

Same shape; luv-js calls the property `signal` (matching `fetch`) instead
of `abortSignal`.

## Error handling

```typescript
// Vercel AI SDK — errors are mostly raw / SDK-specific
try {
  await generateText({ model: openai("gpt-4o"), prompt: "x" });
} catch (err) {
  if (err.statusCode === 429) /* retry */;
}
```

```typescript
// luv-js — typed error subclasses with .hint
import { RateLimitError, AuthError, ContextWindowExceededError } from "luv-js";

try {
  await luv.send({ model: "gpt-4o-mini", conversation });
} catch (err) {
  if (err instanceof RateLimitError) {
    await sleep(err.retryAfterMs ?? 1000);
  } else if (err instanceof AuthError) {
    // bad / missing key
  } else if (err instanceof ContextWindowExceededError) {
    // trim + retry
  }
}
```

Or use `instanceof` against `luv.RateLimitError` etc. without importing.
Each error has a `.hint` field (recovery suggestion text).

## Switching providers

```typescript
// Vercel AI SDK — change the `model` argument
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

await generateText({ model: openai("gpt-4o-mini"), prompt: "x" });
await generateText({ model: anthropic("claude-3-5-sonnet"), prompt: "x" });
```

```typescript
// luv-js — pick a different provider factory; same conversation array works on both
import { openaiProvider, anthropicProvider, runAgent } from "luv-js";

const openai = openaiProvider({ apiKey: OAI_KEY });
const anthropic = anthropicProvider({ apiKey: ANT_KEY });

const conv = [{ role: "user", text: "x" } as const];
await runAgent({ provider: openai, model: "gpt-4o-mini", conversation: conv });
await runAgent({ provider: anthropic, model: "claude-3-5-sonnet-20241022", conversation: conv });
```

luv-js's `Provider` is just a `{send, sendStream}` object. You can wrap it
in middleware (retry, cache, fallback) which Vercel AI SDK doesn't expose
as composable primitives.

## Provider middleware (no Vercel equivalent)

```typescript
// luv-js only
import { retry, cache, meter, rateLimit, fallbackChain } from "luv-js/middleware";

const provider = retry(
  rateLimit(
    cache(
      meter(openai, { onUsage: (e) => log(e) }),
    ),
    { rps: 10 },
  ),
  { attempts: 3, baseDelayMs: 500 },
);
```

Each middleware wraps a `Provider` and returns a `Provider`. Compose freely.
No equivalent in Vercel AI SDK — middleware is per-feature and not
composable.

## Recording / replaying for tests (no Vercel equivalent)

```typescript
// In dev — capture everything to a tape
import { record, memoryTape } from "luv-js/middleware";

const tape = memoryTape();
const dev = record(openaiProvider({ apiKey }), { writer: tape });
await runAgent({ provider: dev, ... });
fs.writeFileSync("./tape.json", JSON.stringify(tape.read()));

// In tests — no API key, deterministic
import { replay } from "luv-js/middleware";

const entries = JSON.parse(fs.readFileSync("./tape.json", "utf8"));
const test = replay({ reader: { read: () => entries } });
const result = await runAgent({ provider: test, ... });
expect(result.conversation).toEqual(...);
```

## React hooks

luv-js doesn't ship React hooks today (TODO; the `liveAgent` +
`useLuvConversation` story is on the roadmap). Vercel AI SDK has
`useChat` / `useCompletion` / `useObject`. Until luv-js's hooks ship, write
your own thin React state binding around `for await (const text of
stream.text())` — usually 30 lines.

## What's missing in luv-js (today)

- **Image / audio inputs.** Vercel AI SDK has multi-modal content;
  luv-js is text-only.
- **Embeddings.** Use Vercel AI SDK or the OpenAI SDK directly.
- **Image generation.** Same.
- **Provider count.** Vercel covers ~20+ providers (Bedrock, Vertex,
  Mistral, Groq, Cohere, etc.); luv-js has OpenAI + Anthropic. For
  OpenAI-compatible APIs (Ollama, vLLM, Together, Groq, OpenRouter) point
  `openaiProvider({ baseUrl: "..." })` at their endpoint — works without
  any custom code.
- **Provider SDK ecosystem.** Vercel has a huge community of integrations.

If your app needs any of the above, use Vercel AI SDK. If you need any
combination of (zero deps, tiny bundle, composable middleware,
recording/replay, cross-provider conversation portability), luv-js is the
better fit.
