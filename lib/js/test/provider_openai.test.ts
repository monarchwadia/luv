// Audit: openaiProvider — direct unit tests for the factory's send/sendStream.
// Catches the historical bug where `tools` wasn't propagated from the
// Provider interface through to the underlying send() call.

import { test, expect } from "bun:test";
import { openaiProvider } from "../src/provider_openai.ts";
import type { Tool } from "../src/types.ts";

interface CapturedReq {
  url: string;
  authorization: string | null;
  body: string;
}

function makeFetch(replyText: string, status = 200): {
  fetch: typeof fetch;
  captured: { value: CapturedReq | null };
} {
  const captured: { value: CapturedReq | null } = { value: null };
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    captured.value = {
      url,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    return new Response(replyText, { status });
  };
  return { fetch: impl as typeof fetch, captured };
}

const validReply = JSON.stringify({
  id: "x",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

test("openaiProvider: forwards apiKey as Bearer token", async () => {
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk-the-real-key" }, { fetch });
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(captured.value!.authorization).toBe("Bearer sk-the-real-key");
});

test("openaiProvider: hits default api.openai.com endpoint", async () => {
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk" }, { fetch });
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(captured.value!.url).toBe("https://api.openai.com/v1/chat/completions");
});

test("openaiProvider: baseUrl override changes the endpoint", async () => {
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider(
    { apiKey: "sk", baseUrl: "https://my-proxy.test" },
    { fetch },
  );
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(captured.value!.url).toBe("https://my-proxy.test/v1/chat/completions");
});

test("openaiProvider: tools propagate from ProviderSendOptions to wire request", async () => {
  // Regression: an earlier version dropped tools between Provider.send and toOpenAI.
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk" }, { fetch });
  const tool: Tool = {
    name: "lookup_weather",
    description: "weather lookup",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    handler: async () => ({ ok: true, content: "" }),
  };
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [tool],
  });
  const wire = JSON.parse(captured.value!.body);
  expect(wire.tools).toBeDefined();
  expect(wire.tools[0].function.name).toBe("lookup_weather");
});

test("openaiProvider: maxTokens / temperature pass through to wire request", async () => {
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk" }, { fetch });
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    maxTokens: 256,
    temperature: 0.7,
  });
  const wire = JSON.parse(captured.value!.body);
  expect(wire.max_tokens).toBe(256);
  expect(wire.temperature).toBe(0.7);
});

test("openaiProvider: empty tools array is NOT emitted on the wire", async () => {
  // Avoid surprising provider behavior — empty tools array is meaningless.
  const { fetch, captured } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk" }, { fetch });
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [],
  });
  const wire = JSON.parse(captured.value!.body);
  expect("tools" in wire).toBe(false);
});

test("openaiProvider: send returns a parsed Reply with assistant role", async () => {
  const { fetch } = makeFetch(validReply);
  const provider = openaiProvider({ apiKey: "sk" }, { fetch });
  const reply = await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
  });
  expect(reply.message.role).toBe("assistant");
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("ok");
  expect(reply.stopReason).toBe("end_turn");
  expect(reply.usage?.totalTokens).toBe(2);
});

test("openaiProvider: signal propagates to fetch", async () => {
  let capturedSignal: AbortSignal | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined;
    return new Response(validReply, { status: 200 });
  }) as unknown as typeof fetch;
  const provider = openaiProvider({ apiKey: "sk" }, { fetch: fetchImpl });
  const ctl = new AbortController();
  await provider.send({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    signal: ctl.signal,
  });
  expect(capturedSignal).toBe(ctl.signal);
});

test("openaiProvider: sendStream returns a LuvStream (with .text, .done, .cancel)", () => {
  // Just verify the shape — don't actually drive a stream here (covered in send_stream tests).
  const fetchImpl = (async () => new Response(new ReadableStream(), { status: 200 })) as unknown as typeof fetch;
  const provider = openaiProvider({ apiKey: "sk" }, { fetch: fetchImpl });
  const stream = provider.sendStream({
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
  });
  expect(typeof stream.text).toBe("function");
  expect(typeof stream.cancel).toBe("function");
  expect(stream.done).toBeInstanceOf(Promise);
  // Avoid leaking a hanging promise:
  stream.cancel();
  stream.done.catch(() => {});
});
