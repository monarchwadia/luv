// Non-streaming send: build wire JSON in wasm, fetch, parse reply in wasm.

import { encodeSendRequest, decodeReply } from "./codec.ts";
import { callWithBytesInOut } from "./bridge.ts";
import { getWasm, type InitOptions } from "./wasm.ts";
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

export interface SendInternalOptions extends InitOptions {
  /** Override globalThis.fetch — primarily for tests. */
  fetch?: typeof fetch;
}

export async function send(
  opts: SendOptions,
  internal?: SendInternalOptions,
): Promise<Reply> {
  const wasm = await getWasm(internal);
  const fetchImpl = internal?.fetch ?? globalThis.fetch.bind(globalThis);

  const requestBytes = encodeSendRequest(opts);
  const wireBytes = callWithBytesInOut(
    wasm,
    "luv_build_request",
    wasm.luv_build_request,
    requestBytes,
  );

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const url = `${baseUrl}/v1/chat/completions`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: wireBytes as BodyInit,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const responseBody = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new HttpError(res.status, utf8Decoder.decode(responseBody));
  }

  const replyBytes = callWithBytesInOut(
    wasm,
    "luv_parse_reply",
    wasm.luv_parse_reply,
    responseBody,
  );
  return decodeReply(replyBytes);
}
