// Refresh recordable provider-response fixtures by hitting the live API,
// and verify the luv->provider request-shape cases are still accepted.
//
// Usage:
//   bun run scripts/record.ts            (refresh everything)
//   bun run scripts/record.ts --verify   (no writes; just verify request shapes)
//
// Requires OPENAI_API_KEY and/or ANTHROPIC_API_KEY in repo-root .env or
// environment. Cases for providers without a key configured are skipped.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Reply, StreamReply } from "../src/index.js";
import {
  encodeReply,
  encodeStreamReply,
  stringify,
} from "../src/index.js";

import {
  openai_response_to_luv_reply,
  openai_stream_to_luv_stream,
} from "../src/morphisms/openai_chat.js";
import {
  openai_http_response_to_luv_reply,
  openai_http_stream_to_luv_stream,
  type HTTPResponse,
} from "../src/transport/openai_chat.js";

import {
  anthropic_response_to_luv_reply,
  anthropic_stream_to_luv_stream,
} from "../src/morphisms/anthropic_messages.js";
import {
  anthropic_http_response_to_luv_reply,
  anthropic_http_stream_to_luv_stream,
} from "../src/transport/anthropic_messages.js";

import {
  bedrock_response_to_luv_reply,
  bedrock_stream_to_luv_stream,
} from "../src/morphisms/bedrock_converse.js";
import {
  signRequest,
  decodeAllFrames,
} from "../src/transport/bedrock_converse.js";

const SPEC_ROOT = join(import.meta.dir, "..", "..", "..", "spec");
const ENV_PATH = join(import.meta.dir, "..", "..", "..", ".env");

const VERIFY_ONLY = process.argv.includes("--verify");
const ENV = loadEnv();

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
    }
  }
  return env;
}

// ---------- Provider hooks ----------

interface ProviderHooks {
  apiKeyEnv: string;
  url: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  contentTypeStream: string;
  parseSSE: (body: string) => unknown[];
  responseToReply: (resp: unknown) => Reply;
  streamToStream: (events: unknown[]) => StreamReply;
  httpResponseToReply: (resp: HTTPResponse) => Reply;
  httpStreamToStream: (resp: HTTPResponse) => StreamReply;
}

function parseSSE_openai(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const event of body.split("\n\n")) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return chunks;
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        /* skip */
      }
    }
  }
  return chunks;
}

function parseSSE_anthropic(body: string): unknown[] {
  // Anthropic SSE has both event: and data: lines; we take only data:.
  // No [DONE] terminator; stream ends with a message_stop event.
  const events: unknown[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      try {
        events.push(JSON.parse(payload));
      } catch {
        /* skip */
      }
    }
  }
  return events;
}

const PROVIDERS: Record<string, ProviderHooks> = {
  openai_chat: {
    apiKeyEnv: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    buildHeaders: (apiKey) => ({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    }),
    contentTypeStream: "text/event-stream",
    parseSSE: parseSSE_openai,
    responseToReply: openai_response_to_luv_reply,
    streamToStream: openai_stream_to_luv_stream,
    httpResponseToReply: openai_http_response_to_luv_reply,
    httpStreamToStream: openai_http_stream_to_luv_stream,
  },
  anthropic_messages: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    buildHeaders: (apiKey) => ({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey,
    }),
    contentTypeStream: "text/event-stream",
    parseSSE: parseSSE_anthropic,
    responseToReply: anthropic_response_to_luv_reply,
    streamToStream: anthropic_stream_to_luv_stream,
    httpResponseToReply: anthropic_http_response_to_luv_reply,
    httpStreamToStream: anthropic_http_stream_to_luv_stream,
  },
  bedrock_converse: {
    apiKeyEnv: "AWS_ACCESS_KEY_ID",
    url: "", // not used; Bedrock has custom dispatch
    buildHeaders: () => ({}),
    contentTypeStream: "application/vnd.amazon.eventstream",
    parseSSE: () => [],
    responseToReply: (r: unknown) => bedrock_response_to_luv_reply(r, ""),
    streamToStream: (e: unknown[]) => bedrock_stream_to_luv_stream(e, ""),
    httpResponseToReply: () => ({ message: { role: "assistant" as const, content: [] }, finish_reason: "end_turn" as const, usage: null }),
    httpStreamToStream: () => [],
  },
};

// ---------- Case discovery ----------

interface CaseRef {
  morphism: string;
  arrow: string;
  slug: string;
  dir: string;
}

