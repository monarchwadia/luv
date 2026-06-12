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
  luv_conversation_to_bedrock_request,
  bedrock_response_to_luv_reply,
  bedrock_stream_to_luv_stream,
  type BedrockRequestOptions,
} from "../morphisms/bedrock_converse.js";

// ---------- Config ----------

export type ErrorPolicy = "throw" | "as_block";
export type ErrorPolicyMap = Partial<Record<ErrorCategory, ErrorPolicy>>;

export interface BedrockClientConfig {
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  endpoint_url?: string;
  timeout_ms?: number;
  on_error?: ErrorPolicyMap;
}

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

function policyFor(config: BedrockClientConfig, category: ErrorCategory): ErrorPolicy {
  return config.on_error?.[category] ?? DEFAULT_ON_ERROR[category];
}

// ---------- SigV4 Signing ----------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as ArrayBufferView<ArrayBuffer>);
  return new Uint8Array(buf);
}

function hex(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i++) out += data[i].toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as ArrayBufferView<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, data as ArrayBufferView<ArrayBuffer>);
  return new Uint8Array(sig);
}

const enc = new TextEncoder();

async function deriveSigningKey(secret: string, date: string, region: string, service: string): Promise<Uint8Array> {
  let key = await hmacSha256(enc.encode("AWS4" + secret), enc.encode(date));
  key = await hmacSha256(key, enc.encode(region));
  key = await hmacSha256(key, enc.encode(service));
  key = await hmacSha256(key, enc.encode("aws4_request"));
  return key;
}

export async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  config: BedrockClientConfig,
): Promise<Record<string, string>> {
  const parsed = new URL(url);
  const datetime = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const date = datetime.slice(0, 8);

  const payloadHash = hex(await sha256(enc.encode(body)));

  // SigV4 canonical URI: URI-encode each path segment, preserving '/'.
  const canonicalUri = parsed.pathname
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const signedHeaders: Record<string, string> = {
    ...headers,
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": datetime,
  };
  if (config.session_token) signedHeaders["x-amz-security-token"] = config.session_token;

  const headerKeys = Object.keys(signedHeaders).sort();
  const signedHeadersStr = headerKeys.join(";");
  const canonicalHeaders = headerKeys.map((k) => `${k}:${signedHeaders[k]}\n`).join("");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${config.region}/bedrock/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    scope,
    hex(await sha256(enc.encode(canonicalRequest))),
  ].join("\n");

  const signingKey = await deriveSigningKey(config.secret_access_key, date, config.region, "bedrock");
  const signature = hex(await hmacSha256(signingKey, enc.encode(stringToSign)));

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.access_key_id}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return { ...signedHeaders, authorization };
}

// ---------- Event-Stream Decoder ----------

// CRC32 lookup table (IEEE polynomial).
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array, initial = 0): number {
  let crc = initial ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodeEventStreamFrame(buffer: Uint8Array, offset: number): { payload: Uint8Array; eventType: string; length: number } | null {
  if (buffer.length - offset < 12) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
  const totalLength = view.getUint32(0);
  if (buffer.length - offset < totalLength) return null;

  const headersLength = view.getUint32(4);
  const headersStart = 12; // 8 prelude + 4 prelude CRC
  const headersEnd = headersStart + headersLength;

  // Parse headers to extract :event-type.
  let eventType = "";
  let hOff = offset + headersStart;
  while (hOff < offset + headersEnd) {
    const nameLen = buffer[hOff]; hOff++;
    const name = new TextDecoder().decode(buffer.slice(hOff, hOff + nameLen)); hOff += nameLen;
    const type = buffer[hOff]; hOff++;
    if (type === 7) { // string type
      const valLen = (buffer[hOff] << 8) | buffer[hOff + 1]; hOff += 2;
      const val = new TextDecoder().decode(buffer.slice(hOff, hOff + valLen)); hOff += valLen;
      if (name === ":event-type") eventType = val;
    } else if (type === 4) { // timestamp (8 bytes)
      hOff += 8;
    } else if (type === 8) { // uuid (16 bytes)
      hOff += 16;
    } else {
      break; // unknown header type, stop parsing
    }
  }

  const payloadOffset = headersEnd;
  const payloadLength = totalLength - payloadOffset - 4; // subtract message CRC
  const payload = buffer.slice(offset + payloadOffset, offset + payloadOffset + payloadLength);
  return { payload, eventType, length: totalLength };
}

export function decodeAllFrames(buffer: Uint8Array): unknown[] {
  const events: unknown[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const frame = decodeEventStreamFrame(buffer, offset);
    if (!frame) break;
    offset += frame.length;
    if (frame.payload.length === 0 || !frame.eventType) continue;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(frame.payload));
      // Wrap in the event-type key so the morphism can process it.
      events.push({ [frame.eventType]: parsed });
    } catch { /* skip non-JSON frames */ }
  }
  return events;
}

