// openaiProvider — factory that returns a `Provider` pre-bound to credentials.
// runAgent and any other consumer talks to this through the Provider interface,
// without knowing it's OpenAI on the other side.

import { send, type SendInternalOptions } from "./send.ts";
import { sendStream } from "./send_stream.ts";
import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "./types.ts";

export interface OpenAIProviderConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

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
