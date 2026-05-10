import { test, expect } from "bun:test";
import { send, HttpError } from "../src/send.ts";

const FIXTURE_001 = "/workspaces/luv/core/fixtures/openai/001_single_user/response.json";

async function loadFixture(path: string): Promise<Uint8Array> {
  const data = await Bun.file(path).arrayBuffer();
  return new Uint8Array(data);
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Uint8Array;
}

function makeMockFetch(
  status: number,
  body: BodyInit | Uint8Array,
  capture?: { value: CapturedRequest | null },
): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let bodyBytes: Uint8Array;
    if (init?.body instanceof Uint8Array) {
      bodyBytes = init.body as Uint8Array;
    } else if (typeof init?.body === "string") {
      bodyBytes = new TextEncoder().encode(init.body);
    } else {
      bodyBytes = new Uint8Array();
    }
    if (capture) {
      capture.value = {
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: bodyBytes,
      };
    }
    return new Response(body as BodyInit, { status });
  };
  return impl as typeof fetch;
}

test("send: round-trips 001 fixture into assistant Reply with end_turn", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const reply = await send(
    {
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "Say hello in one short sentence." }],
      maxTokens: 32,
      temperature: 0,
    },
    { fetch: makeMockFetch(200, fixture) },
  );
  expect(reply.message.role).toBe("assistant");
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text.length).toBeGreaterThan(0);
  expect(reply.stopReason).toBe("end_turn");
});

test("send: forwards Authorization header and POSTs to /v1/chat/completions", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const captured: { value: CapturedRequest | null } = { value: null };
  await send(
    {
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "hi" }],
    },
    { fetch: makeMockFetch(200, fixture, captured) },
  );
  expect(captured.value).toBeDefined();
  expect(captured.value!.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(captured.value!.method).toBe("POST");
  expect(captured.value!.headers.get("Authorization")).toBe("Bearer sk-test-key");
  expect(captured.value!.headers.get("Content-Type")).toBe("application/json");

  const body = new TextDecoder().decode(captured.value!.body);
  expect(body).toContain('"model":"gpt-4o-mini"');
  expect(body).toContain('"role":"user"');
  expect(body).toContain('"hi"');
  // optional fields not set → omitted
  expect(body).not.toContain('"max_tokens"');
  expect(body).not.toContain('"stream"');
});

test("send: baseUrl override is honored", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const captured: { value: CapturedRequest | null } = { value: null };
  await send(
    {
      apiKey: "sk",
      model: "gpt-4o-mini",
      conversation: [{ role: "user", text: "hi" }],
      baseUrl: "https://proxy.example.test",
    },
    { fetch: makeMockFetch(200, fixture, captured) },
  );
  expect(captured.value!.url).toBe("https://proxy.example.test/v1/chat/completions");
});

test("send: non-200 throws HttpError carrying the body", async () => {
  const errBody = JSON.stringify({ error: { message: "bad key" } });
  await expect(
    send(
      {
        apiKey: "sk-bad",
        model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "hi" }],
      },
      { fetch: makeMockFetch(401, errBody) },
    ),
  ).rejects.toThrow(HttpError);
});

test("send: malformed JSON response surfaces a parse error", async () => {
  await expect(
    send(
      {
        apiKey: "sk",
        model: "gpt-4o-mini",
        conversation: [{ role: "user", text: "hi" }],
      },
      { fetch: makeMockFetch(200, "not json at all") },
    ),
  ).rejects.toThrow();
});
