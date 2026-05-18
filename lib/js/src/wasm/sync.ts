// Synchronous, eager wasm bootstrap (Stream F2).
//
// Instantiates the embedded wasm at module load with the SYNCHRONOUS
// constructors — no top-level await — so dependent functions
// (toOpenAI/fromOpenAI and future brick wrappers) stay synchronous and the
// public API is unchanged. Safari/Firefox/Node/Bun have no size limit;
// Chrome raised its main-thread cap to 8 MB in Chrome 115 (our wasm ~116 KB),
// so the effective Chrome floor is 115 (mid-2023).

import {
  encodeSendRequest,
  decodeReply,
  type CodecSendRequest,
  type CodecReply,
} from "../codec.ts";
import { wasmBytes } from "./embedded.generated.ts";

interface SyncExports {
  memory: WebAssembly.Memory;
  luv_alloc(len: number): number;
  luv_free(ptr: number, len: number): void;
  luv_build_request(i: number, l: number, a: number, b: number): number;
  luv_parse_reply(i: number, l: number, a: number, b: number): number;
  luv_decoder_new(): number;
  luv_decoder_free(handle: number): void;
  luv_decoder_feed(h: number, i: number, l: number, a: number, b: number): number;
  // Generic lookup for the per-brick (i,l,a,b)->i32 exports.
  [name: string]: unknown;
}

// Synchronous instantiation at module load (no await). Throws only on
// Chrome < 115 (4 KB cap) — practically nil due to forced auto-update.
const instance = new WebAssembly.Instance(
  new WebAssembly.Module(wasmBytes),
  {},
);
const ex = instance.exports as unknown as SyncExports;

const u8 = (): Uint8Array => new Uint8Array(ex.memory.buffer);
const dv = (): DataView => new DataView(ex.memory.buffer);

function invoke(
  fn: (i: number, l: number, a: number, b: number) => number,
  input: Uint8Array,
  what: string,
): Uint8Array {
  let inPtr = 0;
  if (input.length > 0) {
    inPtr = ex.luv_alloc(input.length);
    if (inPtr === 0) throw new Error("luv_alloc failed");
    u8().set(input, inPtr);
  }
  const cell = ex.luv_alloc(8);
  try {
    const status = fn(inPtr, input.length, cell, cell + 4);
    if (status !== 0) throw new Error(`${what} failed: status ${status}`);
    const outPtr = dv().getUint32(cell, true);
    const outLen = dv().getUint32(cell + 4, true);
    const out = u8().slice(outPtr, outPtr + outLen);
    ex.luv_free(outPtr, outLen);
    return out;
  } finally {
    if (input.length > 0) ex.luv_free(inPtr, input.length);
    ex.luv_free(cell, 8);
  }
}

const td = new TextDecoder();
const te = new TextEncoder();

/** Synchronous: CodecSendRequest -> OpenAI wire request JSON string. */
export function buildRequest(req: CodecSendRequest): string {
  return td.decode(
    invoke(
      (i, l, a, b) => ex.luv_build_request(i, l, a, b),
      encodeSendRequest(req),
      "luv_build_request",
    ),
  );
}

/** Synchronous: OpenAI wire response JSON -> decoded CodecReply. */
export function parseReply(wireResponseJson: string): CodecReply {
  return decodeReply(
    invoke(
      (i, l, a, b) => ex.luv_parse_reply(i, l, a, b),
      te.encode(wireResponseJson),
      "luv_parse_reply",
    ),
  );
}

/** Generic synchronous call to an (in,in_len,out_ptr,out_len)->i32 export.
 *  The shared low-level seam every per-brick bridge uses — bricks own their
 *  codec, not this file. */
export function callWasm(exportName: string, input: Uint8Array): Uint8Array {
  const fn = ex[exportName] as
    | ((i: number, l: number, a: number, b: number) => number)
    | undefined;
  if (typeof fn !== "function") {
    throw new Error(`wasm export not found: ${exportName}`);
  }
  return invoke((i, l, a, b) => fn(i, l, a, b), input, exportName);
}

// Streaming SSE decoder — stateful handle (for the sse_decoder brick).
export function decoderNew(): number {
  const h = ex.luv_decoder_new();
  if (h === 0) throw new Error("luv_decoder_new failed");
  return h;
}

export function decoderFree(handle: number): void {
  ex.luv_decoder_free(handle);
}

export function decoderFeed(handle: number, chunk: Uint8Array): Uint8Array {
  let inPtr = 0;
  if (chunk.length > 0) {
    inPtr = ex.luv_alloc(chunk.length);
    if (inPtr === 0) throw new Error("luv_alloc failed");
    u8().set(chunk, inPtr);
  }
  const cell = ex.luv_alloc(8);
  try {
    const st = ex.luv_decoder_feed(handle, inPtr, chunk.length, cell, cell + 4);
    if (st !== 0) throw new Error(`luv_decoder_feed failed: status ${st}`);
    const op = dv().getUint32(cell, true);
    const ol = dv().getUint32(cell + 4, true);
    const out = u8().slice(op, op + ol);
    ex.luv_free(op, ol);
    return out;
  } finally {
    if (chunk.length > 0) ex.luv_free(inPtr, chunk.length);
    ex.luv_free(cell, 8);
  }
}
