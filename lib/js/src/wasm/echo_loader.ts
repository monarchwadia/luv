// Stream C2 — minimal wasm loader exercising the batched effect ABI end to
// end from the host: luv_echo_start -> poll (effect batch) -> feed -> poll
// (done). Reuses exports.zig's luv_alloc/luv_free. Additive; unimported by
// the public surface. The production bootstrap (embedded bytes, browser) is
// Stream F2; this is the round-trip proof.

interface EchoExports {
  memory: WebAssembly.Memory;
  luv_alloc(len: number): number;
  luv_free(ptr: number, len: number): void;
  luv_echo_start(inPtr: number, inLen: number): number;
  luv_echo_poll(handle: number, outPtrCell: number, outLenCell: number): number;
  luv_echo_feed(handle: number, resPtr: number, resLen: number): number;
  luv_echo_destroy(handle: number): void;
}

export interface EchoWasm {
  echoRoundTrip(input: Uint8Array): Uint8Array;
}

export async function loadEcho(wasmBytes: BufferSource): Promise<EchoWasm> {
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {});
  const ex = instance.exports as unknown as EchoExports;

  // memory.buffer can detach on growth — always take a fresh view.
  const bytes = (): Uint8Array => new Uint8Array(ex.memory.buffer);
  const view = (): DataView => new DataView(ex.memory.buffer);
  const snapshot = (ptr: number, len: number): Uint8Array =>
    bytes().slice(ptr, ptr + len);

  function echoRoundTrip(input: Uint8Array): Uint8Array {
    let inPtr = 0;
    if (input.length > 0) {
      inPtr = ex.luv_alloc(input.length);
      if (inPtr === 0) throw new Error("luv_alloc failed");
      bytes().set(input, inPtr);
    }
    const handle = ex.luv_echo_start(inPtr, input.length);
    if (input.length > 0) ex.luv_free(inPtr, input.length);
    if (handle === 0) throw new Error("luv_echo_start failed");

    const cell = ex.luv_alloc(8);
    try {
      if (ex.luv_echo_poll(handle, cell, cell + 4) !== 0) throw new Error("poll #1");
      let frameLen = view().getUint32(cell + 4, true);
      let frame = snapshot(view().getUint32(cell, true), frameLen);
      ex.luv_free(view().getUint32(cell, true), frameLen);

      let fdv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (fdv.getUint8(0) !== 0) throw new Error("expected effects frame");
      const count = fdv.getUint32(1, true);
      const payloads: Uint8Array[] = [];
      let p = 5;
      for (let i = 0; i < count; i++) {
        const plen = fdv.getUint32(p + 1, true);
        payloads.push(frame.slice(p + 5, p + 5 + plen));
        p += 5 + plen;
      }

      // Echo: feed each effect's payload straight back.
      let size = 4;
      for (const pl of payloads) size += 4 + pl.length;
      const feed = new Uint8Array(size);
      const wdv = new DataView(feed.buffer);
      wdv.setUint32(0, payloads.length, true);
      let q = 4;
      for (const pl of payloads) {
        wdv.setUint32(q, pl.length, true);
        feed.set(pl, q + 4);
        q += 4 + pl.length;
      }
      const feedPtr = ex.luv_alloc(size);
      bytes().set(feed, feedPtr);
      if (ex.luv_echo_feed(handle, feedPtr, size) !== 0) throw new Error("feed");
      ex.luv_free(feedPtr, size);

      if (ex.luv_echo_poll(handle, cell, cell + 4) !== 0) throw new Error("poll #2");
      frameLen = view().getUint32(cell + 4, true);
      frame = snapshot(view().getUint32(cell, true), frameLen);
      ex.luv_free(view().getUint32(cell, true), frameLen);

      fdv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (fdv.getUint8(0) !== 1) throw new Error("expected done frame");
      const dlen = fdv.getUint32(1, true);
      return frame.slice(5, 5 + dlen);
    } finally {
      ex.luv_echo_destroy(handle);
      ex.luv_free(cell, 8);
    }
  }

  return { echoRoundTrip };
}
