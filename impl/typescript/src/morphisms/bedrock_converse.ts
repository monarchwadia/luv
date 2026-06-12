import type {
  Block,
  Conversation,
  FinishReason,
  Reply,
  Usage,
  StreamEventReply,
  StreamReply,
} from "../types.js";

export interface BedrockRequestOptions {
  model_id: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
}

// luv_conversation_to_bedrock_request
export function luv_conversation_to_bedrock_request(
  conv: Conversation,
  opts: BedrockRequestOptions,
): unknown {
  const systemBlocks: Array<{ text: string }> = [];
  const initial: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  for (const node of conv.nodes) {
    const m = node.message;
    if (m.role === "system") {
      for (const b of m.content) {
        if (b.kind === "text") systemBlocks.push({ text: b.text });
      }
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;

    const content: unknown[] = [];
    for (const b of m.content) {
      const cb = blockToBedrock(b);
      if (cb !== null) content.push(cb);
    }
    initial.push({
      role: m.role,
      content: content.length > 0 ? content : [{ text: "" }],
    });
  }

  // Merge consecutive same-role messages.
  const merged: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const msg of initial) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }

  const req: Record<string, unknown> = { messages: merged };
  if (systemBlocks.length > 0) req.system = systemBlocks;

  const inferenceConfig: Record<string, unknown> = {};
  if (opts.max_tokens !== undefined) inferenceConfig.maxTokens = opts.max_tokens;
  if (opts.temperature !== undefined) inferenceConfig.temperature = opts.temperature;
  if (opts.top_p !== undefined) inferenceConfig.topP = opts.top_p;
  if (opts.stop_sequences !== undefined) inferenceConfig.stopSequences = opts.stop_sequences;
  if (Object.keys(inferenceConfig).length > 0) req.inferenceConfig = inferenceConfig;

  if (opts.tools !== undefined) {
    const toolConfig: Record<string, unknown> = { tools: opts.tools };
    if (opts.tool_choice !== undefined) toolConfig.toolChoice = opts.tool_choice;
    req.toolConfig = toolConfig;
  }

  return req;
}

function blockToBedrock(b: Block): unknown | null {
  if (b.kind === "text") return { text: b.text };
  if (b.kind === "tool_call") {
    let input: unknown = {};
    try { input = JSON.parse(b.args); } catch { /* empty */ }
    return { toolUse: { toolUseId: b.id, name: b.name, input } };
  }
  if (b.kind === "tool_result") {
    return { toolResult: { toolUseId: b.call_id, content: [{ text: b.text }] } };
  }
  return null;
}

// bedrock_response_to_luv_reply
export function bedrock_response_to_luv_reply(
  resp: unknown,
  model_id: string,
): Reply {
  const r = resp as {
    output: { message: { content: unknown[] } };
    stopReason: string;
    usage?: Record<string, unknown>;
  };
  const blocks: Block[] = [];
  for (const cb of r.output.message.content) {
    const b = bedrockBlockToLuv(cb);
    if (b !== null) blocks.push(b);
  }
  return {
    message: { role: "assistant", content: blocks },
    finish_reason: mapStopReason(r.stopReason),
    usage: bedrockUsageEnvelope(model_id, r.usage),
  };
}

function bedrockBlockToLuv(cb: unknown): Block | null {
  const block = cb as Record<string, unknown>;
  if (typeof block.text === "string") return { kind: "text", text: block.text };
  if (block.toolUse) {
    const tu = block.toolUse as { toolUseId: string; name: string; input: unknown };
    return { kind: "tool_call", id: tu.toolUseId, name: tu.name, args: JSON.stringify(tu.input) };
  }
  return null;
}

function bedrockUsageEnvelope(model_id: string, usage: unknown): Usage | null {
  if (usage === null || usage === undefined || typeof usage !== "object") return null;
  return { provider: "bedrock_converse", model: model_id, raw: usage };
}

function mapStopReason(r: string | null | undefined): FinishReason {
  switch (r) {
    case "end_turn": return "end_turn";
    case "max_tokens": return "max_tokens";
    case "model_context_window_exceeded": return "max_tokens";
    case "stop_sequence": return "end_turn";
    case "tool_use": return "end_turn";
    case "content_filtered": return "content_filter";
    case "guardrail_intervened": return "content_filter";
    case "malformed_model_output": return "error";
    case "malformed_tool_use": return "error";
    default: return "end_turn";
  }
}

// bedrock_stream_to_luv_stream
export function bedrock_stream_to_luv_stream(
  events: unknown[],
  model_id: string,
): StreamReply {
  const out: StreamEventReply[] = [];
  let storedStopReason: string | null = null;
  let usageObj: Record<string, unknown> | null = null;
  const openedBlocks = new Set<number>();

  for (const evt of events) {
    const e = evt as Record<string, unknown>;

    if (e.messageStart) {
      out.push({ kind: "message_start" });
    } else if (e.contentBlockStart) {
      const cbs = e.contentBlockStart as {
        contentBlockIndex: number;
        start: { toolUse?: { toolUseId: string; name: string } };
      };
      openedBlocks.add(cbs.contentBlockIndex);
      if (cbs.start.toolUse) {
        out.push({
          kind: "block_start",
          block: { kind: "tool_call", id: cbs.start.toolUse.toolUseId, name: cbs.start.toolUse.name, args: "" },
        });
      }
    } else if (e.contentBlockDelta) {
      const cbd = e.contentBlockDelta as {
        contentBlockIndex: number;
        delta: { text?: string; toolUse?: { input: string } };
      };
      // Implicit block_start for text blocks (no contentBlockStart event).
      if (!openedBlocks.has(cbd.contentBlockIndex)) {
        openedBlocks.add(cbd.contentBlockIndex);
        out.push({ kind: "block_start", block: { kind: "text", text: "" } });
      }
      if (typeof cbd.delta.text === "string") {
        out.push({ kind: "text_delta", text: cbd.delta.text });
      } else if (cbd.delta.toolUse) {
        out.push({ kind: "args_delta", args: cbd.delta.toolUse.input });
      }
    } else if (e.contentBlockStop) {
      out.push({ kind: "block_end" });
    } else if (e.messageStop) {
      const ms = e.messageStop as { stopReason: string };
      storedStopReason = ms.stopReason;
    } else if (e.metadata) {
      const meta = e.metadata as { usage?: Record<string, unknown> };
      if (meta.usage) usageObj = meta.usage;
      out.push({
        kind: "message_end",
        finish_reason: mapStopReason(storedStopReason),
        usage: bedrockUsageEnvelope(model_id, usageObj),
      });
    }
  }

  // Graceful degradation: if no metadata event arrived, emit message_end.
  if (storedStopReason !== null && !out.some((e) => e.kind === "message_end")) {
    out.push({
      kind: "message_end",
      finish_reason: mapStopReason(storedStopReason),
      usage: null,
    });
  }

  return out;
}
