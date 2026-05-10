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
