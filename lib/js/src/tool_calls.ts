// Pure functional utilities over the canonical luv Conversation for
// inspecting and resolving tool calls. Mirrors core/src/morphisms/luv/tool_calls.zig.
//
// The conversation array is the only state. A tool call is "pending" iff its
// `result` is undefined; resolving it produces a new conversation where that
// call carries its result.

import type { Conversation, Message, ToolCall, ToolResult } from "./types.ts";

/**
 * Find every tool call in the conversation whose `result` is undefined
 * (i.e. still pending), optionally narrowed by a predicate.
 *
 * Pure function; the input conversation is not touched.
 */
export function pendingToolCalls(
  conv: Conversation,
  filter?: (c: ToolCall) => boolean,
): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of conv) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      if (c.result !== undefined) continue;
      if (filter && !filter(c)) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Return a new conversation where the tool call with the given `callId`
 * has its `result` field set. If no call matches, the input is returned
 * with structural sharing (no mutation). Existing results are overwritten.
 */
export function respondToToolCall(
  conv: Conversation,
  callId: string,
  result: ToolResult,
): Conversation {
  return conv.map((m: Message): Message => {
    if (m.role !== "assistant" || !m.toolCalls) return m;
    if (!m.toolCalls.some((c) => c.id === callId)) return m;
    return {
      ...m,
      toolCalls: m.toolCalls.map((c) =>
        c.id === callId ? { ...c, result } : c,
      ),
    };
  });
}
