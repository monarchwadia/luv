---
title: Structured output
description: Get typed JSON from the model with generateObject.
---

`generateObject` returns a typed JS object that conforms to a JSON Schema.
Sets OpenAI's `response_format: json_schema` with `strict: true` so the
provider guarantees valid JSON.

```ts
const result = await luv.generateObject({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "Give me a pancake recipe." }],
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      ingredients: { type: "array", items: { type: "string" } },
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["name", "ingredients", "steps"],
  },
});

result.object.name;          // typed: string
result.object.ingredients;   // typed: string[]
result.object.steps;         // typed: string[]
result.usage;                // token counts when reported
```

## Why a JSON Schema literal instead of zod?

luv-js is zero-deps. The schema literal you pass to `generateObject` is
type-inferred via the same machinery `tool()` uses, so `result.object` is as
typed as a zod-validated value would be — without the ~50KB zod dep.

The trade-off: you write a schema literal instead of a zod chain. JSON
Schema is wordier; the type-level result is identical.

## OpenAI strict mode constraints

OpenAI's structured output mode is strict:

1. Every object must have `additionalProperties: false`. luv-js auto-injects
   this on every nested object so you don't have to.
2. Every property listed in `properties` must also be in `required`. luv-js
   doesn't enforce this — if you violate it, OpenAI's API will reject the
   request.

## Validation

After receiving the result, luv-js runs the same JSON-Schema shape check
that `parseArguments` uses (`tool_args.ts`). If the model produces JSON
that doesn't match the schema (rare with strict mode, possible if you set
strict to false later), `generateObject` throws `GenerateObjectError`
naming the failing path.

## Custom schema name

OpenAI requires a schema name in the request. Default is `"result"`; pass
`schemaName: "..."` to override:

```ts
await luv.generateObject({ ..., schemaName: "Recipe", schema: {...} });
```
