// Wasm loader. The wasm binary is embedded as base64 in `wasm_inline.ts`
// (auto-generated at build time), so the bundled module is fully self-contained
// — no separate .wasm file to fetch in the browser, no asset-loader plugin in
// the consumer's bundler. Single import, works everywhere.

import { wasmBase64 } from "./wasm_inline.ts";

export interface LuvWasm {
  readonly memory: WebAssembly.Memory;
  luv_alloc(len: number): number;
  luv_free(ptr: number, len: number): void;
  luv_build_request(in_ptr: number, in_len: number, out_ptr_out: number, out_len_out: number): number;
  luv_parse_reply(in_ptr: number, in_len: number, out_ptr_out: number, out_len_out: number): number;
  luv_decoder_new(): number;
  luv_decoder_free(handle: number): void;
  luv_decoder_feed(
    handle: number,
    in_ptr: number,
    in_len: number,
    out_ptr_out: number,
    out_len_out: number,
  ): number;
}

export interface InitOptions {
  /**
   * Override the embedded wasm with bytes you load yourself. Useful if you
   * want to pin a different wasm version or load via streaming compilation.
   */
  wasm?: BufferSource;
}

let cached: Promise<LuvWasm> | null = null;

/** Returns the loaded wasm exports. Idempotent — instantiates once per process. */
export function getWasm(opts?: InitOptions): Promise<LuvWasm> {
  if (cached) return cached;
  cached = (async () => {
    const bytes = opts?.wasm ?? base64ToBytes(wasmBase64);
    // The (BufferSource, importObject) overload returns
    // WebAssemblyInstantiatedSource = { module, instance }; the (Module, ...)
    // overload returns Instance directly. Disambiguate via cast.
    const result = (await WebAssembly.instantiate(
      bytes as BufferSource,
      {},
    )) as WebAssembly.WebAssemblyInstantiatedSource;
    return result.instance.exports as unknown as LuvWasm;
  })();
  return cached;
}

/** For tests — drop the cached instance so the next getWasm() reloads. */
export function _resetWasmForTests(): void {
  cached = null;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // `atob` is universal in Bun, Node 16+, Deno, and all modern browsers.
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
