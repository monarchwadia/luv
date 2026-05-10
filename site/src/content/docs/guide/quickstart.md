---
title: Quickstart
description: From `bun add` to a working chat completion in 60 seconds.
---

## Install

```bash
bun add luv-js
# or: npm install luv-js
```

luv-js has zero runtime dependencies. The published package is a single ESM
bundle (~14 KB minified) plus type declarations.

## Authenticate

```bash
export OPENAI_API_KEY=sk-...
```

## Your first call

```ts
import { createClient } from "luv-js";

const luv = createClient({ apiKey: process.env.OPENAI_API_KEY! });

const reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "Say hi in three words." }],
});

console.log(reply.message.role === "assistant" ? reply.message.text : "");
```

`reply.message` is a [discriminated union](/api/core/) — narrow on `role`
to access `text`. (TypeScript will catch the missing narrow.)

## Stream

```ts
for await (const text of luv.sendStream({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "Count to five." }],
}).text()) {
  process.stdout.write(text);
}
```

`stream.text()` yields just the text deltas. To consume every event
(`start | text | stop`), iterate the stream itself instead of `.text()`.

## Use a tool

```ts
import { tool } from "luv-js";

const calc = tool({
  name: "calc",
  description: "Evaluates an arithmetic expression.",
  inputSchema: {
    type: "object",
    properties: { expr: { type: "string" } },
    required: ["expr"],
  },
  handler: async ({ expr }) => ({
    ok: true,
    content: String(Function(`return (${expr})`)()),
  }),
});

const result = await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "What's 17 * 23?" }],
  tools: [calc],
});

console.log(result.conversation);  // includes user, tool_call, tool_result, final assistant
```

## Get typed JSON back

```ts
const { object } = await luv.generateObject({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "Give me a pancake recipe." }],
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      ingredients: { type: "array", items: { type: "string" } },
    },
    required: ["name", "ingredients"],
  },
});

// object.name is typed string; object.ingredients is typed string[]
```

## Next steps

- [Why luv?](/guide/why-luv/) — when to pick luv over Vercel AI SDK
- [Agents and tools](/guide/agents/) — multi-turn loops
- [Provider middleware](/guide/middleware/) — retry, cache, recording, etc.
- [Migrating from Vercel AI SDK](/guide/migrate-from-vercel/) — side-by-side
