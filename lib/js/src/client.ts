// createClient — a one-shot wrapper around openaiProvider that bundles
// send / sendStream / runAgent into a single object so callers don't have to
// re-pass apiKey or baseUrl on every call.

import { runAgent } from "./agent.ts";
import {
  AuthError,
  ContentFilterError,
  ContextWindowExceededError,
  HttpError,
  RateLimitError,
  ServiceUnavailableError,
} from "./errors.ts";
import {
  generateObject,
  type GenerateObjectOptions,
  type ObjectResult,
} from "./object.ts";
import { openaiProvider, type OpenAIProviderConfig } from "./provider_openai.ts";
import { send, type SendInternalOptions } from "./send.ts";
import { sendStream } from "./send_stream.ts";
import type { InferSchema } from "./tool.ts";
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
/** Per-call streaming options that omit credentials (already bound to the client). */
export type ClientSendStreamOptions = Omit<SendStreamOptions, "apiKey" | "baseUrl">;
/** Per-call agent options that omit `provider` (already bound to the client). */
export type ClientAgentOptions = Omit<AgentOptions, "provider">;
/** Per-call generateObject options that omit credentials. */
export type ClientGenerateObjectOptions<S> = Omit<GenerateObjectOptions<S>, "apiKey" | "baseUrl">;

/** A bundled wrapper around `send` / `sendStream` / `runAgent`, pre-bound to
 *  one provider's credentials. Returned by {@link createClient}. */
export interface LuvClient {
  /** Single chat completion; see {@link send}. */
  send(opts: ClientSendOptions): Promise<Reply>;
  /** Streaming chat completion; see {@link sendStream}. */
  sendStream(opts: ClientSendStreamOptions): LuvStream;
  /** Multi-turn agent loop; see `runAgent`. */
  runAgent(opts: ClientAgentOptions): Promise<AgentResult>;
  /** Typed structured-output call; see {@link generateObject}. */
  generateObject<const S>(opts: ClientGenerateObjectOptions<S>): Promise<ObjectResult<InferSchema<S>>>;
  /** The underlying Provider — pass to anything that takes a Provider directly. */
  readonly provider: Provider;
  /** Error classes re-exposed on the client for ergonomic `instanceof` use. */
  readonly HttpError: typeof HttpError;
  readonly AuthError: typeof AuthError;
  readonly RateLimitError: typeof RateLimitError;
  readonly ContextWindowExceededError: typeof ContextWindowExceededError;
  readonly ContentFilterError: typeof ContentFilterError;
  readonly ServiceUnavailableError: typeof ServiceUnavailableError;
}

/** Build a `LuvClient` pre-bound to an OpenAI-shaped provider's credentials.
 *
 * The returned object has `send`, `sendStream`, and `runAgent` methods that
 * don't require re-passing `apiKey` or `baseUrl`. The error classes are
 * exposed as properties so you can `if (err instanceof client.RateLimitError)`
 * without a separate import.
 *
 * @example
 * const luv = createClient({ apiKey: process.env.OPENAI_API_KEY! });
 * const reply = await luv.send({
 *   model: "gpt-4o-mini",
 *   conversation: [{ role: "user", text: "hi" }],
 * });
 */
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
    generateObject<const S>(
      opts: ClientGenerateObjectOptions<S>,
    ): Promise<ObjectResult<InferSchema<S>>> {
      return generateObject(
        {
          apiKey: config.apiKey,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
          ...opts,
        },
        internal,
      );
    },
    provider,
    HttpError,
    AuthError,
    RateLimitError,
    ContextWindowExceededError,
    ContentFilterError,
    ServiceUnavailableError,
  };
}
