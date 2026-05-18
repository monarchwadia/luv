// Differential gate for the tool_args brick swap.
// Compares the TS port (the pre-flip `validate` logic, captured here as a
// frozen reference) against the wasm path (tool_args_bridge) over a
// representative equivalence set: valid / invalid / no-schema / nested-path /
// enum / const / type-mismatch. Its JOB is to enumerate divergences BEFORE
// tool_args.ts flips — nothing is swapped/deleted until this is green.
// Additive; no existing test touched.
//
// `test.failing` is used ONLY for genuine divergences that need a serial Zig
// reconciliation (none expected — the Zig brick is a documented behavioral
// mirror of the TS port).

import { test, expect } from "bun:test";
import { validateToolArgs } from "../src/wasm/tool_args_bridge.ts";
import type { ToolCall } from "../src/types.ts";

// Frozen copy of the original TS port `validate` + `ToolArgsError` so the
// differential compares wasm vs the exact pre-flip behavior even after
// tool_args.ts is flipped to delegate. (Mirrors the morphism.diff pattern of
// holding both sides.)
class RefToolArgsError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`luv-js: parseArguments failed at ${path || "<root>"}: ${message}`);
    this.path = path;
    this.name = "ToolArgsError";
  }
}
function refTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function refValidate(value: unknown, schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as Record<string, unknown>;
  if ("const" in s) {
    if (value !== s["const"]) {
      throw new RefToolArgsError(
        path,
        `expected const ${JSON.stringify(s["const"])}, got ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (Array.isArray(s["enum"])) {
    if (!s["enum"].includes(value as never)) {
      throw new RefToolArgsError(
        path,
        `value ${JSON.stringify(value)} not in enum ${JSON.stringify(s["enum"])}`,
      );
    }
    return;
  }
  switch (s["type"]) {
    case "string":
      if (typeof value !== "string")
        throw new RefToolArgsError(path, `expected string, got ${refTypeOf(value)}`);
      return;
    case "number":
      if (typeof value !== "number")
        throw new RefToolArgsError(path, `expected number, got ${refTypeOf(value)}`);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        throw new RefToolArgsError(path, `expected integer, got ${refTypeOf(value)}`);
      return;
    case "boolean":
      if (typeof value !== "boolean")
        throw new RefToolArgsError(path, `expected boolean, got ${refTypeOf(value)}`);
      return;
    case "null":
      if (value !== null)
        throw new RefToolArgsError(path, `expected null, got ${refTypeOf(value)}`);
      return;
    case "array": {
      if (!Array.isArray(value))
        throw new RefToolArgsError(path, `expected array, got ${refTypeOf(value)}`);
      const items = s["items"];
      if (items) {
        for (let i = 0; i < value.length; i++)
          refValidate(value[i], items, `${path}[${i}]`);
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new RefToolArgsError(path, `expected object, got ${refTypeOf(value)}`);
      const obj = value as Record<string, unknown>;
      const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
      const properties =
        typeof s["properties"] === "object" && s["properties"] !== null
          ? (s["properties"] as Record<string, unknown>)
          : {};
      for (const key of required) {
        if (!(key in obj))
          throw new RefToolArgsError(path, `missing required field "${key}"`);
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in obj)
          refValidate(obj[key], sub, path ? `${path}.${key}` : key);
      }
      return;
    }
    default:
      return;
  }
}
function refParseArguments(call: ToolCall, schema?: unknown): unknown {
  if (!schema) return call.arguments;
  refValidate(call.arguments, schema, "");
  return call.arguments;
}

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string; path: unknown };

function runRef(call: ToolCall, schema?: unknown): Outcome {
  try {
    return { ok: true, value: refParseArguments(call, schema) };
  } catch (e) {
    const err = e as { name: string; message: string; path?: unknown };
    return { ok: false, name: err.name, message: err.message, path: err.path };
  }
}
function runWasm(call: ToolCall, schema?: unknown): Outcome {
  try {
    return { ok: true, value: validateToolArgs(call.arguments, schema) };
  } catch (e) {
    const err = e as { name: string; message: string; path?: unknown };
    return { ok: false, name: err.name, message: err.message, path: err.path };
  }
}

const cases: { name: string; call: ToolCall; schema?: unknown }[] = [
  {
    name: "valid object",
    call: { id: "c", name: "x", arguments: { city: "Tokyo", units: "c" } },
    schema: {
      type: "object",
      properties: { city: { type: "string" }, units: { type: "string", enum: ["c", "f"] } },
      required: ["city"],
    },
  },
  {
    name: "no schema (identity)",
    call: { id: "c", name: "x", arguments: { anything: [1, 2, 3] } },
  },
  {
    name: "missing required field",
    call: { id: "c", name: "x", arguments: { units: "c" } },
    schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  {
    name: "type mismatch (string vs number)",
    call: { id: "c", name: "x", arguments: { city: 42 } },
    schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  {
    name: "nested object path",
    call: { id: "c", name: "x", arguments: { profile: {} } },
    schema: {
      type: "object",
      properties: {
        profile: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      required: ["profile"],
    },
  },
  {
    name: "nested object valid",
    call: { id: "c", name: "x", arguments: { profile: { name: "Sam" } } },
    schema: {
      type: "object",
      properties: {
        profile: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      required: ["profile"],
    },
  },
  {
    name: "array item index path",
    call: { id: "c", name: "x", arguments: { items: ["a", 5] } },
    schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    },
  },
  {
    name: "array valid",
    call: { id: "c", name: "x", arguments: { items: ["a", "b"] } },
    schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    },
  },
  {
    name: "enum violation",
    call: { id: "c", name: "x", arguments: { mode: "auto" } },
    schema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    },
  },
  {
    name: "enum ok",
    call: { id: "c", name: "x", arguments: { mode: "fast" } },
    schema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    },
  },
  {
    name: "const violation",
    call: { id: "c", name: "x", arguments: { kind: "b" } },
    schema: { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
  },
  {
    name: "const ok",
    call: { id: "c", name: "x", arguments: { kind: "a" } },
    schema: { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
  },
  {
    name: "integer accepts whole number",
    call: { id: "c", name: "x", arguments: { n: 3 } },
    schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
  {
    name: "integer rejects float",
    call: { id: "c", name: "x", arguments: { n: 3.5 } },
    schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
  {
    name: "boolean type",
    call: { id: "c", name: "x", arguments: { b: "no" } },
    schema: { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
  },
  {
    name: "null type",
    call: { id: "c", name: "x", arguments: { z: 0 } },
    schema: { type: "object", properties: { z: { type: "null" } }, required: ["z"] },
  },
  {
    name: "root not an object",
    call: { id: "c", name: "x", arguments: "not an object" },
    schema: { type: "object", properties: {} },
  },
  {
    name: "unknown type literal accepts anything",
    call: { id: "c", name: "x", arguments: { whatever: true } },
    schema: { type: "object", properties: { whatever: { type: "frobnicate" } } },
  },
];

for (const c of cases) {
  test(`tool_args parity: ${c.name}`, () => {
    const ref = runRef(c.call, c.schema);
    const got = runWasm(c.call, c.schema);
    expect(got).toEqual(ref);
  });
}

// GENUINE DIVERGENCE — codec/orchestrator reconciliation (NOT a Zig bug).
//
// The TS port walked the in-memory JS value, so a *required* property whose
// value is literally `undefined` satisfies `key in obj` (present) and fails
// the leaf check with `expected null, got undefined`. The single-source path
// crosses the codec via `JSON.stringify`, which ELIDES `undefined`-valued
// keys entirely — so the wasm sees the key as absent and throws
// `missing required field "x"` instead. Both still throw a `ToolArgsError`;
// only the message differs.
//
// This is inherent to the JSON wire boundary the proven openai recipe also
// uses: `undefined` is not representable in JSON and exists only in JS memory
// before serialization. NO Zig change can fix it (Zig validates the valid
// JSON it receives correctly); a fix would require a codec-level decision
// (e.g. an explicit `undefined` sentinel) which the orchestrator owns and
// reconciles serially. The existing `test/tool_args.test.ts` "null type
// accepts null only" case hits exactly this and is consequently red post-flip
// (UNMODIFIED per constraints) — reported to the orchestrator.
test.failing(
  "tool_args parity: required key with `undefined` value (JSON elides it)",
  () => {
    const call: ToolCall = { id: "c", name: "x", arguments: { x: undefined } };
    const schema = {
      type: "object",
      properties: { x: { type: "null" } },
      required: ["x"],
    };
    expect(runWasm(call, schema)).toEqual(runRef(call, schema));
  },
);
