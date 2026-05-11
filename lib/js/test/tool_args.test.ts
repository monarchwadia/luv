// DX-9 red tests: parseArguments<T>(call, schema?) helper.

import { test, expect } from "bun:test";
import { parseArguments } from "../src/tool_args.ts";
import type { ToolCall } from "../src/types.ts";

const callOk: ToolCall = {
  id: "c1",
  name: "lookup_weather",
  arguments: { city: "Tokyo", units: "c" },
};

const callMissingRequired: ToolCall = {
  id: "c2",
  name: "lookup_weather",
  arguments: { units: "c" },
};

const callWrongType: ToolCall = {
  id: "c3",
  name: "lookup_weather",
  arguments: { city: 42 },
};

const schema = {
  type: "object",
  properties: {
    city: { type: "string" },
    units: { type: "string", enum: ["c", "f"] },
  },
  required: ["city"],
} as const;

test("parseArguments: returns the typed args when shape matches", () => {
  const args = parseArguments(callOk, schema);
  expect(args.city).toBe("Tokyo");
  expect(args.units).toBe("c");
});

test("parseArguments: throws when required field is missing", () => {
  expect(() => parseArguments(callMissingRequired, schema)).toThrow(/city/);
});

test("parseArguments: throws when a field has the wrong type", () => {
  expect(() => parseArguments(callWrongType, schema)).toThrow(/city|string/);
});

test("parseArguments: works without a schema (just type-asserted return)", () => {
  const args = parseArguments<{ city: string }>(callOk);
  expect(args.city).toBe("Tokyo");
});

test("parseArguments: validates nested object shape", () => {
  const nestedSchema = {
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    required: ["profile"],
  } as const;
  const callOkNested: ToolCall = {
    id: "c4",
    name: "x",
    arguments: { profile: { name: "Sam" } },
  };
  const callBadNested: ToolCall = {
    id: "c5",
    name: "x",
    arguments: { profile: {} },
  };
  expect(parseArguments(callOkNested, nestedSchema).profile.name).toBe("Sam");
  expect(() => parseArguments(callBadNested, nestedSchema)).toThrow(/name/);
});

test("parseArguments: validates array items", () => {
  const arrSchema = {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
    required: ["items"],
  } as const;
  const ok: ToolCall = { id: "x", name: "x", arguments: { items: ["a", "b"] } };
  const bad: ToolCall = { id: "x", name: "x", arguments: { items: ["a", 5] } };
  expect(parseArguments(ok, arrSchema).items).toEqual(["a", "b"]);
  expect(() => parseArguments(bad, arrSchema)).toThrow();
});

test("parseArguments: enum constraint is enforced", () => {
  const enumSchema = {
    type: "object",
    properties: { mode: { type: "string", enum: ["fast", "slow"] } },
    required: ["mode"],
  } as const;
  const ok: ToolCall = { id: "x", name: "x", arguments: { mode: "fast" } };
  const bad: ToolCall = { id: "x", name: "x", arguments: { mode: "auto" } };
  expect(parseArguments(ok, enumSchema).mode).toBe("fast");
  expect(() => parseArguments(bad, enumSchema)).toThrow(/mode|enum/);
});

import { ToolArgsError } from "../src/tool_args.ts";

test("parseArguments: integer type rejects floats", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  } as const;
  expect(() => parseArguments(
    { id: "x", name: "x", arguments: { count: 1.5 } } as ToolCall,
    schema,
  )).toThrow(/integer/);
});

test("parseArguments: integer accepts whole numbers", () => {
  const schema = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
  } as const;
  const r = parseArguments(
    { id: "x", name: "x", arguments: { count: 42 } } as ToolCall,
    schema,
  );
  expect(r.count).toBe(42);
});

test("parseArguments: number accepts both integers and floats", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  } as const;
  expect(parseArguments({ id: "x", name: "x", arguments: { x: 42 } } as ToolCall, schema).x).toBe(42);
  expect(parseArguments({ id: "x", name: "x", arguments: { x: 1.5 } } as ToolCall, schema).x).toBe(1.5);
});

test("parseArguments: boolean type rejects non-booleans", () => {
  const schema = {
    type: "object",
    properties: { flag: { type: "boolean" } },
    required: ["flag"],
  } as const;
  expect(() => parseArguments(
    { id: "x", name: "x", arguments: { flag: "true" } } as ToolCall,
    schema,
  )).toThrow(/boolean/);
});

test("parseArguments: null type accepts null only", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "null" } },
    required: ["x"],
  } as const;
  expect(parseArguments({ id: "x", name: "x", arguments: { x: null } } as ToolCall, schema).x).toBe(null);
  expect(() => parseArguments(
    { id: "x", name: "x", arguments: { x: undefined } } as ToolCall,
    schema,
  )).toThrow(/null/);
});

test("parseArguments: array of objects validates each item", () => {
  const schema = {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
    required: ["users"],
  } as const;
  const ok = parseArguments(
    { id: "x", name: "x", arguments: { users: [{ name: "a" }, { name: "b" }] } } as ToolCall,
    schema,
  );
  expect(ok.users.length).toBe(2);
  // One bad item
  expect(() => parseArguments(
    { id: "x", name: "x", arguments: { users: [{ name: "a" }, { age: 5 }] } } as ToolCall,
    schema,
  )).toThrow(/name/);
});

test("ToolArgsError.path identifies the failing field for nested objects", () => {
  const schema = {
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    required: ["profile"],
  } as const;
  try {
    parseArguments(
      { id: "x", name: "x", arguments: { profile: { name: 42 } } } as ToolCall,
      schema,
    );
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ToolArgsError);
    if (err instanceof ToolArgsError) {
      expect(err.path).toBe("profile.name");
    }
  }
});

test("ToolArgsError.path uses array index notation for failing array items", () => {
  const schema = {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
    required: ["items"],
  } as const;
  try {
    parseArguments(
      { id: "x", name: "x", arguments: { items: ["a", 5] } } as ToolCall,
      schema,
    );
    throw new Error("should have thrown");
  } catch (err) {
    if (err instanceof ToolArgsError) expect(err.path).toBe("items[1]");
  }
});

test("parseArguments: extra properties (not in schema) are accepted (no strict mode)", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  } as const;
  const r = parseArguments(
    { id: "x", name: "x", arguments: { name: "Sam", extra: "field" } } as ToolCall,
    schema,
  );
  expect(r.name).toBe("Sam");
});

test("parseArguments: const schema enforces a single literal value", () => {
  const schema = {
    type: "object",
    properties: { kind: { const: "request" } },
    required: ["kind"],
  } as const;
  expect(parseArguments(
    { id: "x", name: "x", arguments: { kind: "request" } } as ToolCall,
    schema,
  ).kind).toBe("request");
  expect(() => parseArguments(
    { id: "x", name: "x", arguments: { kind: "response" } } as ToolCall,
    schema,
  )).toThrow();
});
