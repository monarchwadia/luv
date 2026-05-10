// openaiProvider — factory that returns a `Provider` pre-bound to credentials.
// runAgent and any other consumer talks to this through the Provider interface,
// without knowing it's OpenAI on the other side.

import { send, type SendInternalOptions } from "./send.ts";
import { sendStream } from "./send_stream.ts";
import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "./types.ts";

/** Configuration for {@link openaiProvider}. */
export interface OpenAIProviderConfig {
  /** OpenAI API key (or any OpenAI-compatible endpoint's key). */
  readonly apiKey: string;
  /** Override the default `https://api.openai.com` base URL — useful for
   *  proxies or OpenAI-compatible services (Ollama, vLLM, OpenRouter, etc.). */
  readonly baseUrl?: string;
}

/** Build a `Provider` for OpenAI Chat Completions and any OpenAI-compatible API.
 *
 * The returned provider is what `runAgent` (and any other consumer that
 * accepts a `Provider`) talks to. Wrap with middleware (caching, retry,
 * etc.) before passing to `runAgent` if needed.
 *
 * @example
 * const provider = openaiProvider({ apiKey: process.env.OPENAI_API_KEY! });
 * await runAgent({ provider, model: "gpt-4o-mini", conversation, tools });
 */
export function openaiProvider(
  config: OpenAIProviderConfig,
  internal?: SendInternalOptions,
): Provider {
  return {
    send(opts: ProviderSendOptions): Promise<Reply> {
      return send(
        {
          apiKey: config.apiKey,
          model: opts.model,
          conversation: opts.conversation,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
          ...(opts.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts.tools && opts.tools.length > 0 && { tools: opts.tools }),
          ...(opts.signal && { signal: opts.signal }),
        },
        internal,
      );
    },
    sendStream(opts: ProviderStreamOptions): LuvStream {
      return sendStream(
        {
          apiKey: config.apiKey,
          model: opts.model,
          conversation: opts.conversation,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
          ...(opts.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts.signal && { signal: opts.signal }),
          ...(opts.onStart && { onStart: opts.onStart }),
          ...(opts.onDelta && { onDelta: opts.onDelta }),
          ...(opts.onStop && { onStop: opts.onStop }),
          ...(opts.onError && { onError: opts.onError }),
        },
        internal,
      );
    },
  };
}
