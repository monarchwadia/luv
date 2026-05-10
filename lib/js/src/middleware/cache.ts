// cache — memoize Provider.send by request shape. Streaming is not cached
// (streams are stateful and most callers want fresh ones).

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface CacheStore {
  get(key: string): Reply | undefined;
  set(key: string, value: Reply): void;
  delete(key: string): boolean;
  readonly size: number;
}

export interface CacheOptions {
  /** Custom key function. Default: hash of (model, conversation, tools, maxTokens, temperature). */
  readonly keyFn?: (req: ProviderSendOptions) => string;
  /** Custom store. Default: in-memory `Map` with `maxEntries` cap. */
  readonly store?: CacheStore;
  /** When using the default store, the LRU cap. Default 100. */
  readonly maxEntries?: number;
}

/** A bounded in-memory CacheStore (LRU by insertion order). */
export function memoryStore(maxEntries = 100): CacheStore {
  const map = new Map<string, Reply>();
  return {
    get(key) {
      const v = map.get(key);
      if (v !== undefined) {
        // refresh insertion order
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key) {
      return map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

/** Wrap a Provider to cache identical `send` calls. Skips streaming. */
export function cache(provider: Provider, opts: CacheOptions = {}): Provider {
  const store = opts.store ?? memoryStore(opts.maxEntries ?? 100);
  const keyFn = opts.keyFn ?? defaultKeyFn;
  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      const key = keyFn(req);
      const hit = store.get(key);
      if (hit !== undefined) return hit;
      const reply = await provider.send(req);
      store.set(key, reply);
      return reply;
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      return provider.sendStream(req);
    },
  };
}

function defaultKeyFn(req: ProviderSendOptions): string {
  // Stable JSON serialization of the parts that semantically affect the reply.
  return JSON.stringify({
    model: req.model,
    conversation: req.conversation,
    tools: req.tools?.map((t) => ({ name: t.name, schema: t.inputSchema })),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
  });
}
