---
title: Agents and tools
description: Multi-turn loops where the model calls tools and acts on the results.
---

luv-js gives you two ways to drive an agent loop:

- **`runAgent`** — the loop runs to completion and returns the final conversation.
- **`agentStep`** — a single iteration. You drive the loop yourself, optionally
  inspecting / mutating the conversation between turns.

Both operate on the same `Message[]` array. There's no "agent" object that
holds state between turns.

## Defining a tool

`tool()` takes a JSON Schema literal. The handler's `args` are typed from the
schema — no zod, no separate type declarations.

```ts
import { tool } from "luv-js";

const lookupWeather = tool({
  name: "lookup_weather",
  description: "Returns current weather for a city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string", enum: ["c", "f"] },
    },
    required: ["city"],
  },
  handler: async ({ city, units }) => {
    // city: string  (required)
    // units: "c" | "f" | undefined  (optional, narrowed to literal union)
    return { ok: true, content: await fetchWeather(city, units ?? "c") };
  },
});
```

Returning `{ ok: false, error: "..." }` surfaces the failure as a tool-result
message the model can react to. Throwing from a handler is also caught and
converted to `{ ok: false, error: <message> }`.

## runAgent

```ts
const result = await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "What's the weather in Tokyo?" }],
  tools: [lookupWeather],
  maxIterations: 10,           // safety cap
  // hooks for observation:
  onTurnStart:  (i) => console.log("turn", i),
  onToolCall:   (c) => console.log("→", c.name, c.arguments),
  onToolResult: (_, r) => console.log("←", r.ok ? r.content : r.error),
});

result.conversation;  // every message, including assistant + tool messages
result.reason;        // "end_turn" | "max_iterations" | "aborted" | "error"
result.iterations;    // how many round-trips happened
result.error?;        // set when reason === "error"
```

## agentStep — manual loop control

When you want to inspect, approve, or modify between turns:

```ts
import { agentStep } from "luv-js";

let conv = [{ role: "user", text: "do the thing" }];
while (true) {
  const step = await agentStep({
    provider: luv.provider,
    model: "gpt-4o-mini",
    conversation: conv,
    tools: [...],
  });
  conv.push(...step.newMessages);

  // Inspect/intervene before the next iteration:
  const last = step.newMessages[step.newMessages.length - 1];
  if (last?.role === "tool" && /* something risky */) {
    if (!await confirm("continue?")) break;
  }
  if (step.done) break;
}
```

## Cancellation

Both `runAgent` and `agentStep` accept a standard `AbortSignal`:

```ts
const ctl = new AbortController();
button.onclick = () => ctl.abort();

const result = await luv.runAgent({
  ..., signal: ctl.signal,
});
// result.reason === "aborted" if cancelled
```

Inside a tool handler, the same signal is on `ctx.signal`:

```ts
const fetchTool = tool({
  ...,
  handler: async (args, ctx) => {
    const res = await fetch(url, { signal: ctx.signal });
    return { ok: true, content: await res.text() };
  },
});
```

## Inspecting tool calls in a stored conversation

If you load a previous conversation from disk, the assistant's `toolCalls`
have `arguments: unknown`. Use `parseArguments` to runtime-check + type-cast:

```ts
import { parseArguments } from "luv-js";

const schema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

for (const m of conv) {
  if (m.role === "assistant" && m.toolCalls) {
    for (const call of m.toolCalls) {
      if (call.name === "lookup_weather") {
        const { city } = parseArguments(call, schema);  // typed { city: string }
        console.log("looked up:", city);
      }
    }
  }
}
```
