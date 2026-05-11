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

import type {
  Conversation,
  JSONSchema,
  Reply,
  StopReason,
  Tool,
  ToolCall,
  Usage,
} from "./types.ts";

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

export function toAnthropic(opts: ToAnthropicOptions): AnthropicWireRequest {
  const messages: AnthropicMessage[] = [];
  let system: string | undefined;

  for (const m of opts.conversation) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.text}` : m.text;
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: m.text });
      continue;
    }
    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: AnthropicRequestBlock[] = [];
        if (m.text) blocks.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) {
          blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
        }
        messages.push({ role: "assistant", content: blocks });

        // Split colocated → wire: every resolved call becomes a
        // tool_result block on a following user message (Anthropic's
        // convention). Pending calls emit nothing.
        const resultBlocks: AnthropicToolResultBlock[] = [];
        for (const c of m.toolCalls) {
          if (c.result === undefined) continue;
          resultBlocks.push(c.result.ok
            ? { type: "tool_result", tool_use_id: c.id, content: c.result.content }
            : { type: "tool_result", tool_use_id: c.id, content: c.result.error, is_error: true });
        }
        if (resultBlocks.length > 0) {
          messages.push({ role: "user", content: resultBlocks });
        }
      } else {
        messages.push({ role: "assistant", content: m.text });
      }
      continue;
    }
  }

  const out: AnthropicWireRequest = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages,
  };
  if (system !== undefined) out.system = system;
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.stream) out.stream = true;
  if (opts.tools && opts.tools.length > 0) {
    out.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// fromAnthropic

export function fromAnthropic(wire: AnthropicWireResponse): Reply {
  if (!Array.isArray(wire.content)) {
    throw new MorphismError("fromAnthropic: response.content is not an array");
  }
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of wire.content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        throw new MorphismError("fromAnthropic: tool_use block missing id or name");
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
    // Unknown block types (e.g. future server_tool_use, redacted_thinking) are dropped.
  }

  const stopReason = mapStopReason(wire.stop_reason);
  const usage: Usage = {
    promptTokens: wire.usage.input_tokens,
    completionTokens: wire.usage.output_tokens,
    totalTokens: wire.usage.input_tokens + wire.usage.output_tokens,
  };

  if (toolCalls.length > 0) {
    return {
      message: { role: "assistant", text, toolCalls },
      stopReason,
      usage,
    };
  }
  return {
    message: { role: "assistant", text },
    stopReason,
    usage,
  };
}

function mapStopReason(s: string | null): StopReason {
  switch (s) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}
