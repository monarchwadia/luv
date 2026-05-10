// Non-streaming send: build wire JSON via the morphism, fetch, parse via the morphism.

import { fromOpenAI, toOpenAI, type OpenAIWireResponse } from "./morphism.ts";
import type { Reply, SendOptions } from "./types.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`luv-js: HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.status = status;
    this.body = body;
    this.name = "HttpError";
  }
}

export interface SendInternalOptions {
  /** Override globalThis.fetch — for tests. */
  fetch?: typeof fetch;
}

export async function send(
  opts: SendOptions,
  internal?: SendInternalOptions,
): Promise<Reply> {
  const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);
  const wire = toOpenAI({
    conversation: opts.conversation,
    model: opts.model,
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.tools && { tools: opts.tools }),
  });

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const url = `${baseUrl}/v1/chat/completions`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(wire),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new HttpError(res.status, utf8Decoder.decode(bodyBytes));
  }

  const parsed = JSON.parse(utf8Decoder.decode(bodyBytes)) as OpenAIWireResponse;
  return fromOpenAI(parsed);
}
