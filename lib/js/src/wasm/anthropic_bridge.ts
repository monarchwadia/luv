// Ergonomic <-> codec bridge for the Anthropic morphism, over the synchronous
// wasm path. This is what morphism_anthropic.ts's toAnthropic/fromAnthropic
// will delegate to once the differential test proves equivalence. The codec
// is provider-agnostic (same wire as openai) — only the wasm export names
// differ. Anthropic has NO response_format (that was openai-only).
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.

import { callWasm } from "./sync.ts";
import {
  encodeSendRequest,
  decodeReply,
  type CodecMessage,
  type CodecToolCall,
} from "../codec.ts";
import type {
  Conversation,
  Reply,
  StopReason,
  Tool,
  ToolCall,
} from "../types.ts";
import type {
  ToAnthropicOptions,
  AnthropicWireRequest,
  AnthropicWireResponse,
} from "../morphism_anthropic.ts";
// Value import (cycle-safe: used only at call time) so the bridge itself
// honors the MorphismError(/content/) contract — same defensive non-typed
// path openai keeps in TS for response_format.
import { MorphismError } from "../morphism_anthropic.ts";

const ROLE: Record<"system" | "user" | "assistant", number> = {
  system: 0,
  user: 1,
  assistant: 2,
};

const STOP: readonly StopReason[] = [
  "end_turn",
  "max_tokens",
  "content_filter",
  "stop_sequence",
  "tool_use",
  "other",
];

const td = new TextDecoder();
const te = new TextEncoder();

function toCodecMessages(conv: Conversation): CodecMessage[] {
  return conv.map((m) => {
    const toolCalls: CodecToolCall[] =
      m.role === "assistant" && m.toolCalls
        ? m.toolCalls.map((c: ToolCall) => ({
            id: c.id,
            name: c.name,
            args: JSON.stringify(c.arguments),
            result:
              c.result === undefined
                ? null
                : c.result.ok
                  ? { ok: true, content: c.result.content }
                  : { ok: false, content: c.result.error },
          }))
        : [];
    return { role: ROLE[m.role], text: m.text, toolCalls };
  });
}

export function buildAnthropicRequest(
  opts: ToAnthropicOptions,
): AnthropicWireRequest {
  const bytes = callWasm(
    "luv_build_anthropic_request",
    encodeSendRequest({
      model: opts.model,
      messages: toCodecMessages(opts.conversation),
      maxTokens: opts.maxTokens ?? null,
      temperature: opts.temperature ?? null,
      stream: opts.stream ?? false,
      tools: (opts.tools ?? []).map((t: Tool) => ({
        name: t.name,
        description: t.description,
        inputSchema: JSON.stringify(t.inputSchema),
      })),
    }),
  );
  return JSON.parse(td.decode(bytes)) as AnthropicWireRequest;
}

export function parseAnthropicReply(wire: AnthropicWireResponse): Reply {
  // Defensive non-typed path: Zig's typed parse can't distinguish a
  // non-array `content`, so guard it here (matches the TS port contract).
  if (!Array.isArray((wire as { content?: unknown }).content)) {
    throw new MorphismError("fromAnthropic: response.content is not an array");
  }
  const bytes = callWasm(
    "luv_parse_anthropic_reply",
    te.encode(JSON.stringify(wire)),
  );
  const r = decodeReply(bytes);
  const stopReason: StopReason = STOP[r.stopReason] ?? "other";
  const message: Reply["message"] =
    r.toolCalls.length > 0
      ? {
          role: "assistant",
          text: r.text,
          toolCalls: r.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: JSON.parse(c.args) as unknown,
          })),
        }
      : { role: "assistant", text: r.text };
  const usage =
    r.usage === null
      ? undefined
      : {
          promptTokens: r.usage.prompt,
          completionTokens: r.usage.completion,
          totalTokens: r.usage.total,
        };
  return { message, stopReason, ...(usage && { usage }) };
}
