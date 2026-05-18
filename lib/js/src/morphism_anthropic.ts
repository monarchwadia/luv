// Pure-TS morphism: luv ↔ Anthropic Messages API.
//
// Loss table (luv ↔ anthropic):
//
// luv → anthropic (toAnthropic):
//   - System messages are pulled out of the conversation array into the
//     top-level `system` field (Anthropic-specific). Multiple system
//     messages are concatenated with blank-line separators.
//   - Assistant messages with `toolCalls` become an array of content blocks:
//     a text block (if `text` is non-empty) plus one `tool_use` block per call.
//   - Tool messages become a `tool_result` content block on a user message.
//     Adjacent tool results are folded into the same user message (Anthropic
//     prefers this and may require it for some models).
//   - `max_tokens` defaults to 1024 if not provided (Anthropic requires it).
//
// anthropic → luv (fromAnthropic):
//   - All `text` content blocks are concatenated into Reply.message.text.
//   - All `tool_use` content blocks become Reply.message.toolCalls.
//   - `stop_reason` vocabulary maps cleanly: end_turn / max_tokens /
//     stop_sequence / tool_use are 1:1 with luv.StopReason; anything else → other.
//   - `usage.input_tokens` → promptTokens, `output_tokens` → completionTokens,
//     `totalTokens` is computed (Anthropic doesn't send a total).
//   - Dropped: id, type, role (assumed assistant), model, stop_sequence.

import type { Conversation, JSONSchema, Reply, Tool } from "./types.ts";
import {
  buildAnthropicRequest,
  parseAnthropicReply,
} from "./wasm/anthropic_bridge.ts";

export class MorphismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorphismError";
  }
}

// ---------------------------------------------------------------------------
// Wire types

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicRequestBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicRequestBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export interface AnthropicWireRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
}

interface AnthropicResponseBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

export interface AnthropicWireResponse {
  readonly id?: string;
  readonly type?: string;
  readonly role?: string;
  readonly content: readonly AnthropicResponseBlock[];
  readonly model?: string;
  readonly stop_reason: string | null;
  readonly stop_sequence?: string | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

// ---------------------------------------------------------------------------
// toAnthropic

export interface ToAnthropicOptions {
  readonly conversation: Conversation;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly tools?: readonly Tool[];
}

// Single-sourced in Zig: toAnthropic/fromAnthropic now delegate to the wasm
// core over the codec boundary (see wasm/anthropic_bridge.ts). The TS port
// logic (mapping loops, mapStopReason) was deleted after the differential
// test proved equivalence. Signatures are unchanged — consumers and their
// tests are untouched. The non-array `content` guard stays in TS: the Zig
// typed parse rejects it generically (status -3, ContentNotArray unreachable
// under typed parsing), so the wrapper preserves the documented
// MorphismError(/content/) contract here (analogous to openai keeping
// response_format in TS).

export function toAnthropic(opts: ToAnthropicOptions): AnthropicWireRequest {
  return buildAnthropicRequest(opts);
}

export function fromAnthropic(wire: AnthropicWireResponse): Reply {
  if (!Array.isArray(wire.content)) {
    throw new MorphismError("fromAnthropic: response.content is not an array");
  }
  try {
    return parseAnthropicReply(wire);
  } catch (e) {
    // Preserve the public contract: fromAnthropic throws MorphismError.
    if (e instanceof MorphismError) throw e;
    throw new MorphismError(e instanceof Error ? e.message : String(e));
  }
}
