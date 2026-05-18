// generateObject — typed structured output from the model. Sets OpenAI's
// `response_format: json_schema` so the model is forced to return JSON
// matching the schema; parses + validates the result; returns it typed via
// `InferSchema<S>`.

import { classifyError } from "./errors.ts";
import { fromOpenAI, toOpenAI, type OpenAIWireResponse } from "./morphism.ts";
import type { SendInternalOptions } from "./send.ts";
import type { InferSchema } from "./tool.ts";
import type { Conversation, JSONSchema, StopReason, Usage } from "./types.ts";
import { extractObject } from "./wasm/object_bridge.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

export class GenerateObjectError extends Error {
  constructor(message: string) {
    super(`luv-js: generateObject: ${message}`);
    this.name = "GenerateObjectError";
  }
}

export interface GenerateObjectOptions<S> {
  readonly apiKey: string;
  readonly model: string;
  readonly conversation: Conversation;
  readonly schema: S;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Schema name passed to the provider. Default: "result". */
  readonly schemaName?: string;
}

export interface ObjectResult<T> {
  readonly object: T;
  readonly stopReason: StopReason;
  readonly usage?: Usage;
}

/**
 * Ask the model for a typed JSON object that matches `schema`.
 *
 * Sets `response_format: { type: "json_schema", json_schema: { ..., strict: true } }`
 * on the request so OpenAI's constrained-decoding guarantees valid JSON.
 * Parses the assistant's text into an object and validates it against
 * `schema` at runtime; returns the typed value via `InferSchema<S>`.
 *
 * Throws `GenerateObjectError` if the model returns invalid JSON or the
 * result doesn't match the schema.
 *
 * @example
 * const { object } = await generateObject({
 *   apiKey, model: "gpt-4o-mini",
 *   conversation: [{ role: "user", text: "Give me a recipe" }],
 *   schema: {
 *     type: "object",
 *     properties: {
 *       name: { type: "string" },
 *       ingredients: { type: "array", items: { type: "string" } },
 *     },
 *     required: ["name", "ingredients"],
 *   },
 * });
 * // object.name: string, object.ingredients: string[]
 */
export async function generateObject<const S>(
  opts: GenerateObjectOptions<S>,
  internal?: SendInternalOptions,
): Promise<ObjectResult<InferSchema<S>>> {
  const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);
  // OpenAI's strict mode requires `additionalProperties: false` on every
  // object node; we inject it deeply to spare the caller the boilerplate.
  const preparedSchema = injectAdditionalProperties(opts.schema as JSONSchema);
  const wire = toOpenAI({
    conversation: opts.conversation,
    model: opts.model,
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName ?? "result",
        schema: preparedSchema,
        strict: true,
      },
    },
  });

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const url = `${baseUrl}/v1/chat/completions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(wire),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw classifyError(res.status, utf8Decoder.decode(bodyBytes), res.headers.get("retry-after"));
  }

  const parsed = JSON.parse(utf8Decoder.decode(bodyBytes)) as OpenAIWireResponse;
  const reply = fromOpenAI(parsed);
  if (reply.message.role !== "assistant") {
    throw new GenerateObjectError("expected assistant reply");
  }

  // Single-sourced in Zig: the pure parse-as-JSON + schema-validate step now
  // delegates to the wasm core via wasm/object_bridge.ts. The bridge throws
  // the same GenerateObjectError (non-JSON / schema-failure) the deleted TS
  // port threw — proven byte/behavior-equivalent by test/object.diff.test.ts.
  const raw = extractObject(reply.message.text, opts.schema);

  return {
    object: raw as InferSchema<S>,
    stopReason: reply.stopReason,
    ...(reply.usage && { usage: reply.usage }),
  };
}

/** Recursively inject `additionalProperties: false` on every `type:"object"`
 *  node. OpenAI's strict structured-outputs mode requires this, and most
 *  users won't think to write it on each nested object. */
function injectAdditionalProperties(schema: JSONSchema): JSONSchema {
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = { ...schema };
  if (out["type"] === "object") {
    if (!("additionalProperties" in out)) out["additionalProperties"] = false;
    if (typeof out["properties"] === "object" && out["properties"] !== null) {
      const props = out["properties"] as Record<string, JSONSchema>;
      const newProps: Record<string, JSONSchema> = {};
      for (const [k, v] of Object.entries(props)) {
        newProps[k] = injectAdditionalProperties(v);
      }
      out["properties"] = newProps;
    }
  }
  if (out["type"] === "array" && out["items"]) {
    out["items"] = injectAdditionalProperties(out["items"] as JSONSchema);
  }
  return out as JSONSchema;
}