// ---------- Error Handling ----------

function mapStatusToCategory(status: number): ErrorCategory {
  if (status === 403) return "auth";
  if (status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status === 404) return "bad_request";
  if (status === 424) return "server_error";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  return "unknown";
}

function makeErrorReply(category: ErrorCategory, message: string, details: unknown): Reply {
  return {
    message: {
      role: "assistant",
      content: [{ kind: "error", category, message, details: stringify(details) }],
    },
    finish_reason: "error",
    usage: null,
  };
}

// ---------- Client ----------

export interface BedrockClient {
  send(conv: Conversation, opts: BedrockRequestOptions): Promise<Reply>;
  stream(conv: Conversation, opts: BedrockRequestOptions): AsyncIterable<StreamEventReply>;
}

export function bedrockClient(config: BedrockClientConfig): BedrockClient {
  const baseUrl = config.endpoint_url ?? `https://bedrock-runtime.${config.region}.amazonaws.com`;

  return {
    async send(conv, opts) {
      const body = stringify(luv_conversation_to_bedrock_request(conv, opts));
      const url = `${baseUrl}/model/${opts.model_id}/converse`;
      const headers = await signRequest("POST", url, { "content-type": "application/json" }, body, config);

      const res = await fetch(url, { method: "POST", headers, body, signal: config.timeout_ms ? AbortSignal.timeout(config.timeout_ms) : undefined });

      if (res.status >= 200 && res.status < 300) {
        const json = await res.json();
        return bedrock_response_to_luv_reply(json, opts.model_id);
      }

      const category = mapStatusToCategory(res.status);
      const errBody = await res.text();
      const reply = makeErrorReply(category, `HTTP ${res.status}: ${category}`, { status: res.status, body: errBody });
      if (policyFor(config, category) === "throw") {
        throw new LuvError({ category, message: `HTTP ${res.status}: ${category}`, details: stringify({ status: res.status, body: errBody }) });
      }
      return reply;
    },

    async *stream(conv, opts) {
      const body = stringify(luv_conversation_to_bedrock_request(conv, opts));
      const url = `${baseUrl}/model/${opts.model_id}/converse-stream`;
      const headers = await signRequest("POST", url, { "content-type": "application/json" }, body, config);

      const res = await fetch(url, { method: "POST", headers, body, signal: config.timeout_ms ? AbortSignal.timeout(config.timeout_ms) : undefined });

      if (res.status < 200 || res.status >= 300) {
        const category = mapStatusToCategory(res.status);
        const errBody = await res.text();
        if (policyFor(config, category) === "throw") {
          throw new LuvError({ category, message: `HTTP ${res.status}: ${category}`, details: stringify({ status: res.status, body: errBody }) });
        }
        const events: StreamReply = [
          { kind: "message_start" },
          { kind: "block_start", block: { kind: "error", category, message: `HTTP ${res.status}: ${category}`, details: stringify({ status: res.status, body: errBody }) } },
          { kind: "block_end" },
          { kind: "message_end", finish_reason: "error", usage: null },
        ];
        for (const e of events) yield e;
        return;
      }

      // Stream binary event-stream frames incrementally.
      if (!res.body) return;
      const reader = res.body.getReader();
      let buffer = new Uint8Array(0);
      const streamEvents: unknown[] = [];
      const openedBlocks = new Set<number>();
      let storedStopReason: string | null = null;

      const emitted: StreamEventReply[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // Append to buffer.
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;

        // Decode complete frames.
        let offset = 0;
        while (offset < buffer.length) {
          const frame = decodeEventStreamFrame(buffer, offset);
          if (!frame) break;
          offset += frame.length;
          if (frame.payload.length === 0 || !frame.eventType) continue;
          try {
            const parsed = JSON.parse(new TextDecoder().decode(frame.payload));
            const evt = { [frame.eventType]: parsed } as Record<string, unknown>;
            for (const e of processStreamEvent(evt, opts.model_id, openedBlocks, storedStopReason)) {
              if (e._storeStop !== undefined) { storedStopReason = e._storeStop || null; continue; }
              yield e.event!;
            }
          } catch { /* skip */ }
        }
        buffer = buffer.slice(offset);
      }

      // Graceful degradation if no metadata arrived.
      if (storedStopReason !== null && storedStopReason !== "") {
        yield { kind: "message_end", finish_reason: mapStopReason(storedStopReason), usage: null };
      }
    },
  };
}

