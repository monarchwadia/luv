// Refresh recordable provider-response fixtures by hitting the live API,
// and verify the luv->provider request-shape cases are still accepted.
//
// Usage:
//   bun run scripts/record.ts            (refresh everything)
//   bun run scripts/record.ts --verify   (no writes; just verify request shapes)
//
// Requires OPENAI_API_KEY in repo-root .env or environment.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
  encodeReply,
  encodeStreamReply,
  stringify,
} from "../src/index.js";

const SPEC_ROOT = join(import.meta.dir, "..", "..", "..", "spec");
const ENV_PATH = join(import.meta.dir, "..", "..", "..", ".env");

const API_KEY = loadApiKey();
const VERIFY_ONLY = process.argv.includes("--verify");

function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^OPENAI_API_KEY=(.*)$/);
      if (m) return m[1].trim().replace(/^"|"$/g, "");
    }
  }
  console.error(
    "OPENAI_API_KEY not found in environment or " + ENV_PATH,
  );
  process.exit(1);
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

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

let pass = 0;
let fail = 0;
let written = 0;

async function processCase(c: CaseRef): Promise<void> {
  // Request-shape cases: send expected.json's body to OpenAI; verify 200.
  if (c.arrow === "luv_conversation_to_openai_request") {
    return verifyRequestShape(c, "morphism");
  }
  if (c.arrow === "luv_send_to_openai_http_request") {
    return verifyRequestShape(c, "transport");
  }

  // Refresh fixture cases: send record.json's request, capture response.
  const recordPath = join(c.dir, "record.json");
  if (!existsSync(recordPath)) {
    return; // Not refreshable (synthetic, or no record metadata).
  }

  const recordMeta = JSON.parse(readFileSync(recordPath, "utf8")) as {
    request: Record<string, unknown>;
  };

  switch (c.arrow) {
    case "openai_response_to_luv_reply":
      return refreshNonStreamingMorphism(c, recordMeta.request);
    case "openai_stream_to_luv_stream":
      return refreshStreamingMorphism(c, recordMeta.request);
    case "openai_http_response_to_luv_reply":
      return refreshNonStreamingTransport(c, recordMeta.request);
    case "openai_http_stream_to_luv_stream":
      return refreshStreamingTransport(c, recordMeta.request);
    default:
      console.log(`  skip (unknown arrow): ${c.morphism}/${c.arrow}/${c.slug}`);
  }
}

async function verifyRequestShape(
  c: CaseRef,
  kind: "morphism" | "transport",
): Promise<void> {
  const expected = JSON.parse(
    readFileSync(join(c.dir, "expected.json"), "utf8"),
  );
  const body =
    kind === "morphism" ? JSON.stringify(expected) : expected.body;

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
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

async function refreshNonStreamingMorphism(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
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
  // Re-stringify minified.
  const body = await res.text();
  const parsed = JSON.parse(body);
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(parsed) + "\n");
  // Regenerate expected.json from current impl. Human reviews via git diff.
  const reply = openai_response_to_luv_reply(parsed);
  writeFileSync(join(c.dir, "expected.json"), stringify(encodeReply(reply)) + "\n");
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

async function refreshStreamingMorphism(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
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
  const chunks = parseSSE(raw);
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(chunks) + "\n");
  const stream = openai_stream_to_luv_stream(chunks);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeStreamReply(stream)) + "\n",
  );
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug}`);
}

async function refreshNonStreamingTransport(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = await res.text();
  const envelope: HTTPResponse = {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    body,
  };
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(envelope) + "\n");
  const reply = openai_http_response_to_luv_reply(envelope);
  writeFileSync(join(c.dir, "expected.json"), stringify(encodeReply(reply)) + "\n");
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug} (status ${res.status})`);
}

async function refreshStreamingTransport(
  c: CaseRef,
  request: Record<string, unknown>,
): Promise<void> {
  if (VERIFY_ONLY) return;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, stream: true }),
  });
  const body = await res.text();
  const envelope: HTTPResponse = {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream" },
    body,
  };
  writeFileSync(join(c.dir, "input.json"), JSON.stringify(envelope) + "\n");
  const stream = openai_http_stream_to_luv_stream(envelope);
  writeFileSync(
    join(c.dir, "expected.json"),
    stringify(encodeStreamReply(stream)) + "\n",
  );
  written++;
  console.log(`  ↻ ${c.morphism}/${c.arrow}/${c.slug} (status ${res.status})`);
}

function parseSSE(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const event of body.split("\n\n")) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return chunks;
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        // skip
      }
    }
  }
  return chunks;
}

async function main() {
  console.log(VERIFY_ONLY ? "Verifying request shapes..." : "Refreshing fixtures...");
  const cases = discoverCases();
  for (const c of cases) {
    await processCase(c);
  }
  console.log(
    `\nSummary: ${pass} verified, ${written} refreshed, ${fail} failed`,
  );
  if (fail > 0) process.exit(1);
}

await main();
