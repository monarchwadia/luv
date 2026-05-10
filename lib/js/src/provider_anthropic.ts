// anthropicProvider — factory returning a Provider for Anthropic Messages API.
// Same Provider interface as openaiProvider; runAgent and any other Provider
// consumer doesn't need to know the difference.

import { classifyError } from "./errors.ts";
import { fromAnthropic, toAnthropic, type AnthropicWireResponse } from "./morphism_anthropic.ts";
import type { SendInternalOptions } from "./send.ts";
import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "./types.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** Configuration for {@link anthropicProvider}. */
export interface AnthropicProviderConfig {
  /** Anthropic API key. */
  readonly apiKey: string;
  /** Override the default `https://api.anthropic.com` base URL. */
  readonly baseUrl?: string;
  /** Anthropic API version header. Default: "2023-06-01". */
  readonly anthropicVersion?: string;
}

/** Build a `Provider` for Anthropic's Messages API.
 *
 * Streaming is not yet implemented (the SSE event vocabulary is richer than
 * OpenAI's and warrants a dedicated decoder). `sendStream` will throw until
 * that lands.
 *
 * @example
 * const provider = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
 * await runAgent({ provider, model: "claude-3-5-sonnet-20241022",
 *   conversation, tools, maxTokens: 1024 });
 */
export function anthropicProvider(
  config: AnthropicProviderConfig,
  internal?: SendInternalOptions,
): Provider {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  const version = config.anthropicVersion ?? "2023-06-01";
  const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async send(opts: ProviderSendOptions): Promise<Reply> {
      const wire = toAnthropic({
        conversation: opts.conversation,
        model: opts.model,
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.tools && opts.tools.length > 0 && { tools: opts.tools }),
      });

      const res = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": version,
          "content-type": "application/json",
        },
        body: JSON.stringify(wire),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      const bodyBytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) {
        throw classifyError(res.status, utf8Decoder.decode(bodyBytes), res.headers.get("retry-after"));
      }

      const parsed = JSON.parse(utf8Decoder.decode(bodyBytes)) as AnthropicWireResponse;
      return fromAnthropic(parsed);
    },
    sendStream(_opts: ProviderStreamOptions): LuvStream {
      throw new Error("luv-js: anthropicProvider.sendStream is not yet implemented");
    },
  };
}
