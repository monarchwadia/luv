import type {
  Block,
  Conversation,
  FinishReason,
  Reply,
  StreamEventReply,
  StreamReply,
} from "../types.js";

export interface AnthropicRequestOptions {
  model: string;
  max_tokens: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  stop_sequences?: string[];
}

// luv_conversation_to_anthropic_request
// Builds an Anthropic Messages request body from a luv Conversation
// (walked linearly in array order) plus per-call options.
export function luv_conversation_to_anthropic_request(
  conv: Conversation,
  opts: AnthropicRequestOptions,
): unknown {
  const systemTexts: string[] = [];
  // First pass: per-node emission into a flat messages list.
  const initial: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];

  for (const node of conv.nodes) {
    const m = node.message;
    if (m.role === "system") {
      const txt = m.content
        .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("");
      systemTexts.push(txt);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;

    const allText = m.content.every((b) => b.kind === "text");
    let content: string | unknown[];
    if (allText) {
      content = m.content
        .map((b) => (b as Extract<Block, { kind: "text" }>).text)
        .join("");
    } else {
      const arr: unknown[] = [];
      for (const b of m.content) {
        const cb = blockToAnthropic(b);
        if (cb !== null) arr.push(cb);
      }
      content = arr;
    }
    initial.push({ role: m.role, content });
  }

  // Second pass: merge consecutive same-role messages.
  const merged: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];
  for (const msg of initial) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.role !== msg.role) {
      merged.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (typeof prev.content === "string" && typeof msg.content === "string") {
      prev.content = prev.content + msg.content;
    } else {
      const prevArr =
        typeof prev.content === "string"
          ? prev.content.length > 0
            ? [{ type: "text", text: prev.content }]
            : []
          : prev.content;
      const newArr =
        typeof msg.content === "string"
          ? msg.content.length > 0
            ? [{ type: "text", text: msg.content }]
            : []
          : msg.content;
      prev.content = [...prevArr, ...newArr];
    }
  }

  // Canonical key order: model, max_tokens, messages, [system], [stream],
  // [tools], [tool_choice], [temperature], [stop_sequences].
  const req: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.max_tokens,
    messages: merged,
  };
  if (systemTexts.length > 0) req.system = systemTexts.join("\n\n");
  if (opts.stream !== undefined) req.stream = opts.stream;
  if (opts.tools !== undefined) req.tools = opts.tools;
  if (opts.tool_choice !== undefined) req.tool_choice = opts.tool_choice;
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (opts.stop_sequences !== undefined) req.stop_sequences = opts.stop_sequences;
  return req;
}

function blockToAnthropic(b: Block): unknown | null {
  if (b.kind === "text") {
    return { type: "text", text: b.text };
  }
  if (b.kind === "tool_call") {
    let input: unknown = {};
    try {
      input = JSON.parse(b.args);
    } catch {
      // Malformed args: pass empty object. Documented in homomorphism_exceptions.
    }
    return { type: "tool_use", id: b.id, name: b.name, input };
  }
  if (b.kind === "tool_result") {
    return { type: "tool_result", tool_use_id: b.call_id, content: b.text };
  }
  // error blocks not representable; drop (documented in homomorphism_exceptions).
  return null;
}

// anthropic_response_to_luv_reply
export function anthropic_response_to_luv_reply(resp: unknown): Reply {
  const r = resp as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
    stop_reason: string | null;
  };
  const blocks: Block[] = [];
  for (const cb of r.content) {
    if (cb.type === "text") {
      blocks.push({ kind: "text", text: cb.text });
    } else if (cb.type === "tool_use") {
      blocks.push({
        kind: "tool_call",
        id: cb.id,
        name: cb.name,
        args: JSON.stringify(cb.input),
      });
    }
  }
  return {
    message: { role: "assistant", content: blocks },
    finish_reason: mapStopReason(r.stop_reason),
  };
}

function mapStopReason(r: string | null | undefined): FinishReason {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// anthropic_stream_to_luv_stream
export function anthropic_stream_to_luv_stream(
  events: unknown[],
): StreamReply {
  const out: StreamEventReply[] = [];
  let storedStopReason: string | null = null;

  for (const evt of events) {
    const e = evt as {
      type: string;
      content_block?: { type: string; id?: string; name?: string };
      delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        stop_reason?: string;
      };
    };
    switch (e.type) {
      case "message_start":
        out.push({ kind: "message_start" });
        break;
      case "content_block_start": {
        const cb = e.content_block;
        if (!cb) break;
        if (cb.type === "text") {
          out.push({
            kind: "block_start",
            block: { kind: "text", text: "" },
          });
        } else if (cb.type === "tool_use") {
          out.push({
            kind: "block_start",
            block: {
              kind: "tool_call",
              id: cb.id ?? "",
              name: cb.name ?? "",
              args: "",
            },
          });
        }
        break;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (!d) break;
        if (d.type === "text_delta" && typeof d.text === "string") {
          out.push({ kind: "text_delta", text: d.text });
        } else if (
          d.type === "input_json_delta" &&
          typeof d.partial_json === "string"
        ) {
          out.push({ kind: "args_delta", args: d.partial_json });
        }
        break;
      }
      case "content_block_stop":
        out.push({ kind: "block_end" });
        break;
      case "message_delta":
        if (e.delta && typeof e.delta.stop_reason === "string") {
          storedStopReason = e.delta.stop_reason;
        }
        break;
      case "message_stop":
        out.push({
          kind: "message_end",
          finish_reason: mapStopReason(storedStopReason),
        });
        break;
      case "ping":
      default:
        break;
    }
  }
  return out;
}
