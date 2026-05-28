import type {
  Conversation,
  ErrorCategory,
  Reply,
  StreamEventReply,
  StreamReply,
} from "../types.js";
import { LuvError } from "../types.js";
import { stringify } from "../encode.js";
import {
  luv_conversation_to_anthropic_request,
  anthropic_response_to_luv_reply,
  anthropic_stream_to_luv_stream,
  type AnthropicRequestOptions,
} from "../morphisms/anthropic_messages.js";

// Transport-internal canonical types (same shape as openai_chat transport).

export interface HTTPRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HTTPResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ErrorPolicy = "throw" | "as_block";
export type ErrorPolicyMap = Partial<Record<ErrorCategory, ErrorPolicy>>;

export interface AnthropicClientConfig {
  api_key: string;
  base_url?: string;
  anthropic_version?: string;
  default_max_tokens?: number;
  timeout_ms?: number;
  on_error?: ErrorPolicyMap;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

const DEFAULT_ON_ERROR: Record<ErrorCategory, ErrorPolicy> = {
  auth: "throw",
  rate_limit: "throw",
  bad_request: "throw",
  content_filter: "as_block",
  server_error: "throw",
  network: "throw",
  tool_execution: "throw",
  local_validation: "throw",
  unknown: "throw",
};

function policyFor(
  config: AnthropicClientConfig,
  category: ErrorCategory,
): ErrorPolicy {
  return config.on_error?.[category] ?? DEFAULT_ON_ERROR[category];
}

function mapStatusToCategory(status: number): ErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "network";
  if (status === 429) return "rate_limit";
  if (status === 0) return "network";
  if (status >= 500 && status < 600) return "server_error";
  if (status >= 400 && status < 500) return "bad_request";
  return "unknown";
}

function shortMessageFor(status: number, category: ErrorCategory): string {
  return `HTTP ${status}: ${category}`;
}

// Arrow: luv_send_to_anthropic_http_request

export function luv_send_to_anthropic_http_request(
  conv: Conversation,
  opts: AnthropicRequestOptions,
  config: AnthropicClientConfig,
): HTTPRequest {
  const baseUrl = config.base_url ?? DEFAULT_BASE_URL;
  const version = config.anthropic_version ?? DEFAULT_VERSION;
  const url = `${baseUrl}/messages`;

  // Canonical header order: anthropic-version, content-type, x-api-key.
  const headers: Record<string, string> = {};
  headers["anthropic-version"] = version;
  headers["content-type"] = "application/json";
  headers["x-api-key"] = config.api_key;

  const body = stringify(luv_conversation_to_anthropic_request(conv, opts));

  return { method: "POST", url, headers, body };
}

// Arrow: anthropic_http_response_to_luv_reply

export function anthropic_http_response_to_luv_reply(
  response: HTTPResponse,
): Reply {
  if (response.status >= 200 && response.status < 300) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return makeErrorReply(
        "unknown",
        `HTTP ${response.status}: failed to parse response body as JSON`,
        { status: response.status, body: response.body },
      );
    }
    return anthropic_response_to_luv_reply(parsed);
  }

  const category = mapStatusToCategory(response.status);
  return makeErrorReply(category, shortMessageFor(response.status, category), {
    status: response.status,
    body: response.body,
  });
}

function makeErrorReply(
  category: ErrorCategory,
  message: string,
  detailsObj: unknown,
): Reply {
  return {
    message: {
      role: "assistant",
      content: [
        {
          kind: "error",
          category,
          message,
          details: stringify(detailsObj),
        },
      ],
    },
    finish_reason: "error",
  };
}

// Arrow: anthropic_http_stream_to_luv_stream

export function anthropic_http_stream_to_luv_stream(
  response: HTTPResponse,
): StreamReply {
  if (response.status < 200 || response.status >= 300) {
    const category = mapStatusToCategory(response.status);
    return [
      { kind: "message_start" },
      {
        kind: "block_start",
        block: {
          kind: "error",
          category,
          message: shortMessageFor(response.status, category),
          details: stringify({ status: response.status, body: response.body }),
        },
      },
      { kind: "block_end" },
      { kind: "message_end", finish_reason: "error" },
    ];
  }

  const events = parseSSE(response.body);
  return anthropic_stream_to_luv_stream(events);
}

function parseSSE(body: string): unknown[] {
  // Anthropic SSE: blocks separated by \n\n; each block has an "event:"
  // line (ignored) and a "data: <json>" line. No [DONE] terminator;
  // stream ends with message_stop event.
  const events: unknown[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      try {
        events.push(JSON.parse(payload));
      } catch {
        // Skip unparseable.
      }
    }
  }
  return events;
}

// Client (composition + fetch).

export interface AnthropicClient {
  send(conv: Conversation, opts: AnthropicRequestOptions): Promise<Reply>;
  stream(
    conv: Conversation,
    opts: AnthropicRequestOptions,
  ): AsyncIterable<StreamEventReply>;
}

