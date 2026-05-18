// Production wasm loader + ergonomic↔codec bridge.
//
// Wraps the real exports (luv_build_request / luv_parse_reply) over the
// codec boundary: host encodes a CodecSendRequest, wasm builds the OpenAI
// wire JSON; host hands wasm an OpenAI response JSON, wasm returns a codec
// Reply. JSON only ever exists on the host or as opaque wire text — never
// parsed inside the codec. The production bootstrap (embedded bytes,
// browser) is Stream F2; this is the Node/Bun loader + the bridge.

import {
  encodeSendRequest,
  decodeReply,
  type CodecSendRequest,
  type CodecReply,
} from "../codec.ts";

interface LoaderExports {
  memory: WebAssembly.Memory;
  luv_alloc(len: number): number;
  luv_free(ptr: number, len: number): void;
  luv_build_request(i: number, l: number, a: number, b: number): number;
  luv_parse_reply(i: number, l: number, a: number, b: number): number;
}

export interface LuvWasm {
  /** CodecSendRequest -> OpenAI wire request JSON (string). */
  buildRequest(req: CodecSendRequest): string;
  /** OpenAI wire response JSON -> decoded CodecReply. */
  parseReply(wireResponseJson: string): CodecReply;
}

export async function loadLuv(wasmBytes: BufferSource): Promise<LuvWasm> {
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {});
  const ex = instance.exports as unknown as LoaderExports;

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

  return {
    buildRequest(req: CodecSendRequest): string {
      const out = invoke(
        (i, l, a, b) => ex.luv_build_request(i, l, a, b),
        encodeSendRequest(req),
        "luv_build_request",
      );
      return td.decode(out);
    },
    parseReply(wireResponseJson: string): CodecReply {
      const out = invoke(
        (i, l, a, b) => ex.luv_parse_reply(i, l, a, b),
        te.encode(wireResponseJson),
        "luv_parse_reply",
      );
      return decodeReply(out);
    },
  };
}
