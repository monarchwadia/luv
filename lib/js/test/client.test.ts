// DX-5 red tests: createClient bundles send/sendStream/runAgent without
// re-passing creds.

import { test, expect } from "bun:test";
import { createClient } from "../src/client.ts";
import type { Tool } from "../src/types.ts";

const FIXTURE_001 = "/workspaces/luv/core/fixtures/openai/001_single_user/response.json";

async function loadFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function makeMockFetch(status: number, body: BodyInit | Uint8Array): typeof fetch {
  const impl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(body as BodyInit, { status });
  };
  return impl as typeof fetch;
}

test("createClient.send: works without re-passing apiKey", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const client = createClient(
    { apiKey: "sk-test", baseUrl: "https://api.openai.com" },
    { fetch: makeMockFetch(200, fixture) },
  );
  const reply = await client.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(reply.message.role).toBe("assistant");
});

test("createClient.runAgent: works without re-passing provider/apiKey", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const client = createClient(
    { apiKey: "sk-test" },
    { fetch: makeMockFetch(200, fixture) },
  );
  const result = await client.runAgent({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(result.reason).toBe("end_turn");
  expect(result.iterations).toBe(1);
});

test("createClient.runAgent: passes tools through", async () => {
  // First call returns tool_calls; second returns text.
  let callIdx = 0;
  const responses = [
    {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "echo", arguments: '{"msg":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      id: "y",
      object: "chat.completion",
      created: 2,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok done" },
          finish_reason: "stop",
        },
      ],
    },
  ];
  const fetchImpl = (async () => {
    const body = JSON.stringify(responses[callIdx++]);
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const client = createClient({ apiKey: "sk" }, { fetch: fetchImpl });
  const echoTool: Tool = {
    name: "echo",
    description: "echoes",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    handler: async (args) => ({ ok: true, content: (args as { msg: string }).msg }),
  };
  const result = await client.runAgent({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "echo hi" }],
    tools: [echoTool],
  });
  expect(result.reason).toBe("end_turn");
  expect(result.iterations).toBe(2);
});

test("createClient.provider: exposes the underlying Provider", async () => {
  const fixture = await loadFixture(FIXTURE_001);
  const client = createClient(
    { apiKey: "sk" },
    { fetch: makeMockFetch(200, fixture) },
  );
  expect(typeof client.provider.send).toBe("function");
  expect(typeof client.provider.sendStream).toBe("function");
});

test("createClient: exposes error classes for ergonomic instanceof catching", () => {
  const client = createClient({ apiKey: "sk" });
  // The classes on the client should reference the same constructors as imports.
  expect(client.HttpError).toBeDefined();
  expect(client.AuthError).toBeDefined();
  expect(client.RateLimitError).toBeDefined();
  expect(client.ContextWindowExceededError).toBeDefined();
  expect(client.ContentFilterError).toBeDefined();
  expect(client.ServiceUnavailableError).toBeDefined();
  // Verify identity, not just defined-ness.
  const err = new client.RateLimitError(429, "", 1000);
  expect(err).toBeInstanceOf(client.RateLimitError);
  expect(err).toBeInstanceOf(client.HttpError);
});
