---
title: Tool helpers
description: tool() and parseArguments — type-safe tool definitions.
---

## `tool()`

Build a typed luv `Tool` from an inline JSON Schema.

```ts
import { tool } from "luv-js";

const t = tool({
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
    // units: "c" | "f" | undefined  (optional, narrowed)
    return { ok: true, content: await fetchWeather(city, units ?? "c") };
  },
});
```

**Important:** `inputSchema` MUST be passed as an inline literal in the
`tool()` call. Pulling it into a `const` outside the call widens the type
and inference is lost.

## `parseArguments()`

Runtime-check + type-assert a `ToolCall.arguments` against a JSON Schema.
Useful when iterating over a stored conversation:

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
      const { city } = parseArguments(call, schema);  // typed { city: string }
    }
  }
}
```

Throws `ToolArgsError` if the runtime value doesn't match the schema
(missing required field, wrong type, etc.).

Without a schema, returns `call.arguments` cast to your generic `T`:

```ts
const { city } = parseArguments<{ city: string }>(call);
```

## Schema → TS type inference

Both `tool()` and `parseArguments()` use `InferSchema<S>` to derive
TypeScript types from a JSON Schema literal:

- `{ type: "string" }` → `string`
- `{ type: "number" | "integer" }` → `number`
- `{ type: "boolean" }` → `boolean`
- `{ type: "array", items: ... }` → `T[]`
- `{ type: "object", properties: { ... }, required: [...] }` → typed object
  with required/optional split
- `{ enum: [...] as const }` → literal union
- `{ const: T as const }` → literal value

Constructs not yet supported: `oneOf`, `anyOf`, `allOf`, `not`, `if/then/else`,
JSON Schema `$ref`, format constraints.
