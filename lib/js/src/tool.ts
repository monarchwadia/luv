// tool() — typed tool definitions with args inferred from the JSON Schema literal.
//
// Pass a const schema literal; the handler's `args` parameter gets a
// type derived from the schema (no runtime overhead, no zod). The returned
// value is a luv `Tool` ready for `runAgent` or any Provider that takes tools.

import type { Tool, ToolContext, ToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Schema → TypeScript type inference

/** Given a JSON-Schema-shaped object literal, infer the value type it describes. */
export type InferSchema<S> =
  // const: a single literal value
  S extends { readonly const: infer C }
    ? C
    : // enum: a union of literal values
      S extends { readonly enum: ReadonlyArray<infer E> }
      ? E
      : // primitives
        S extends { readonly type: "string" }
        ? string
        : S extends { readonly type: "number" | "integer" }
          ? number
          : S extends { readonly type: "boolean" }
            ? boolean
            : S extends { readonly type: "null" }
              ? null
              : // array of items
                S extends { readonly type: "array"; readonly items: infer Items }
                ? Array<InferSchema<Items>>
                : // object with properties + required
                  S extends {
                      readonly type: "object";
                      readonly properties: infer P;
                      readonly required: ReadonlyArray<infer R>;
                    }
                  ? P extends Record<string, unknown>
                    ? Prettify<
                        // required keys
                        {
                          [K in keyof P as K extends R ? K : never]: InferSchema<P[K]>;
                        } & {
                          // optional keys
                          [K in keyof P as K extends R ? never : K]?: InferSchema<P[K]>;
                        }
                      >
                    : never
                  : // object with properties but no required → all optional
                    S extends { readonly type: "object"; readonly properties: infer P }
                    ? P extends Record<string, unknown>
                      ? Prettify<{ [K in keyof P]?: InferSchema<P[K]> }>
                      : never
                    : // empty object
                      S extends { readonly type: "object" }
                      ? Record<string, unknown>
                      : unknown;

/** Flatten an intersection type so hover shows a clean object. */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// tool() factory

export interface ToolDef<S> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly handler: (args: InferSchema<S>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Build a luv `Tool` with type-inferred handler args.
 *
 *  Pass the inputSchema as an inline object literal (the `const` modifier on
 *  the type parameter preserves literal types, no `as const` needed).
 */
export function tool<const S>(def: ToolDef<S>): Tool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as Tool["inputSchema"],
    handler: def.handler as Tool["handler"],
  };
}
