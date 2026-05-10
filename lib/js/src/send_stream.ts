// Streaming send: build wire JSON via the morphism, fetch, drain SSE
// through the pure-TS decoder, expose events.

import { classifyError, HttpError } from "./errors.ts";
import { toOpenAI } from "./morphism.ts";
import { SseDecoder } from "./sse_decoder.ts";
import { type SendInternalOptions } from "./send.ts";
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
      w({ value: undefined, done: true });
    }
  }

  const donePromise: Promise<Reply> = (async () => {
    const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);
    await drainStream(opts, internalCtl, fetchImpl, pushEvent);
  })().then(
    (): Reply => {
      finishProducer(null);
      const stopReason = finalStopReason ?? "other";
      if (assistantRole !== "assistant") {
        throw new Error(`sendStream: unexpected role from stream: ${assistantRole}`);
      }
      return {
        message: { role: "assistant", text: assembledText },
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

  donePromise.catch(() => {});

  const stream: LuvStream = {
    [Symbol.asyncIterator]: () => iterator,
    cancel(): void {
      internalCtl.abort();
    },
    get aborted(): boolean {
      return internalCtl.signal.aborted;
    },
    done: donePromise,
    text(): AsyncIterable<string> {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === "text") yield event.delta;
          }
        },
      };
    },
  };
  return stream;
}

async function drainStream(
  opts: SendStreamOptions,
  ctl: AbortController,
  fetchImpl: typeof fetch,
  emit: (e: Event) => void,
): Promise<void> {
  const wire = toOpenAI({
    conversation: opts.conversation,
    model: opts.model,
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    stream: true,
  });

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const url = `${baseUrl}/v1/chat/completions`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(wire),
    signal: ctl.signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw classifyError(res.status, errBody, res.headers.get("retry-after"));
  }
  if (!res.body) {
    throw new HttpError(res.status, "no response body");
  }

  const decoder = new SseDecoder();
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ctl.signal.aborted) throw new DOMException("aborted", "AbortError");
      const events = decoder.feed(value);
      for (const e of events) emit(e);
    }
  } finally {
    reader.releaseLock();
  }
}
