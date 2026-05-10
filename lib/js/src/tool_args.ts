// parseArguments — runtime-checked, type-asserted access to a ToolCall's
// arguments. The shape walker validates the value against a JSON Schema
// literal (the same shape `tool()` accepts) and returns a typed result via
// `InferSchema<S>`. Without a schema it's a typed identity returning T.

import type { InferSchema } from "./tool.ts";
import type { ToolCall } from "./types.ts";

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
 */
export function parseArguments<S>(
  call: ToolCall,
  schema: S,
): InferSchema<S>;
export function parseArguments<T = unknown>(call: ToolCall): T;
export function parseArguments(call: ToolCall, schema?: unknown): unknown {
  if (!schema) return call.arguments;
  validate(call.arguments, schema, "");
  return call.arguments;
}

function validate(value: unknown, schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as Record<string, unknown>;

  // const
  if ("const" in s) {
    if (value !== s["const"]) {
      throw new ToolArgsError(path, `expected const ${JSON.stringify(s["const"])}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  // enum
  if (Array.isArray(s["enum"])) {
    if (!s["enum"].includes(value as never)) {
      throw new ToolArgsError(
        path,
        `value ${JSON.stringify(value)} not in enum ${JSON.stringify(s["enum"])}`,
      );
    }
    return;
  }

  switch (s["type"]) {
    case "string":
      if (typeof value !== "string") {
        throw new ToolArgsError(path, `expected string, got ${typeOf(value)}`);
      }
      return;
    case "number":
      if (typeof value !== "number") {
        throw new ToolArgsError(path, `expected number, got ${typeOf(value)}`);
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ToolArgsError(path, `expected integer, got ${typeOf(value)}`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ToolArgsError(path, `expected boolean, got ${typeOf(value)}`);
      }
      return;
    case "null":
      if (value !== null) {
        throw new ToolArgsError(path, `expected null, got ${typeOf(value)}`);
      }
      return;
    case "array": {
      if (!Array.isArray(value)) {
        throw new ToolArgsError(path, `expected array, got ${typeOf(value)}`);
      }
      const items = s["items"];
      if (items) {
        for (let i = 0; i < value.length; i++) {
          validate(value[i], items, `${path}[${i}]`);
        }
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ToolArgsError(path, `expected object, got ${typeOf(value)}`);
      }
      const obj = value as Record<string, unknown>;
      const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
      const properties =
        typeof s["properties"] === "object" && s["properties"] !== null
          ? (s["properties"] as Record<string, unknown>)
          : {};
      for (const key of required) {
        if (!(key in obj)) {
          throw new ToolArgsError(path, `missing required field "${key}"`);
        }
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in obj) {
          validate(obj[key], sub, path ? `${path}.${key}` : key);
        }
      }
      return;
    }
    default:
      // Unknown / unspecified type — accept anything.
      return;
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
