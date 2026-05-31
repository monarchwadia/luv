import type {
  Block,
  FinishReason,
  Reply,
  Usage,
  StreamEventReply,
  StreamReply,
} from "./types.js";

// consume_luv_stream_reply : Stream<Reply> -> Reply
// Collapses a well-formed Stream<Reply> into the Reply it represents.
export function consume_luv_stream_reply(stream: StreamReply): Reply {
  let finishReason: FinishReason = "end_turn";
  let usage: Usage | null = null;
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const evt of stream) {
    switch (evt.kind) {
      case "message_start":
        break;
      case "block_start": {
        // Append a fresh copy of the initial block to content.
        const b = evt.block;
        if (b.kind === "text") {
          current = { kind: "text", text: b.text };
        } else if (b.kind === "tool_call") {
          current = { kind: "tool_call", id: b.id, name: b.name, args: b.args };
        } else if (b.kind === "tool_result") {
          current = { kind: "tool_result", call_id: b.call_id, text: b.text };
        } else {
          current = {
            kind: "error",
            category: b.category,
            message: b.message,
            details: b.details,
          };
        }
        blocks.push(current);
        break;
      }
      case "text_delta":
        if (current && current.kind === "text") {
          current.text += evt.text;
        }
        break;
      case "args_delta":
        if (current && current.kind === "tool_call") {
          current.args += evt.args;
        }
        break;
      case "block_end":
        current = null;
        break;
      case "message_end":
        finishReason = evt.finish_reason;
        usage = evt.usage ?? null;
        break;
    }
  }

  return {
    message: { role: "assistant", content: blocks },
    finish_reason: finishReason,
    usage,
  };
}

// produce_luv_stream_reply : Reply -> Stream<Reply>
// Lifts a Reply into the canonical singleton stream that consumes back
// to it. Always emits exactly one delta per block (even if empty).
export function produce_luv_stream_reply(reply: Reply): StreamReply {
  const events: StreamEventReply[] = [];
  events.push({ kind: "message_start" });

  for (const block of reply.message.content) {
    if (block.kind === "text") {
      events.push({
        kind: "block_start",
        block: { kind: "text", text: "" },
      });
      events.push({ kind: "text_delta", text: block.text });
      events.push({ kind: "block_end" });
    } else if (block.kind === "tool_call") {
      events.push({
        kind: "block_start",
        block: {
          kind: "tool_call",
          id: block.id,
          name: block.name,
          args: "",
        },
      });
      events.push({ kind: "args_delta", args: block.args });
      events.push({ kind: "block_end" });
    } else if (block.kind === "error") {
      events.push({ kind: "block_start", block });
      events.push({ kind: "block_end" });
    }
    // tool_result blocks don't appear in Stream<Reply> (assistant-only).
  }

  events.push({
    kind: "message_end",
    finish_reason: reply.finish_reason,
    usage: reply.usage ?? null,
  });
  return events;
}
