// rateLimit — block calls so they don't exceed N requests per second.
// Simple sliding-window queue.

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface RateLimitOptions {
  /** Maximum requests per second. */
  readonly rps: number;
}

/** Wrap a Provider to throttle outgoing calls to at most `rps` per second. */
export function rateLimit(provider: Provider, opts: RateLimitOptions): Provider {
  const minIntervalMs = 1000 / opts.rps;
  let nextAvailableAt = 0;

  function reserveSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextAvailableAt);
    nextAvailableAt = slot + minIntervalMs;
    const wait = slot - now;
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, wait));
  }

  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      await reserveSlot();
      return provider.send(req);
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      // For streaming we delay the underlying send via the stream's own
      // pipeline. We reserve immediately and the stream waits for our promise.
      // Simple approach: reserve synchronously, return the stream — if the
      // reserve takes time the stream's body fetch is delayed by that promise.
      // We achieve this by returning a wrapper that defers .done.
      const slotPromise = reserveSlot();
      let inner: LuvStream | null = null;
      const startInner = (): LuvStream => {
        if (inner) return inner;
        inner = provider.sendStream(req);
        return inner;
      };
      const donePromise = (async () => {
        await slotPromise;
        return startInner().done;
      })();

      return {
        async *[Symbol.asyncIterator]() {
          await slotPromise;
          for await (const e of startInner()) yield e;
        },
        cancel(): void {
          if (inner) inner.cancel();
        },
        get aborted(): boolean {
          return inner?.aborted ?? false;
        },
        done: donePromise,
        text(): AsyncIterable<string> {
          const self = this;
          return {
            async *[Symbol.asyncIterator]() {
              for await (const e of self) {
                if (e.type === "text") yield e.delta;
              }
            },
          };
        },
      };
    },
  };
}
