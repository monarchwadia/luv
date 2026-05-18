// Differential gate for the `object` brick swap — PURE path only.
// Compares the TS port's pure extract+validate (JSON.parse of the reply text
// + parseArguments schema validation, as object.ts does it inline) against the
// wasm path (object_bridge.extractObject) over a representative equivalence
// set. Network/send/fetch are NOT exercised here — only the pure step.
// Additive; no existing test touched. Its job: enumerate divergences BEFORE
// the wrapper flips.
import { test, expect } from "bun:test";
import { extractObject } from "../src/wasm/object_bridge.ts";
import { GenerateObjectError } from "../src/object.ts";
import { parseArguments, ToolArgsError } from "../src/tool_args.ts";

// Re-implements EXACTLY object.ts's inline pure step (lines that do
// JSON.parse(reply.message.text) then parseArguments(...)) so the differential
// compares like-for-like.
function tsPortPure(replyText: string, schema: unknown): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(replyText);
  } catch {
    throw new GenerateObjectError(
      `model returned non-JSON content: ${replyText.slice(0, 200)}`,
    );
  }
  try {
    parseArguments({ id: "", name: "", arguments: raw }, schema);
  } catch (err) {
    if (err instanceof ToolArgsError) {
      throw new GenerateObjectError(`schema validation failed: ${err.message}`);
    }
    throw err;
  }
  return raw;
}

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "throw"; type: string; message: string };

function run(fn: () => unknown): Outcome {
  try {
    return { kind: "ok", value: fn() };
  } catch (e) {
    const err = e as Error;
    return { kind: "throw", type: err.name, message: err.message };
  }
}

const schemaObj = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    address: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  required: ["name", "age"],
} as const;

const cases: { name: string; text: string; schema: unknown }[] = [
  {
    name: "valid json matching schema",
    text: JSON.stringify({ name: "Ada", age: 36, address: { city: "London" } }),
    schema: schemaObj,
  },
  {
    name: "valid json, optional nested absent",
    text: JSON.stringify({ name: "Bo", age: 1 }),
    schema: schemaObj,
  },
  {
    name: "non-json text",
    text: "Sorry, I cannot help with that.",
    schema: schemaObj,
  },
  {
    name: "non-json (markdown fence)",
    text: "```json\n{\"name\":\"x\"}\n```",
    schema: schemaObj,
  },
  {
    name: "schema mismatch: missing required",
    text: JSON.stringify({ name: "Ada" }),
    schema: schemaObj,
  },
  {
    name: "schema mismatch: wrong type",
    text: JSON.stringify({ name: "Ada", age: "thirty" }),
    schema: schemaObj,
  },
  {
    name: "schema mismatch: nested path missing required",
    text: JSON.stringify({ name: "Ada", age: 5, address: {} }),
    schema: schemaObj,
  },
  {
    name: "schema mismatch: nested path wrong type",
    text: JSON.stringify({ name: "Ada", age: 5, address: { city: 9 } }),
    schema: schemaObj,
  },
];

for (const c of cases) {
  // Full parity: success values AND thrown error (type + message) must be
  // identical between the TS port's pure step and the wasm bridge. The Zig
  // object_extract validator deliberately emits the same parseArguments-style
  // message object.ts wrapped, so even schema-failure wording matches exactly.
  test(`object pure parity: ${c.name}`, () => {
    const port = run(() => tsPortPure(c.text, c.schema));
    const bridge = run(() => extractObject(c.text, c.schema));
    expect(bridge).toEqual(port);
  });
}
