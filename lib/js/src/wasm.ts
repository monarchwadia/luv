// Wasm loader. Lazy-instantiates once per process; works in Bun, Node 22+,
// and bundled browsers (Bun bundler, esbuild, Vite, webpack 5+ all
// understand `new URL(..., import.meta.url)` for asset resolution).

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
   * Pre-loaded wasm bytes. Provide this in environments that can't fetch the
   * wasm via `import.meta.url` (older Node, restricted CSP browsers, etc.).
   */
  wasm?: BufferSource;
}

let cached: Promise<LuvWasm> | null = null;

/** Returns the loaded wasm exports. Idempotent — instantiates once per process. */
export function getWasm(opts?: InitOptions): Promise<LuvWasm> {
  if (cached) return cached;
  cached = (async () => {
    const bytes = opts?.wasm ?? (await loadDefaultWasm());
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports as unknown as LuvWasm;
  })();
  return cached;
}

/** For tests — drop the cached instance so the next getWasm() reloads. */
export function _resetWasmForTests(): void {
  cached = null;
}

async function loadDefaultWasm(): Promise<ArrayBuffer> {
  const url = new URL("../wasm/luv_core.wasm", import.meta.url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`luv-js: failed to load wasm at ${url.href}: HTTP ${res.status}`);
  }
  return res.arrayBuffer();
}
