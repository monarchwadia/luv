// Streaming send: feed SSE chunks through the wasm decoder, expose events.
// Same wasm module as send(); separate code path for the body draining.

import { decodeEvents, encodeSendRequestStreaming } from "./codec.ts";
import { callWithBytesInOut, WasmCallError } from "./bridge.ts";
import { getWasm, type LuvWasm } from "./wasm.ts";
import { HttpError, type SendInternalOptions } from "./send.ts";
import type {
  Event,
  LuvStream,
  Reply,
  Role,
  SendStreamOptions,
  StopReason,
} from "./types.ts";

/**
 * Open a streaming chat completion. The returned LuvStream supports any
 * combination of: async iteration, awaiting `.done`, hooks via opts, and
 * cancellation via `.cancel()` or an external AbortSignal.
 */
export function sendStream(
  opts: SendStreamOptions,
  internal?: SendInternalOptions,
): LuvStream {
  const internalCtl = new AbortController();
  // Bridge external signal → our internal controller.
  if (opts.signal) {
    if (opts.signal.aborted) internalCtl.abort();
    else opts.signal.addEventListener("abort", () => internalCtl.abort(), { once: true });
  }

  const eventQueue: Event[] = [];
  const waiters: Array<(v: IteratorResult<Event>) => void> = [];
  let producerDone = false;
  let producerError: Error | null = null;
  let assembledText = "";
  let finalStopReason: StopReason | null = null;
  let assistantRole: Role = "assistant";

  function pushEvent(e: Event): void {
    if (e.type === "start") {
      assistantRole = e.role;
      opts.onStart?.(e.role);
    } else if (e.type === "text") {
      assembledText += e.delta;
      opts.onDelta?.(e.delta);
    } else if (e.type === "stop") {
      finalStopReason = e.stopReason;
      opts.onStop?.(e.stopReason);
    }
    const w = waiters.shift();
    if (w) w({ value: e, done: false });
    else eventQueue.push(e);
  }

  function finishProducer(err: Error | null): void {
    if (producerDone) return;
    producerDone = true;
    producerError = err;
    if (err) opts.onError?.(err);
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      if (err) w({ value: undefined, done: true });
      else w({ value: undefined, done: true });
    }
  }

  const donePromise: Promise<Reply> = (async () => {
    const wasm = await getWasm(internal);
    const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);
    const decoderHandle = wasm.luv_decoder_new();
    if (decoderHandle === 0) throw new WasmCallError("luv_decoder_new", -1);

    try {
      await drainStream(opts, internalCtl, fetchImpl, wasm, decoderHandle, pushEvent);
    } finally {
      wasm.luv_decoder_free(decoderHandle);
    }
  })().then(
    () => {
      finishProducer(null);
      const stopReason = finalStopReason ?? "other";
      return {
        message: { role: assistantRole, text: assembledText },
        stopReason,
      };
    },
    (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      finishProducer(e);
      throw e;
    },
  );

  const iterator: AsyncIterator<Event> = {
    next(): Promise<IteratorResult<Event>> {
      if (eventQueue.length > 0) {
        return Promise.resolve({ value: eventQueue.shift()!, done: false });
      }
      if (producerDone) {
        if (producerError) return Promise.reject(producerError);
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    async return(): Promise<IteratorResult<Event>> {
      internalCtl.abort();
      return { value: undefined, done: true };
    },
  };

  // Suppress unhandled-rejection if the consumer never awaits .done.
  donePromise.catch(() => {});

  return {
    [Symbol.asyncIterator]: () => iterator,
    cancel(): void {
      internalCtl.abort();
    },
    get aborted(): boolean {
      return internalCtl.signal.aborted;
    },
    done: donePromise,
  };
}

async function drainStream(
  opts: SendStreamOptions,
  ctl: AbortController,
  fetchImpl: typeof fetch,
  wasm: LuvWasm,
  decoderHandle: number,
  emit: (e: Event) => void,
): Promise<void> {
  const requestBytes = encodeSendRequestStreaming(opts);
  const wireBytes = callWithBytesInOut(
    wasm,
    "luv_build_request",
    wasm.luv_build_request,
    requestBytes,
  );

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const url = `${baseUrl}/v1/chat/completions`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: wireBytes,
    signal: ctl.signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new HttpError(res.status, errBody);
  }
  if (!res.body) {
    throw new HttpError(res.status, "no response body");
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ctl.signal.aborted) throw new DOMException("aborted", "AbortError");
      const events = feedDecoder(wasm, decoderHandle, value);
      for (const e of events) emit(e);
    }
  } finally {
    reader.releaseLock();
  }
}

function feedDecoder(wasm: LuvWasm, handle: number, chunk: Uint8Array): Event[] {
  const eventBytes = callWithBytesInOut(
    wasm,
    "luv_decoder_feed",
    (inPtr, inLen, outPtrOut, outLenOut) =>
      wasm.luv_decoder_feed(handle, inPtr, inLen, outPtrOut, outLenOut),
    chunk,
  );
  return decodeEvents(eventBytes);
}
