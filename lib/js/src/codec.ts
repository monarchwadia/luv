// Binary codec mirroring core/src/wasm_abi/codec.zig.
// All multi-byte integers are little-endian.

import type {
  Event,
  Reply,
  Role,
  SendOptions,
  StopReason,
} from "./types.ts";

const ROLE_TO_BYTE: Readonly<Record<Role, number>> = {
  system: 0,
  user: 1,
  assistant: 2,
};

const BYTE_TO_ROLE: Readonly<Record<number, Role>> = {
  0: "system",
  1: "user",
  2: "assistant",
};

const STOP_REASON_TO_BYTE: Readonly<Record<StopReason, number>> = {
  end_turn: 0,
  max_tokens: 1,
  content_filter: 2,
  stop_sequence: 3,
  tool_use: 4,
  other: 5,
};

const BYTE_TO_STOP_REASON: Readonly<Record<number, StopReason>> = {
  0: "end_turn",
  1: "max_tokens",
  2: "content_filter",
  3: "stop_sequence",
  4: "tool_use",
  5: "other",
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class Writer {
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.pos + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf);
      this.buf = next;
    }
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.pos] = v & 0xff;
    this.buf[this.pos + 1] = (v >>> 8) & 0xff;
    this.buf[this.pos + 2] = (v >>> 16) & 0xff;
    this.buf[this.pos + 3] = (v >>> 24) & 0xff;
    this.pos += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  /** Length-prefixed (u32) UTF-8 string. */
  lpString(s: string): void {
    const encoded = utf8Encoder.encode(s);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  constructor(private readonly bytes: Uint8Array, private pos = 0) {}

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new Error(
        `codec: truncated input (need ${n} bytes at offset ${this.pos}, have ${this.bytes.length - this.pos})`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  u32(): number {
    this.need(4);
    const v =
      this.bytes[this.pos]! |
      (this.bytes[this.pos + 1]! << 8) |
      (this.bytes[this.pos + 2]! << 16) |
      (this.bytes[this.pos + 3]! << 24);
    this.pos += 4;
    return v >>> 0;
  }

  slice(len: number): Uint8Array {
    this.need(len);
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  lpString(): string {
    const len = this.u32();
    return utf8Decoder.decode(this.slice(len));
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }
}

function roleToByte(r: Role): number {
  const v = ROLE_TO_BYTE[r];
  if (v === undefined) throw new Error(`codec: unknown role ${r}`);
  return v;
}

function byteToRole(b: number): Role {
  const v = BYTE_TO_ROLE[b];
  if (v === undefined) throw new Error(`codec: unknown role byte ${b}`);
  return v;
}

function byteToStopReason(b: number): StopReason {
  const v = BYTE_TO_STOP_REASON[b];
  if (v === undefined) throw new Error(`codec: unknown stop_reason byte ${b}`);
  return v;
}

/** Encode a SendOptions request as the wire bytes the wasm side expects. */
export function encodeSendRequest(opts: SendOptions): Uint8Array {
  const w = new Writer();
  w.lpString(opts.model);
  w.u32(opts.conversation.length);
  for (const m of opts.conversation) {
    w.u8(roleToByte(m.role));
    w.lpString(m.text);
  }
  if (opts.maxTokens === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(opts.maxTokens);
  }
  if (opts.temperature === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.f32(opts.temperature);
  }
  // `stream` is not part of the public SendOptions — sendStream sets it
  // before calling this function. For non-streaming send(), it stays false.
  w.u8(0);
  return w.finish();
}

/** Variant used by sendStream to flip the `stream` flag without exposing it publicly. */
export function encodeSendRequestStreaming(opts: SendOptions): Uint8Array {
  const bytes = encodeSendRequest(opts);
  bytes[bytes.length - 1] = 1;
  return bytes;
}

/** Decode a wasm-emitted Reply byte buffer into the canonical Reply object. */
export function decodeReply(bytes: Uint8Array): Reply {
  const r = new Reader(bytes);
  const role = byteToRole(r.u8());
  const stopReason = byteToStopReason(r.u8());
  const text = r.lpString();
  return { message: { role, text }, stopReason };
}

/** Decode a wasm-emitted EventBatch into an array of canonical Events. */
export function decodeEvents(bytes: Uint8Array): Event[] {
  const r = new Reader(bytes);
  const count = r.u32();
  const out: Event[] = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    if (kind === 0) {
      out.push({ type: "start", role: byteToRole(r.u8()) });
    } else if (kind === 1) {
      out.push({ type: "text", delta: r.lpString() });
    } else if (kind === 2) {
      out.push({ type: "stop", stopReason: byteToStopReason(r.u8()) });
    } else {
      throw new Error(`codec: unknown event kind ${kind}`);
    }
  }
  return out;
}

// Internals exported for tests
export const _internals = {
  ROLE_TO_BYTE,
  BYTE_TO_ROLE,
  STOP_REASON_TO_BYTE,
  BYTE_TO_STOP_REASON,
};