// Internal stream event processor for incremental yielding.
type StreamResult = { event?: StreamEventReply; _storeStop?: string };

function* processStreamEvent(
  evt: Record<string, unknown>,
  model_id: string,
  openedBlocks: Set<number>,
  _storedStopReason: string | null,
): Generator<StreamResult> {
  if (evt.messageStart) {
    yield { event: { kind: "message_start" } };
  } else if (evt.contentBlockStart) {
    const cbs = evt.contentBlockStart as { contentBlockIndex: number; start: { toolUse?: { toolUseId: string; name: string } } };
    openedBlocks.add(cbs.contentBlockIndex);
    if (cbs.start.toolUse) {
      yield { event: { kind: "block_start", block: { kind: "tool_call", id: cbs.start.toolUse.toolUseId, name: cbs.start.toolUse.name, args: "" } } };
    }
  } else if (evt.contentBlockDelta) {
    const cbd = evt.contentBlockDelta as { contentBlockIndex: number; delta: { text?: string; toolUse?: { input: string } } };
    if (!openedBlocks.has(cbd.contentBlockIndex)) {
      openedBlocks.add(cbd.contentBlockIndex);
      yield { event: { kind: "block_start", block: { kind: "text", text: "" } } };
    }
    if (typeof cbd.delta.text === "string") {
      yield { event: { kind: "text_delta", text: cbd.delta.text } };
    } else if (cbd.delta.toolUse) {
      yield { event: { kind: "args_delta", args: cbd.delta.toolUse.input } };
    }
  } else if (evt.contentBlockStop) {
    yield { event: { kind: "block_end" } };
  } else if (evt.messageStop) {
    const ms = evt.messageStop as { stopReason: string };
    yield { _storeStop: ms.stopReason };
  } else if (evt.metadata) {
    const meta = evt.metadata as { usage?: Record<string, unknown> };
    const usage = meta.usage ? { provider: "bedrock_converse" as const, model: model_id, raw: meta.usage } : null;
    yield { event: { kind: "message_end", finish_reason: mapStopReason(_storedStopReason), usage } };
    // Signal that metadata was handled by yielding a special clear.
    yield { _storeStop: "" };
  }
}

function mapStopReason(r: string | null | undefined): "end_turn" | "max_tokens" | "content_filter" | "error" {
  switch (r) {
    case "end_turn": return "end_turn";
    case "max_tokens": return "max_tokens";
    case "model_context_window_exceeded": return "max_tokens";
    case "stop_sequence": return "end_turn";
    case "tool_use": return "end_turn";
    case "content_filtered": return "content_filter";
    case "guardrail_intervened": return "content_filter";
    case "malformed_model_output": return "error";
    case "malformed_tool_use": return "error";
    default: return "end_turn";
  }
}
