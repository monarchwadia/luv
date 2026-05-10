---
title: What is luv?
description: A small, opinionated framework for talking to LLMs from JavaScript.
---

luv-js is a small library for calling LLM chat APIs and building agent loops
on top of them. It's built around a single idea:

> **The conversation is just a plain array of plain objects.**

You can inspect it, mutate it, save it as JSON, restore it, swap providers
mid-conversation, fork it, splice it. Every operation in luv — `send`,
`sendStream`, `runAgent`, `generateObject` — is a pure function from arrays
to arrays.

```ts
let conv: Message[] = [
  { role: "system", text: "be terse" },
  { role: "user", text: "hello" },
];

const reply = await luv.send({ model, conversation: conv });
conv.push(reply.message);

// conv is just a JS array. Persist it, fork it, redact it,
// hand it to a different provider — it's data.
```

## Why this design

Most LLM frameworks own conversation state. They give you an `Agent` object,
a `Conversation` class, a `Run` handle. To inspect or modify what's
happening you have to call methods, navigate framework objects, parse logs.

luv-js inverts that. The framework owns nothing. Your code owns the array.
The library is a set of pure functions you call against it. This makes a few
things straightforward that are awkward elsewhere:

- **Persistence.** `JSON.stringify(conversation)` works.
- **Replay.** Load an array, pass it to `runAgent`, watch it produce the same
  next turn.
- **Branching.** `[...conv]` gives you a fork. Try a different system prompt
  in one branch, compare results.
- **Cross-provider portability.** The same `Message[]` works across any
  provider luv-js supports. Switching providers mid-conversation is a one-line
  change.
- **Composable middleware.** Provider is a tiny vtable. Wrap it in `retry`,
  `cache`, `record`, `meter` — assemble your own LLM stack.

## What's in the package

- `send` / `sendStream` — non-streaming + streaming chat completions.
- `runAgent` / `agentStep` — multi-turn agent loops with tool execution.
- `generateObject` — typed structured output (no zod needed).
- `tool()` — type-safe tool definitions from inline JSON Schema.
- `createClient` — bundles credentials and the per-call helpers.
- Provider factories: `openaiProvider`, `anthropicProvider`.
- `luv-js/middleware` — composable Provider wrappers.
- `luv-js/mcp` — Model Context Protocol client.

## Compatibility

- **Bun** 1.0+
- **Node** 20+ (uses native fetch, WebAssembly, TextEncoder, AbortController)
- **Deno** — works via standard web APIs
- **Browsers** — bundles cleanly via Bun, esbuild, Vite, Webpack, Rollup

The browser cannot reach `api.openai.com` or `api.anthropic.com` directly
(CORS); use a server-side proxy and point `baseUrl` at it.

## Versions

luv-js is **0.x** today. The architecture and shapes documented here are
stable. Surface APIs may still evolve modestly before 1.0.
