// Pure-TS port of core/src/morphisms/openai/openai.zig.
// Same shape contract; same fixture-validated semantics.
//
// Loss table (luv ↔ openai):
//
// luv → openai (toOpenAI):
//   - Roles map to lowercase strings: "system"|"user"|"assistant"|"tool".
//   - Conversation order preserved verbatim; consecutive same-role accepted.
//   - Optional fields are emitted only when set (no JSON null literals).
//   - Tools: luv Tool[] → OpenAI's [{type:"function", function:{name, description, parameters}}].
//     The tool's `handler` is dropped (not part of wire). `inputSchema` becomes `parameters`.
//   - Assistant.toolCalls: each ToolCall becomes a {id, type:"function",
//     function:{name, arguments:<stringified JSON>}} entry. content becomes
//     null when present-but-empty AND tool_calls non-empty (OpenAI convention).
//   - Tool messages: {role:"tool", tool_call_id, content}. ok results pass content
//     through; err results prefix with "Error: ".
//
// openai → luv (fromOpenAI):
//   - First choice only is taken (n>1 is out of scope).
//   - choice.message.role coerced to "assistant" unconditionally.
//   - choice.message.content used; if null, choice.message.refusal substituted (lossy).
//   - choice.message.tool_calls: each entry parsed back to luv ToolCall, with
//     `arguments` parsed from the wire string into a structured value.
//   - finish_reason mapping:
//       "stop"          → end_turn
//       "length"        → max_tokens
//       "content_filter" → content_filter
//       "tool_calls" | "function_call" → tool_use
//       anything else   → other
//   - Dropped: id, object, created, model, system_fingerprint, service_tier,
//     usage (and all subfields), choice.index, choice.logprobs,
//     message.annotations, message.audio.

import type { Conversation, JSONSchema, Reply, Tool } from "./types.ts";
import { buildOpenAIRequest, parseOpenAIReply } from "./wasm/openai_bridge.ts";

export interface ResponseFormat {
  readonly type: "json_schema";
  readonly json_schema: {
    readonly name: string;
    readonly schema: JSONSchema;
    readonly strict: boolean;
  };
}

export interface ToOpenAIOptions {
  readonly conversation: Conversation;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly tools?: readonly Tool[];
  readonly responseFormat?: ResponseFormat;
}

interface OpenAIWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIWireToolCall[];
  tool_call_id?: string;
}

interface OpenAIWireToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface OpenAIWireRequest {
  model: string;
  messages: OpenAIWireMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: OpenAIWireToolDef[];
  response_format?: ResponseFormat;
}

interface OpenAIWireResponseToolCall {
  readonly id: string;
  readonly type?: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAIWireUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

export interface OpenAIWireResponse {
  readonly id?: string;
  readonly object?: string;
  readonly created?: number;
  readonly model?: string;
  readonly choices: ReadonlyArray<{
    readonly index?: number;
    readonly message: {
      readonly role: string;
      readonly content?: string | null;
      readonly refusal?: string | null;
      readonly tool_calls?: readonly OpenAIWireResponseToolCall[];
    };
    readonly finish_reason: string;
  }>;
  readonly usage?: OpenAIWireUsage;
}

export class MorphismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorphismError";
  }
}

// Single-sourced in Zig: toOpenAI/fromOpenAI now delegate to the wasm core
// over the codec boundary (see wasm/openai_bridge.ts). The TS port logic was
// deleted after the differential test proved byte/behavior equivalence.
// `response_format` is applied in the bridge (Zig openai.zig drops it).
// Signatures are unchanged — consumers and their tests are untouched.

export function toOpenAI(opts: ToOpenAIOptions): OpenAIWireRequest {
  return buildOpenAIRequest(opts);
}

export function fromOpenAI(wire: OpenAIWireResponse): Reply {
  try {
    return parseOpenAIReply(wire);
  } catch (e) {
    // Preserve the public contract: fromOpenAI throws MorphismError.
    if (e instanceof MorphismError) throw e;
    throw new MorphismError(e instanceof Error ? e.message : String(e));
  }
}
