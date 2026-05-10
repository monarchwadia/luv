// createClient — a one-shot wrapper around openaiProvider that bundles
// send / sendStream / runAgent into a single object so callers don't have to
// re-pass apiKey or baseUrl on every call.

import { runAgent } from "./agent.ts";
import { openaiProvider, type OpenAIProviderConfig } from "./provider_openai.ts";
import { send, type SendInternalOptions } from "./send.ts";
import { sendStream } from "./send_stream.ts";
import type {
  AgentOptions,
  AgentResult,
  LuvStream,
  Provider,
  Reply,
  SendOptions,
  SendStreamOptions,
} from "./types.ts";

/** Per-call options that omit credentials (already bound to the client). */
export type ClientSendOptions = Omit<SendOptions, "apiKey" | "baseUrl">;
export type ClientSendStreamOptions = Omit<SendStreamOptions, "apiKey" | "baseUrl">;
export type ClientAgentOptions = Omit<AgentOptions, "provider">;

export interface LuvClient {
  send(opts: ClientSendOptions): Promise<Reply>;
  sendStream(opts: ClientSendStreamOptions): LuvStream;
  runAgent(opts: ClientAgentOptions): Promise<AgentResult>;
  /** The underlying Provider — pass to anything that takes a Provider directly. */
  readonly provider: Provider;
}

export function createClient(
  config: OpenAIProviderConfig,
  internal?: SendInternalOptions,
): LuvClient {
  const provider = openaiProvider(config, internal);
  return {
    send(opts: ClientSendOptions): Promise<Reply> {
      return send(
        {
          apiKey: config.apiKey,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...opts,
        },
        internal,
      );
    },
    sendStream(opts: ClientSendStreamOptions): LuvStream {
      return sendStream(
        {
          apiKey: config.apiKey,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...opts,
        },
        internal,
      );
    },
    runAgent(opts: ClientAgentOptions): Promise<AgentResult> {
      return runAgent({ ...opts, provider });
    },
    provider,
  };
}
