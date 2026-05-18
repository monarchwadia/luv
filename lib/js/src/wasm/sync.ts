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