function discoverCases(): CaseRef[] {
  const out: CaseRef[] = [];
  const morphismsRoot = join(SPEC_ROOT, "morphisms");
  if (!safeIsDir(morphismsRoot)) return out;
  for (const m of readdirSync(morphismsRoot)) {
    const casesRoot = join(morphismsRoot, m, "cases");
    if (!safeIsDir(casesRoot)) continue;
    for (const a of readdirSync(casesRoot)) {
      const arrowDir = join(casesRoot, a);
      if (!safeIsDir(arrowDir)) continue;
      for (const s of readdirSync(arrowDir)) {
        const slugDir = join(arrowDir, s);
        if (!safeIsDir(slugDir)) continue;
        out.push({ morphism: m, arrow: a, slug: s, dir: slugDir });
      }
    }
  }
  return out;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- Counters ----------

let pass = 0;
let fail = 0;
let written = 0;
let skipped = 0;

// ---------- Per-case processing ----------

async function processCase(c: CaseRef): Promise<void> {
  const provider = PROVIDERS[c.morphism];
  if (!provider) {
    console.log(
      `  skip (no provider hooks for ${c.morphism}): ${c.morphism}/${c.arrow}/${c.slug}`,
    );
    skipped++;
    return;
  }

  const apiKey = ENV[provider.apiKeyEnv];
  if (!apiKey) {
    console.log(
      `  skip (${provider.apiKeyEnv} not set): ${c.morphism}/${c.arrow}/${c.slug}`,
    );
    skipped++;
    return;
  }

  // Request-shape cases.
  if (
    c.arrow === "luv_conversation_to_openai_request" ||
    c.arrow === "luv_conversation_to_anthropic_request"
  ) {
    return verifyMorphismRequestShape(c, provider, apiKey);
  }
  if (
    c.arrow === "luv_send_to_openai_http_request" ||
    c.arrow === "luv_send_to_anthropic_http_request"
  ) {
    return verifyTransportRequestShape(c, provider, apiKey);
  }

  // Bedrock cases: luv_conversation_to_bedrock_request doesn't hit a live API
  // (model_id is in the URL, not the body). Skip request-shape verification.
  if (c.arrow === "luv_conversation_to_bedrock_request") {
    return; // synthetic case; not refreshable via API.
  }

  // Refresh-fixture cases.
  const recordPath = join(c.dir, "record.json");
  if (!existsSync(recordPath)) return; // synthetic; not refreshable.

  const recordMeta = JSON.parse(readFileSync(recordPath, "utf8")) as {
    request: Record<string, unknown>;
  };

  switch (c.arrow) {
    case "openai_response_to_luv_reply":
    case "anthropic_response_to_luv_reply":
      return refreshMorphismResponse(c, provider, apiKey, recordMeta.request);
    case "openai_stream_to_luv_stream":
    case "anthropic_stream_to_luv_stream":
      return refreshMorphismStream(c, provider, apiKey, recordMeta.request);
    case "openai_http_response_to_luv_reply":
    case "anthropic_http_response_to_luv_reply":
      return refreshTransportResponse(c, provider, apiKey, recordMeta.request);
    case "openai_http_stream_to_luv_stream":
    case "anthropic_http_stream_to_luv_stream":
      return refreshTransportStream(c, provider, apiKey, recordMeta.request);
    case "bedrock_response_to_luv_reply":
      return refreshBedrockResponse(c, recordMeta.request);
    case "bedrock_stream_to_luv_stream":
      return refreshBedrockStream(c, recordMeta.request);
    default:
      console.log(`  skip (unknown arrow): ${c.morphism}/${c.arrow}/${c.slug}`);
      skipped++;
  }
}

async function verifyMorphismRequestShape(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
): Promise<void> {
  const expected = JSON.parse(
    readFileSync(join(c.dir, "expected.json"), "utf8"),
  );
  const body = JSON.stringify(expected);
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body,
  });
  if (res.status === 200) {
    pass++;
    console.log(`  ✓ ${c.morphism}/${c.arrow}/${c.slug}`);
  } else {
    fail++;
    const text = await res.text();
    console.log(
      `  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
}

async function verifyTransportRequestShape(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
): Promise<void> {
  const expected = JSON.parse(
    readFileSync(join(c.dir, "expected.json"), "utf8"),
  ) as { body: string };
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body: expected.body,
  });
  if (res.status === 200) {
    pass++;
    console.log(`  ✓ ${c.morphism}/${c.arrow}/${c.slug}`);
  } else {
    fail++;
    const text = await res.text();
    console.log(
      `  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
}

async function refreshMorphismResponse(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body: JSON.stringify(request),
  });
  if (res.status !== 200) {
    fail++;
    const text = await res.text();
    console.log(
      `  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
    return;
  }
  const body = await res.text();
  const parsed = JSON.parse(body);
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(parsed) + "\n");
  const reply = provider.responseToReply(parsed);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeReply(reply)) + "\n",
  );
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

async function refreshMorphismStream(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body: JSON.stringify({ ...request, stream: true }),
  });
  if (res.status !== 200) {
    fail++;
    const text = await res.text();
    console.log(
      `  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
    return;
  }
  const raw = await res.text();
  const events = provider.parseSSE(raw);
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(events) + "\n");
  const stream = provider.streamToStream(events);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeStreamReply(stream)) + "\n",
  );
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

