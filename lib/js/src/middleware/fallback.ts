// fallbackChain — try providers in order, advancing on error.
// First successful reply wins.

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface FallbackOptions {
  /** Predicate to decide whether to advance to the next provider on error.
   *  Default: always advance (any thrown error → try next). */
  readonly shouldAdvance?: (err: unknown) => boolean;
}

/** Wrap N providers so calls advance to the next on failure. */
export function fallbackChain(
  providers: readonly Provider[],
  opts: FallbackOptions = {},
): Provider {
  if (providers.length === 0) {
    throw new Error("luv-js: fallbackChain requires at least one provider");
  }
  const shouldAdvance = opts.shouldAdvance ?? (() => true);

  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      let lastErr: unknown;
      for (const p of providers) {
        try {
          return await p.send(req);
        } catch (err) {
          lastErr = err;
          if (!shouldAdvance(err)) throw err;
        }
      }
      throw lastErr;
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      // We can only fall back BEFORE the first byte is read. Try each provider's
      // initial connection (via .done racing with first event). Practical
      // approach: just call the first one. Streams are intentionally simpler.
      return providers[0]!.sendStream(req);
    },
  };
}
