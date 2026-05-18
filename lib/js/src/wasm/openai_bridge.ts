// Ergonomic <-> codec bridge for the OpenAI morphism, over the synchronous
// wasm path. This is what morphism.ts's toOpenAI/fromOpenAI will delegate to
// once the differential test proves equivalence. `response_format` is applied
// here in TS (Zig openai.zig drops it by design).
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.

import { buildRequest, parseReply } from "./sync.ts";
import type {
  Conversation,
  Reply,
  StopReason,
  Tool,
  ToolCall,
} from "../types.ts";
import type {
  ToOpenAIOptions,
  OpenAIWireRequest,
  OpenAIWireResponse,
} from "../morphism.ts";
import type { CodecMessage, CodecToolCall } from "../codec.ts";

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

export function buildOpenAIRequest(opts: ToOpenAIOptions): OpenAIWireRequest {
  const json = buildRequest({
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
  });
  const wire = JSON.parse(json) as OpenAIWireRequest;
  // Zig openai.zig drops response_format — apply it here in TS.
  if (opts.responseFormat) {
    return { ...wire, response_format: opts.responseFormat };
  }
  return wire;
}

export function parseOpenAIReply(wire: OpenAIWireResponse): Reply {
  const r = parseReply(JSON.stringify(wire));
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
