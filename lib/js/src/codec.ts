// Binary codec for the wasm ↔ host boundary — host side.
//
// Wire format mirrors core/src/wasm_abi/codec.zig (little-endian, u32
// length-prefixed UTF-8, Optional<T> = u8 present + T). The host ENCODES
// SendRequest (wasm decodes it) and DECODES Reply / EventBatch (wasm encodes
// them) — the complementary direction of codec.zig.
//
// Numeric-level on purpose: role/stopReason are the raw byte enums, matching
// the conformance corpus exactly. Mapping to string unions is a separate,
// higher layer. This module is the parity reference the generator must
// reproduce byte-for-byte (gated by codec_conformance.json).

export interface CodecToolResult {
  readonly ok: boolean;
  readonly content: string;
}

export interface CodecToolCall {
  readonly id: string;
  readonly name: string;
  /** Opaque JSON text — the codec never parses it. */
  readonly args: string;
  readonly result: CodecToolResult | null;
}

export interface CodecMessage {
  readonly role: number; // 0=system 1=user 2=assistant
  readonly text: string;
  readonly toolCalls: readonly CodecToolCall[];
}

export interface CodecTool {
  readonly name: string;
  readonly description: string;
  /** Opaque JSON Schema text — the codec never parses it. */
  readonly inputSchema: string;
}

export interface CodecSendRequest {
  readonly model: string;
  readonly messages: readonly CodecMessage[];
  readonly maxTokens: number | null;
  readonly temperature: number | null;
  readonly stream: boolean;
  readonly tools?: readonly CodecTool[];
}

export interface CodecUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface CodecReply {
  readonly role: number;
  readonly stopReason: number; // 0..5
  readonly text: string;
  readonly toolCalls: readonly CodecToolCall[];
  readonly usage: CodecUsage | null;
}

export type CodecEvent =
  | { readonly kind: 0; readonly role: number }
  | { readonly kind: 1; readonly delta: string }
  | { readonly kind: 2; readonly stopReason: number };