async function refreshTransportResponse(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body: JSON.stringify(request),
  });
  const body = await res.text();
  const envelope: HTTPResponse = {
    status: res.status,
    headers: {
      "content-type":
        res.headers.get("content-type") ?? "application/json",
    },
    body,
  };
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(envelope) + "\n");
  const reply = provider.httpResponseToReply(envelope);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeReply(reply)) + "\n",
  );
  written++;
  console.log(
    `  ↻ ${c.morphism}/${c.arrow}/${c.slug} (status ${res.status})`,
  );
}

async function refreshTransportStream(
  c: CaseRef,
  provider: ProviderHooks,
  apiKey: string,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.buildHeaders(apiKey),
    body: JSON.stringify({ ...request, stream: true }),
  });
  const body = await res.text();
  const envelope: HTTPResponse = {
    status: res.status,
    headers: {
      "content-type":
        res.headers.get("content-type") ?? provider.contentTypeStream,
    },
    body,
  };
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(envelope) + "\n");
  const stream = provider.httpStreamToStream(envelope);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeStreamReply(stream)) + "\n",
  );
  written++;
  console.log(
    `  ↻ ${c.morphism}/${c.arrow}/${c.slug} (status ${res.status})`,
  );
}

// ---------- Bedrock refresh ----------

function getBedrockConfig() {
  const region = ENV.AWS_REGION || "us-east-1";
  return {
    region,
    access_key_id: ENV.AWS_ACCESS_KEY_ID || "",
    secret_access_key: ENV.AWS_SECRET_ACCESS_KEY || "",
    session_token: ENV.AWS_SESSION_TOKEN || undefined,
  };
}

async function refreshBedrockResponse(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const config = getBedrockConfig();
  if (!config.access_key_id) { skipped++; return; }
  const modelId = (request as { model_id?: string }).model_id || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const body = JSON.stringify(request.body ?? request);
  const url = `https://bedrock-runtime.${config.region}.amazonaws.com/model/${modelId}/converse`;
  const headers = await signRequest("POST", url, { "content-type": "application/json" }, body, config);
  const res = await fetch(url, { method: "POST", headers, body });
  if (res.status !== 200) {
    fail++;
    const text = await res.text();
    console.log(`  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`);
    return;
  }
  const json = await res.json();
  const reply = bedrock_response_to_luv_reply(json, modelId);
  writeFileSync(join(c.dir, "input.json"), stringify({ response: json, model_id: modelId }) + "\n");
  writeFileSync(join(c.dir, "expected.json"), stringify(encodeReply(reply)) + "\n");
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

async function refreshBedrockStream(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const config = getBedrockConfig();
  if (!config.access_key_id) { skipped++; return; }
  const modelId = (request as { model_id?: string }).model_id || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const body = JSON.stringify(request.body ?? request);
  const url = `https://bedrock-runtime.${config.region}.amazonaws.com/model/${modelId}/converse-stream`;
  const headers = await signRequest("POST", url, { "content-type": "application/json" }, body, config);
  const res = await fetch(url, { method: "POST", headers, body });
  if (res.status !== 200) {
    fail++;
    const text = await res.text();
    console.log(`  ✗ ${c.morphism}/${c.arrow}/${c.slug} — HTTP ${res.status}: ${text.slice(0, 200)}`);
    return;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const events = decodeAllFrames(buf);
  const stream = bedrock_stream_to_luv_stream(events, modelId);
  writeFileSync(join(c.dir, "input.json"), stringify({ events, model_id: modelId }) + "\n");
  writeFileSync(join(c.dir, "expected.json"), stringify(encodeStreamReply(stream)) + "\n");
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

// ---------- Main ----------

async function main() {
  console.log(
    VERIFY_ONLY ? "Verifying request shapes..." : "Refreshing fixtures...",
  );
  for (const c of discoverCases()) {
    await processCase(c);
  }
  console.log(
    `\nSummary: ${pass} verified, ${written} refreshed, ${skipped} skipped, ${fail} failed`,
  );
  if (fail > 0) process.exit(1);
}

await main();
