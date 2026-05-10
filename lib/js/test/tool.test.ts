// DX-2 red tests: tool() helper with type-inferred args from the schema.

import { test, expect } from "bun:test";
import { tool } from "../src/tool.ts";

test("tool: returns a Tool with the same name/description/inputSchema", () => {
  const t = tool({
    name: "lookup_weather",
    description: "Returns current weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    handler: async (args) => ({ ok: true, content: args.city }),
  });
  expect(t.name).toBe("lookup_weather");
  expect(t.description).toContain("weather");
  expect(typeof t.handler).toBe("function");
});

test("tool: handler receives typed args (compile-time check via runtime use)", async () => {
  const t = tool({
    name: "echo",
    description: "echoes a message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" }, count: { type: "number" } },
      required: ["message"],
    },
    handler: async ({ message, count }) => ({
      ok: true,
      content: `${message} (count=${count ?? 1})`,
    }),
  });
  const result = await t.handler({ message: "hi", count: 3 }, {});
  if (!result.ok) throw new Error("expected ok");
  expect(result.content).toBe("hi (count=3)");
});

test("tool: required field missing in args is a compile error (runtime test exercises optional)", async () => {
  const t = tool({
    name: "greet",
    description: "greets",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, formal: { type: "boolean" } },
      required: ["name"],
    },
    handler: async ({ name, formal }) => ({
      ok: true,
      content: formal ? `Greetings, ${name}.` : `Hi, ${name}!`,
    }),
  });
  // Optional `formal` may be omitted at runtime; type system allows it.
  const r1 = await t.handler({ name: "Sam" }, {});
  const r2 = await t.handler({ name: "Sam", formal: true }, {});
  if (!r1.ok || !r2.ok) throw new Error("expected ok");
  expect(r1.content).toBe("Hi, Sam!");
  expect(r2.content).toBe("Greetings, Sam.");
});

test("tool: nested object schema infers nested types", async () => {
  const t = tool({
    name: "make_user",
    description: "creates a user",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "number" } },
          required: ["name"],
        },
      },
      required: ["profile"],
    },
    handler: async ({ profile }) => ({
      ok: true,
      content: `${profile.name}/${profile.age ?? "?"}`,
    }),
  });
  const r = await t.handler({ profile: { name: "Sam", age: 42 } }, {});
  if (!r.ok) throw new Error();
  expect(r.content).toBe("Sam/42");
});

test("tool: array schema infers array of items", async () => {
  const t = tool({
    name: "join",
    description: "joins items",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
      required: ["items"],
    },
    handler: async ({ items }) => ({ ok: true, content: items.join(",") }),
  });
  const r = await t.handler({ items: ["a", "b", "c"] }, {});
  if (!r.ok) throw new Error();
  expect(r.content).toBe("a,b,c");
});

test("tool: enum schema narrows to literal union", async () => {
  const t = tool({
    name: "set_mode",
    description: "sets mode",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow", "auto"] },
      },
      required: ["mode"],
    },
    handler: async ({ mode }) => {
      // mode is "fast" | "slow" | "auto" at the type level
      const valid: "fast" | "slow" | "auto" = mode;
      return { ok: true, content: valid };
    },
  });
  const r = await t.handler({ mode: "fast" }, {});
  if (!r.ok) throw new Error();
  expect(r.content).toBe("fast");
});

test("tool: works as a luv.Tool when given to runAgent", () => {
  // Just type-check that the returned value is assignable to Tool.
  const t = tool({
    name: "noop",
    description: "no-op",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ ok: true, content: "" }),
  });
  // If the cast compiles, the type is correctly Tool-shaped.
  const tools: import("../src/types.ts").Tool[] = [t];
  expect(tools.length).toBe(1);
});
