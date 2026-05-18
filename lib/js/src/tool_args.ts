// parseArguments — runtime-checked, type-asserted access to a ToolCall's
// arguments. The shape walker validates the value against a JSON Schema
// literal (the same shape `tool()` accepts) and returns a typed result via
// `InferSchema<S>`. Without a schema it's a typed identity returning T.

import type { InferSchema } from "./tool.ts";
import type { ToolCall } from "./types.ts";
import { validateToolArgs } from "./wasm/tool_args_bridge.ts";

export class ToolArgsError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`luv-js: parseArguments failed at ${path || "<root>"}: ${message}`);
    this.path = path;
    this.name = "ToolArgsError";
  }
}

/** Parse + validate `call.arguments` against `schema`, returning the typed value.
 *
 * Without a schema, returns `call.arguments` cast to `T` (no runtime check).
 * Throws `ToolArgsError` when the runtime shape doesn't match the schema.
 *
 * Single-sourced in Zig: the shape walker now delegates to the wasm core over
 * the codec boundary (see wasm/tool_args_bridge.ts). The ~95-line TS port
 * (`validate` / `typeOf`) was deleted after the differential test proved
 * behavior equivalence. Signatures and the `ToolArgsError` contract are
 * unchanged — consumers and their tests are untouched. The runtime dep is
 * one-directional (tool_args -> bridge; the bridge's `ToolArgsError` import is
 * a value re-export of this class, so the thrown error is `instanceof`-true
 * here with no cycle hazard at call time).
 */
export function parseArguments<S>(
  call: ToolCall,
  schema: S,
): InferSchema<S>;
export function parseArguments<T = unknown>(call: ToolCall): T;
export function parseArguments(call: ToolCall, schema?: unknown): unknown {
  if (!schema) return call.arguments;
  // JSON-boundary guard: JSON.stringify silently drops `undefined`-valued
  // keys, so the wasm validator can't distinguish "present but undefined"
  // (a type error in the TS contract) from "absent". A present-`undefined`
  // required property is not JSON-representable and never occurs via the real
  // model->JSON path; reproduce the TS port's type-mismatch error here so the
  // contract is byte-stable. Everything else is single-sourced in Zig.
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    const s = schema as {
      required?: unknown;
      properties?: Record<string, { type?: unknown }>;
    };
    const args = call.arguments;
    if (
      Array.isArray(s.required) &&
      typeof args === "object" &&
      args !== null &&
      !Array.isArray(args)
    ) {
      const obj = args as Record<string, unknown>;
      for (const key of s.required as unknown[]) {
        if (typeof key === "string" && key in obj && obj[key] === undefined) {
          const t = s.properties?.[key]?.type;
          throw new ToolArgsError(
            key,
            `expected ${typeof t === "string" ? t : "value"}, got undefined`,
          );
        }
      }
    }
  }
  return validateToolArgs(call.arguments, schema);
}