class Writer {
  private readonly buf: number[] = [];
  u8(v: number): void {
    this.buf.push(v & 0xff);
  }
  u32(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  f64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    for (const x of b) this.buf.push(x);
  }
  bytes(a: Uint8Array): void {
    for (const x of a) this.buf.push(x);
  }
  out(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

class Reader {
  private readonly dv: DataView;
  private pos = 0;
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(): number {
    return this.dv.getUint8(this.pos++);
  }
  u32(): number {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  slice(n: number): Uint8Array {
    const s = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export function encodeSendRequest(req: CodecSendRequest): Uint8Array {
  const w = new Writer();
  const model = utf8.encode(req.model);
  w.u32(model.length);
  w.bytes(model);
  w.u32(req.messages.length);
  const str = (s: string): void => {
    const b = utf8.encode(s);
    w.u32(b.length);
    w.bytes(b);
  };
  for (const m of req.messages) {
    w.u8(m.role);
    str(m.text);
    w.u32(m.toolCalls.length);
    for (const c of m.toolCalls) {
      str(c.id);
      str(c.name);
      str(c.args);
      if (c.result == null) {
        w.u8(0);
      } else {
        w.u8(1);
        w.u8(c.result.ok ? 1 : 0);
        str(c.result.content);
      }
    }
  }
  if (req.maxTokens == null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(req.maxTokens);
  }
  if (req.temperature == null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.f64(req.temperature);
  }
  w.u8(req.stream ? 1 : 0);

  const tools = req.tools ?? [];
  w.u32(tools.length);
  for (const t of tools) {
    str(t.name);
    str(t.description);
    str(t.inputSchema);
  }
  return w.out();
}

export function decodeReply(bytes: Uint8Array): CodecReply {
  const r = new Reader(bytes);
  const role = r.u8();
  const stopReason = r.u8();
  const text = utf8d.decode(r.slice(r.u32()));

  const rstr = (): string => utf8d.decode(r.slice(r.u32()));
  const tcCount = r.u32();
  const toolCalls: CodecToolCall[] = [];
  for (let i = 0; i < tcCount; i++) {
    const id = rstr();
    const name = rstr();
    const args = rstr();
    let result: CodecToolResult | null = null;
    if (r.u8() !== 0) {
      const ok = r.u8() !== 0;
      result = { ok, content: rstr() };
    }
    toolCalls.push({ id, name, args, result });
  }

  const usage: CodecUsage | null =
    r.u8() !== 0
      ? { prompt: r.u32(), completion: r.u32(), total: r.u32() }
      : null;

  return { role, stopReason, text, toolCalls, usage };
}

/** Inverse of decodeReply — encodes a Reply to feed the agent machine
 *  (mirrors core/src/wasm_abi/codec.zig decodeReply's wire). */
export function encodeReply(reply: CodecReply): Uint8Array {
  const w = new Writer();
  const str = (s: string): void => {
    const b = utf8.encode(s);
    w.u32(b.length);
    w.bytes(b);
  };
  w.u8(reply.role);
  w.u8(reply.stopReason);
  str(reply.text);
  w.u32(reply.toolCalls.length);
  for (const c of reply.toolCalls) {
    str(c.id);
    str(c.name);
    str(c.args);
    if (c.result == null) {
      w.u8(0);
    } else {
      w.u8(1);
      w.u8(c.result.ok ? 1 : 0);
      str(c.result.content);
    }
  }
  if (reply.usage == null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(reply.usage.prompt);
    w.u32(reply.usage.completion);
    w.u32(reply.usage.total);
  }
  return w.out();
}

export function decodeEvents(bytes: Uint8Array): CodecEvent[] {
  const r = new Reader(bytes);
  const count = r.u32();
  const events: CodecEvent[] = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    if (kind === 0) {
      events.push({ kind: 0, role: r.u8() });
    } else if (kind === 1) {
      const len = r.u32();
      events.push({ kind: 1, delta: utf8d.decode(r.slice(len)) });
    } else if (kind === 2) {
      events.push({ kind: 2, stopReason: r.u8() });
    } else {
      throw new Error(`codec: invalid event kind ${kind}`);
    }
  }
  return events;
}

// Standalone conversation wire (for the tool_calls brick). Mirrors
// core/src/wasm_abi/codec.zig decode/encodeConversation:
//   u32 msg_count; per msg: u8 role; u32 text_len; text;
//   u32 tc_count; per call: id,name,args (each u32-len+bytes);
//   u8 result_present; if 1: u8 ok; content (u32-len+bytes)

export function encodeConversation(
  messages: readonly CodecMessage[],
): Uint8Array {
  const w = new Writer();
  const str = (s: string): void => {
    const b = utf8.encode(s);
    w.u32(b.length);
    w.bytes(b);
  };
  w.u32(messages.length);
  for (const m of messages) {
    w.u8(m.role);
    str(m.text);
    w.u32(m.toolCalls.length);
    for (const c of m.toolCalls) {
      str(c.id);
      str(c.name);
      str(c.args);
      if (c.result == null) {
        w.u8(0);
      } else {
        w.u8(1);
        w.u8(c.result.ok ? 1 : 0);
        str(c.result.content);
      }
    }
  }
  return w.out();
}

export function decodeConversation(bytes: Uint8Array): CodecMessage[] {
  const r = new Reader(bytes);
  const rstr = (): string => utf8d.decode(r.slice(r.u32()));
  const count = r.u32();
  const messages: CodecMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = r.u8();
    const text = rstr();
    const tcCount = r.u32();
    const toolCalls: CodecToolCall[] = [];
    for (let j = 0; j < tcCount; j++) {
      const id = rstr();
      const name = rstr();
      const args = rstr();
      let result: CodecToolResult | null = null;
      if (r.u8() !== 0) {
        const ok = r.u8() !== 0;
        result = { ok, content: rstr() };
      }
      toolCalls.push({ id, name, args, result });
    }
    messages.push({ role, text, toolCalls });
  }
  return messages;
}
