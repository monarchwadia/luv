import type {
  Block,
  Conversation,
  FinishReason,
  Reply,
  StreamReply,
  StreamEventReply,
} from "../types.ts";

export interface OpenAIRequestOptions {
  model: string;
  stream?: boolean;
  tools?: unknown[];
}

// luv_conversation_to_openai_request
// Maps a luv Conversation (walked linearly in array order) plus per-call
// options into an OpenAI Chat Completions request body.
export function luv_conversation_to_openai_request(
  conv: Conversation,
  opts: OpenAIRequestOptions,
): unknown {
  const messages: unknown[] = [];

  for (const node of conv.nodes) {
    const m = node.message;
    if (m.role === "system") {
      const text = concatTextBlocks(m.content);
      messages.push({ role: "system", content: text });
    } else if (m.role === "user") {
      const onlyToolResults = m.content.every((b) => b.kind === "tool_result");
      const onlyText = m.content.every((b) => b.kind === "text");

      if (onlyText) {
        messages.push({ role: "user", content: concatTextBlocks(m.content) });
      } else if (onlyToolResults) {
        for (const b of m.content) {
          if (b.kind === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: b.call_id,
              content: b.text,
            });
          }
        }
      } else {
        // Mixed: emit in block order, one OpenAI message per block.
        for (const b of m.content) {
          if (b.kind === "text") {
            messages.push({ role: "user", content: b.text });
          } else if (b.kind === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: b.call_id,
              content: b.text,
            });
          }
        }
      }
    } else if (m.role === "assistant") {
      const textPieces: string[] = [];
      const toolCalls: unknown[] = [];
      for (const b of m.content) {
        if (b.kind === "text") textPieces.push(b.text);
        else if (b.kind === "tool_call") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: b.args },
          });
        }
      }

      // Canonical key order: role, content, [tool_calls].
      // When there are tool_calls, content is null (per OpenAI's convention
      // and the morphism's field mapping).
      const out: Record<string, unknown> = {
        role: "assistant",
        content: textPieces.length > 0 ? textPieces.join("") : null,
      };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
    }
  }

  // Canonical key order for Request: model, messages, [stream], [tools].
  const req: Record<string, unknown> = {
    model: opts.model,
    messages,
  };
  if (opts.stream !== undefined) req.stream = opts.stream;
  if (opts.tools !== undefined) req.tools = opts.tools;
  return req;
}

function concatTextBlocks(content: Block[]): string {
  return content
    .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("");
}

// openai_response_to_luv_reply
export function openai_response_to_luv_reply(resp: unknown): Reply {
  const r = resp as { choices: Array<{ message: any; finish_reason: string }> };
  const choice = r.choices[0];
  const msg = choice.message;
  const blocks: Block[] = [];

  if (typeof msg.content === "string") {
    blocks.push({ kind: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        kind: "tool_call",
        id: tc.id,
        name: tc.function.name,
        args: tc.function.arguments,
      });
    }
  }

  return {
    message: { role: "assistant", content: blocks },
    finish_reason: mapFinishReason(choice.finish_reason),
  };
}

function mapFinishReason(r: string): FinishReason {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// openai_stream_to_luv_stream
// Consumes a sequence of OpenAI streaming chunks and emits luv stream
// events. Stateful: tracks which kind of block (if any) is currently
// open so deltas are tagged correctly and block boundaries fire.
export function openai_stream_to_luv_stream(chunks: unknown[]): StreamReply {
  const events: StreamEventReply[] = [];
  let blockOpen: "text" | "tool_call" | null = null;
  let messageStartEmitted = false;

  for (const chunk of chunks) {
    const c = chunk as {
      choices: Array<{
        delta: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason: string | null;
      }>;
    };
    const choice = c.choices[0];
    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    if (delta.role === "assistant" && !messageStartEmitted) {
      events.push({ kind: "message_start" });
      messageStartEmitted = true;
    }

    // Tool call openings/continuations.
    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls) {
        if (tcDelta.id !== undefined) {
          // First chunk for this tool_call slot: close any text block
          // and open a new tool_call block.
          if (blockOpen === "text") {
            events.push({ kind: "block_end" });
            blockOpen = null;
          }
          events.push({
            kind: "block_start",
            block: {
              kind: "tool_call",
              id: tcDelta.id,
              name: tcDelta.function?.name ?? "",
              args: "",
            },
          });
          blockOpen = "tool_call";
          // Emit initial args_delta only if the first chunk carried any.
          const initialArgs = tcDelta.function?.arguments;
          if (typeof initialArgs === "string" && initialArgs.length > 0) {
            events.push({ kind: "args_delta", args: initialArgs });
          }
        } else if (
          tcDelta.function?.arguments !== undefined &&
          tcDelta.function.arguments !== ""
        ) {
          events.push({ kind: "args_delta", args: tcDelta.function.arguments });
        }
      }
    }

    // Text content deltas.
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (blockOpen !== "text") {
        if (blockOpen === "tool_call") {
          events.push({ kind: "block_end" });
        }
        events.push({
          kind: "block_start",
          block: { kind: "text", text: "" },
        });
        blockOpen = "text";
      }
      events.push({ kind: "text_delta", text: delta.content });
    }

    // Finish marker chunk.
    if (finishReason !== null && finishReason !== undefined) {
      if (blockOpen !== null) {
        events.push({ kind: "block_end" });
        blockOpen = null;
      }
      events.push({
        kind: "message_end",
        finish_reason: mapFinishReason(finishReason),
      });
    }
  }

  return events;
}
