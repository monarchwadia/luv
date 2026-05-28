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
  luv_conversation_to_openai_request,
  openai_response_to_luv_reply,
  openai_stream_to_luv_stream,
  type OpenAIRequestOptions,
} from "../morphisms/openai_chat.js";

// ---------- Transport-internal canonical types ----------

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

// ---------- Client configuration ----------

export type ErrorPolicy = "throw" | "as_block";

export type ErrorPolicyMap = Partial<Record<ErrorCategory, ErrorPolicy>>;

export interface OpenAIClientConfig {
  api_key: string;
  base_url?: string;
  organization?: string;
  project?: string;
  timeout_ms?: number;
  on_error?: ErrorPolicyMap;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
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
  config: OpenAIClientConfig,
  category: ErrorCategory,
): ErrorPolicy {
  return config.on_error?.[category] ?? DEFAULT_ON_ERROR[category];
}

// ---------- Status -> ErrorCategory ----------

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

// ---------- Arrow: luv_send_to_openai_http_request ----------

export function luv_send_to_openai_http_request(
  conv: Conversation,
  opts: OpenAIRequestOptions,
  config: OpenAIClientConfig,
): HTTPRequest {
  const baseUrl = config.base_url ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/chat/completions`;

  // Build headers in canonical order: required first (authorization,
  // content-type), then optional alphabetically.
  const headers: Record<string, string> = {};
  headers["authorization"] = `Bearer ${config.api_key}`;
  headers["content-type"] = "application/json";

  const optionals: Array<[string, string]> = [];
  if (config.organization) {
    optionals.push(["openai-organization", config.organization]);
  }
  if (config.project) {
    optionals.push(["openai-project", config.project]);
  }
  optionals.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, v] of optionals) headers[k] = v;

  const body = stringify(luv_conversation_to_openai_request(conv, opts));

  return { method: "POST", url, headers, body };
}

// ---------- Arrow: openai_http_response_to_luv_reply ----------

export function openai_http_response_to_luv_reply(
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
    return openai_response_to_luv_reply(parsed);
  }

  const category = mapStatusToCategory(response.status);
  return makeErrorReply(
    category,
    shortMessageFor(response.status, category),
    { status: response.status, body: response.body },
  );
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

// ---------- Arrow: openai_http_stream_to_luv_stream ----------

export function openai_http_stream_to_luv_stream(
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

  const chunks = parseSSE(response.body);
  return openai_stream_to_luv_stream(chunks);
}

function parseSSE(body: string): unknown[] {
  const chunks: unknown[] = [];
  const events = body.split("\n\n");
  for (const event of events) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return chunks;
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        // Skip unparseable data lines silently. A more aggressive
        // implementation might surface a parse-error event here.
      }
    }
  }
  return chunks;
}

// ---------- Client (composition + fetch) ----------

export interface OpenAIClient {
  send(conv: Conversation, opts: OpenAIRequestOptions): Promise<Reply>;
  stream(
    conv: Conversation,
    opts: OpenAIRequestOptions,
  ): AsyncIterable<StreamEventReply>;
}

export function openaiClient(config: OpenAIClientConfig): OpenAIClient {
  return {
    async send(conv, opts) {
      const req = luv_send_to_openai_http_request(conv, opts, config);
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
      const reply = openai_http_response_to_luv_reply(httpRes);
      applyErrorPolicyOrThrow(reply, config);
      return reply;
    },

    async *stream(conv, opts) {
      const req = luv_send_to_openai_http_request(
        conv,
        { ...opts, stream: true },
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
        const events = openai_http_stream_to_luv_stream(httpRes);
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

      // 2xx — stream chunks as they arrive.
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

function applyErrorPolicyOrThrow(reply: Reply, config: OpenAIClientConfig): void {
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

// Real-time SSE streaming from a fetch Response. Decodes bytes as
// they arrive, scans for complete event blocks (separated by "\n\n"),
// parses each data: line, and yields luv events incrementally.
async function* streamSSE(
  res: Response,
): AsyncIterable<StreamEventReply> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Stateful chunk-to-luv processor mirrors the morphism, but operates
  // chunk-at-a-time so we can yield events as bytes arrive.
  const state = createStreamState();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const ev of processChunk(state, chunk)) yield ev;
      }
    }
  }
}

interface StreamState {
  blockOpen: "text" | "tool_call" | null;
  messageStartEmitted: boolean;
}

function createStreamState(): StreamState {
  return { blockOpen: null, messageStartEmitted: false };
}

function processChunk(
  state: StreamState,
  chunk: unknown,
): StreamEventReply[] {
  const out: StreamEventReply[] = [];
  const c = chunk as {
    choices: Array<{
      delta: {
        role?: string;
        content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason: string | null;
    }>;
  };
  const choice = c.choices[0];
  const delta = choice.delta;
  const finishReason = choice.finish_reason;

  if (delta.role === "assistant" && !state.messageStartEmitted) {
    out.push({ kind: "message_start" });
    state.messageStartEmitted = true;
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tcDelta of delta.tool_calls) {
      if (tcDelta.id !== undefined) {
        if (state.blockOpen === "text") {
          out.push({ kind: "block_end" });
          state.blockOpen = null;
        }
        out.push({
          kind: "block_start",
          block: {
            kind: "tool_call",
            id: tcDelta.id,
            name: tcDelta.function?.name ?? "",
            args: "",
          },
        });
        state.blockOpen = "tool_call";
        const initialArgs = tcDelta.function?.arguments;
        if (typeof initialArgs === "string" && initialArgs.length > 0) {
          out.push({ kind: "args_delta", args: initialArgs });
        }
      } else if (
        tcDelta.function?.arguments !== undefined &&
        tcDelta.function.arguments !== ""
      ) {
        out.push({ kind: "args_delta", args: tcDelta.function.arguments });
      }
    }
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    if (state.blockOpen !== "text") {
      if (state.blockOpen === "tool_call") {
        out.push({ kind: "block_end" });
      }
      out.push({ kind: "block_start", block: { kind: "text", text: "" } });
      state.blockOpen = "text";
    }
    out.push({ kind: "text_delta", text: delta.content });
  }

  if (finishReason !== null && finishReason !== undefined) {
    if (state.blockOpen !== null) {
      out.push({ kind: "block_end" });
      state.blockOpen = null;
    }
    out.push({
      kind: "message_end",
      finish_reason: mapFinishReason(finishReason),
    });
  }

  return out;
}

function mapFinishReason(
  r: string,
): "end_turn" | "max_tokens" | "content_filter" | "error" {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "end_turn";
    default:
      return "end_turn";
  }
}
