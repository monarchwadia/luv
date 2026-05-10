// Low-level wasm-call helpers. Allocates input + output-slot buffers, calls
// an export, reads back the (ptr, len) pair the wasm wrote into the slots,
// copies the result into a fresh Uint8Array, and frees the wasm-side buffers.

import type { LuvWasm } from "./wasm.ts";

export class WasmCallError extends Error {
  readonly status: number;
  constructor(fnName: string, status: number) {
    super(`luv-js: ${fnName} failed with status ${status} (${describeStatus(status)})`);
    this.status = status;
    this.name = "WasmCallError";
  }
}

function describeStatus(s: number): string {
  switch (s) {
    case -1: return "out of memory";
    case -2: return "malformed input";
    case -3: return "malformed openai response JSON";
    case -4: return "no choices in response";
    case -5: return "sse decode error";
    default: return "unknown";
  }
}

const SLOT_BYTES = 8; // two u32 slots: out_ptr_out, out_len_out

/**
 * Common pattern: copy `input` into wasm memory, allocate output slots, call
 * `fn(in_ptr, in_len, out_ptr_out, out_len_out)`, then copy the wasm-emitted
 * output bytes back into JS-owned memory and free everything wasm-side.
 */
export function callWithBytesInOut(
  wasm: LuvWasm,
  fnName: string,
  fn: (inPtr: number, inLen: number, outPtrOut: number, outLenOut: number) => number,
  input: Uint8Array,
): Uint8Array {
  const inPtr = wasm.luv_alloc(input.length);
  if (inPtr === 0 && input.length > 0) throw new WasmCallError("luv_alloc", -1);
  const slotsPtr = wasm.luv_alloc(SLOT_BYTES);
  if (slotsPtr === 0) {
    wasm.luv_free(inPtr, input.length);
    throw new WasmCallError("luv_alloc", -1);
  }

  try {
    if (input.length > 0) {
      new Uint8Array(wasm.memory.buffer, inPtr, input.length).set(input);
    }
    // Zero the slots before the call.
    new Uint8Array(wasm.memory.buffer, slotsPtr, SLOT_BYTES).fill(0);

    const status = fn(inPtr, input.length, slotsPtr, slotsPtr + 4);
    if (status !== 0) throw new WasmCallError(fnName, status);

    const dv = new DataView(wasm.memory.buffer, slotsPtr, SLOT_BYTES);
    const outPtr = dv.getUint32(0, true);
    const outLen = dv.getUint32(4, true);

    // Copy out before freeing wasm-side buffer (and before any potential mem grow).
    const result = new Uint8Array(outLen);
    if (outLen > 0) {
      result.set(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
      wasm.luv_free(outPtr, outLen);
    }
    return result;
  } finally {
    wasm.luv_free(slotsPtr, SLOT_BYTES);
    wasm.luv_free(inPtr, input.length);
  }
}
