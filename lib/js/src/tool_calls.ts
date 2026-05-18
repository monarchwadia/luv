// Pure functional utilities over the canonical luv Conversation for
// inspecting and resolving tool calls.
//
// Single-sourced in Zig: the conversation walk/rebuild now delegates to the
// wasm core over the codec boundary (see wasm/tool_calls_bridge.ts). The TS
// port logic was deleted after the differential test proved equivalence.
// Signatures are unchanged — consumers and their tests are untouched.
// `pendingToolCalls`' optional `filter` is a host closure (cannot cross the
// wasm boundary); the core returns all pending calls and the predicate is
// applied in TS by the bridge.

import type { Conversation, ToolCall, ToolResult } from "./types.ts";
import {
  pendingToolCalls as bridgePending,
  respondToToolCall as bridgeRespond,
} from "./wasm/tool_calls_bridge.ts";

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
  return bridgePending(conv, filter);
}

/**
 * Return a new conversation where the tool call with the given `callId`
 * has its `result` field set. If no call matches, a structurally-equal
 * conversation is returned (no mutation). Existing results are overwritten.
 */
export function respondToToolCall(
  conv: Conversation,
  callId: string,
  result: ToolResult,
): Conversation {
  return bridgeRespond(conv, callId, result);
}
