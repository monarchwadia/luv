// Ergonomic <-> codec bridge for the tool_calls brick over the sync wasm
// path. pendingToolCalls' optional `filter` is a host closure — it cannot
// cross the wasm boundary, so the Zig core returns ALL pending calls and the
// predicate is applied here in TS (the only TS-side logic).

import { callWasm } from "./sync.ts";
import {
  encodeConversation,
  decodeConversation,
  type CodecMessage,
  type CodecToolCall,
} from "../codec.ts";
import type {
  Conversation,
  Message,
  ToolCall,
  ToolResult,
} from "../types.ts";

const ROLE: Record<"system" | "user" | "assistant", number> = {
  system: 0,
  user: 1,
  assistant: 2,
};
const ROLE_NAME = ["system", "user", "assistant"] as const;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function toCodecToolCall(c: ToolCall): CodecToolCall {
  return {
    id: c.id,
    name: c.name,
    args: JSON.stringify(c.arguments),
    result:
      c.result === undefined
        ? null
        : c.result.ok
          ? { ok: true, content: c.result.content }
          : { ok: false, content: c.result.error },
  };
}

function toCodecMessages(conv: Conversation): CodecMessage[] {
  return conv.map((m) => ({
    role: ROLE[m.role],
    text: m.text,
    toolCalls:
      m.role === "assistant" && m.toolCalls
        ? m.toolCalls.map(toCodecToolCall)
        : [],
  }));
}

function fromCodecToolCall(c: CodecToolCall): ToolCall {
  const base: ToolCall = {
    id: c.id,
    name: c.name,
    arguments: JSON.parse(c.args) as unknown,
  };
  if (c.result === null) return base;
  return {
    ...base,
    result: c.result.ok
      ? { ok: true, content: c.result.content }
      : { ok: false, error: c.result.content },
  };
}

function fromCodecMessages(msgs: CodecMessage[]): Message[] {
  return msgs.map((m): Message => {
    const role = ROLE_NAME[m.role] ?? "user";
    if (role === "assistant") {
      // Omit toolCalls when empty so the shape matches the TS port (which
      // has no toolCalls key on a plain assistant message).
      return m.toolCalls.length > 0
        ? { role, text: m.text, toolCalls: m.toolCalls.map(fromCodecToolCall) }
        : { role, text: m.text };
    }
    return { role, text: m.text };
  });
}

export function pendingToolCalls(
  conv: Conversation,
  filter?: (c: ToolCall) => boolean,
): ToolCall[] {
  const out = callWasm(
    "luv_pending_tool_calls",
    encodeConversation(toCodecMessages(conv)),
  );
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let pos = 0;
  const count = dv.getUint32(pos, true);
  pos += 4;
  const rstr = (): string => {
    const len = dv.getUint32(pos, true);
    pos += 4;
    const s = utf8d.decode(out.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const calls: ToolCall[] = [];
  for (let i = 0; i < count; i++) {
    const id = rstr();
    const name = rstr();
    const args = rstr();
    calls.push({ id, name, arguments: JSON.parse(args) as unknown });
  }
  return filter ? calls.filter(filter) : calls;
}

export function respondToToolCall(
  conv: Conversation,
  callId: string,
  result: ToolResult,
): Conversation {
  const convBytes = encodeConversation(toCodecMessages(conv));
  const idBytes = utf8.encode(callId);
  const content = result.ok ? result.content : result.error;
  const contentBytes = utf8.encode(content);

  const total = 4 + convBytes.length + 4 + idBytes.length + 1 + 4 + contentBytes.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let pos = 0;
  dv.setUint32(pos, convBytes.length, true);
  pos += 4;
  buf.set(convBytes, pos);
  pos += convBytes.length;
  dv.setUint32(pos, idBytes.length, true);
  pos += 4;
  buf.set(idBytes, pos);
  pos += idBytes.length;
  buf[pos] = result.ok ? 1 : 0;
  pos += 1;
  dv.setUint32(pos, contentBytes.length, true);
  pos += 4;
  buf.set(contentBytes, pos);

  const out = callWasm("luv_respond_tool_call", buf);
  return fromCodecMessages(decodeConversation(out));
}