export function anthropicClient(
  config: AnthropicClientConfig,
): AnthropicClient {
  return {
    async send(conv, opts) {
      const effectiveOpts: AnthropicRequestOptions = {
        ...opts,
        max_tokens:
          opts.max_tokens ?? config.default_max_tokens ?? DEFAULT_MAX_TOKENS,
      };
      const req = luv_send_to_anthropic_http_request(
        conv,
        effectiveOpts,
        config,
      );
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      const httpRes: HTTPResponse = {
        status: fetchRes.status,
        headers: headersToRecord(fetchRes.headers),
        body: await fetchRes.text(),
      };
      const reply = anthropic_http_response_to_luv_reply(httpRes);
      applyErrorPolicyOrThrow(reply, config);
      return reply;
    },

    async *stream(conv, opts) {
      const effectiveOpts: AnthropicRequestOptions = {
        ...opts,
        max_tokens:
          opts.max_tokens ?? config.default_max_tokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
      };
      const req = luv_send_to_anthropic_http_request(
        conv,
        effectiveOpts,
        config,
      );
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });

      if (fetchRes.status < 200 || fetchRes.status >= 300) {
        const httpRes: HTTPResponse = {
          status: fetchRes.status,
          headers: headersToRecord(fetchRes.headers),
          body: await fetchRes.text(),
        };
        const events = anthropic_http_stream_to_luv_stream(httpRes);
        const errBlock = findErrorBlock(events);
        if (errBlock && policyFor(config, errBlock.category) === "throw") {
          throw new LuvError({
            category: errBlock.category,
            message: errBlock.message,
            details: errBlock.details,
          });
        }
        for (const e of events) yield e;
        return;
      }

      yield* streamSSE(fetchRes);
    },
  };
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function findErrorBlock(events: StreamEventReply[]):
  | { category: ErrorCategory; message: string; details: string }
  | null {
  for (const e of events) {
    if (e.kind === "block_start" && e.block.kind === "error") {
      return {
        category: e.block.category,
        message: e.block.message,
        details: e.block.details,
      };
    }
  }
  return null;
}

function applyErrorPolicyOrThrow(
  reply: Reply,
  config: AnthropicClientConfig,
): void {
  for (const block of reply.message.content) {
    if (block.kind === "error") {
      const policy = policyFor(config, block.category);
      if (policy === "throw") {
        throw new LuvError({
          category: block.category,
          message: block.message,
          details: block.details,
        });
      }
    }
  }
}

// Real-time SSE stream of Anthropic typed events; maps to luv events
// chunk-by-chunk via a stateful processor that mirrors the morphism.
async function* streamSSE(
  res: Response,
): AsyncIterable<StreamEventReply> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const state = createStreamState();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        let evt: unknown;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const ev of processEvent(state, evt)) yield ev;
      }
    }
  }
}

interface StreamState {
  storedStopReason: string | null;
}

function createStreamState(): StreamState {
  return { storedStopReason: null };
}

function processEvent(
  state: StreamState,
  evt: unknown,
): StreamEventReply[] {
  const out: StreamEventReply[] = [];
  const e = evt as {
    type: string;
    content_block?: { type: string; id?: string; name?: string };
    delta?: {
      type?: string;
      text?: string;
      partial_json?: string;
      stop_reason?: string;
    };
  };
  switch (e.type) {
    case "message_start":
      out.push({ kind: "message_start" });
      break;
    case "content_block_start": {
      const cb = e.content_block;
      if (!cb) break;
      if (cb.type === "text") {
        out.push({
          kind: "block_start",
          block: { kind: "text", text: "" },
        });
      } else if (cb.type === "tool_use") {
        out.push({
          kind: "block_start",
          block: {
            kind: "tool_call",
            id: cb.id ?? "",
            name: cb.name ?? "",
            args: "",
          },
        });
      }
      break;
    }
    case "content_block_delta": {
      const d = e.delta;
      if (!d) break;
      if (d.type === "text_delta" && typeof d.text === "string") {
        out.push({ kind: "text_delta", text: d.text });
      } else if (
        d.type === "input_json_delta" &&
        typeof d.partial_json === "string"
      ) {
        out.push({ kind: "args_delta", args: d.partial_json });
      }
      break;
    }
    case "content_block_stop":
      out.push({ kind: "block_end" });
      break;
    case "message_delta":
      if (e.delta && typeof e.delta.stop_reason === "string") {
        state.storedStopReason = e.delta.stop_reason;
      }
      break;
    case "message_stop":
      out.push({
        kind: "message_end",
        finish_reason: mapStopReason(state.storedStopReason),
      });
      break;
    default:
      // ping and unknown events: skip
      break;
  }
  return out;
}

function mapStopReason(
  r: string | null,
): "end_turn" | "max_tokens" | "content_filter" | "error" {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "end_turn";
    default:
      return "end_turn";
  }
}
