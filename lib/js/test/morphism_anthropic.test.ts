// Item C tests: Anthropic morphism + provider round-trip.

import { test, expect } from "bun:test";
import {
  anthropicProvider,
} from "../src/provider_anthropic.ts";
import {
  fromAnthropic,
  toAnthropic,
  type AnthropicWireResponse,
} from "../src/morphism_anthropic.ts";
import type { Conversation, Tool } from "../src/types.ts";

const lookupWeather: Tool = {
  name: "lookup_weather",
  description: "Returns current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  handler: async () => ({ ok: true, content: "" }),
};

// ---------------------------------------------------------------------------
// toAnthropic

test("toAnthropic: simple user-only conversation", () => {
  const wire = toAnthropic({
    conversation: [{ role: "user", text: "hi" }],
    model: "claude-3-5-sonnet-20241022",
  });
  expect(wire).toEqual({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024, // default
    messages: [{ role: "user", content: "hi" }],
  });
});

test("toAnthropic: system message lifts to top-level `system` field", () => {
  const wire = toAnthropic({
    conversation: [
      { role: "system", text: "be terse" },
      { role: "user", text: "hi" },
    ],
    model: "claude-3-5-sonnet-20241022",
  });
  expect(wire.system).toBe("be terse");
  expect(wire.messages.length).toBe(1);
  expect(wire.messages[0]).toEqual({ role: "user", content: "hi" });
});

test("toAnthropic: multiple system messages are concatenated with blank lines", () => {
  const wire = toAnthropic({
    conversation: [
      { role: "system", text: "be terse" },
      { role: "system", text: "answer in english" },
      { role: "user", text: "hi" },
    ],
    model: "claude-3-5-sonnet-20241022",
  });
  expect(wire.system).toBe("be terse\n\nanswer in english");
});

test("toAnthropic: assistant with toolCalls becomes content blocks", () => {
  const conv: Conversation = [
    { role: "user", text: "weather in tokyo?" },
    {
      role: "assistant",
      text: "let me check",
      toolCalls: [
        { id: "tool_abc", name: "lookup_weather", arguments: { city: "Tokyo" } },
      ],
    },
  ];
  const wire = toAnthropic({ conversation: conv, model: "x" });
  expect(wire.messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tool_abc", name: "lookup_weather", input: { city: "Tokyo" } },
    ],
  });
});

test("toAnthropic: assistant with toolCalls and empty text emits only tool_use blocks", () => {
  const wire = toAnthropic({
    conversation: [
      { role: "user", text: "x" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "lookup_weather", arguments: { city: "Tokyo" } }],
      },
    ],
    model: "x",
  });
  expect(wire.messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "tool_use", id: "c1", name: "lookup_weather", input: { city: "Tokyo" } },
    ],
  });
});

test("toAnthropic: tool result becomes a user message with tool_result block", () => {
  const conv: Conversation = [
    { role: "user", text: "weather in tokyo?" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "c1", name: "lookup_weather", arguments: { city: "Tokyo" } }],
    },
    {
      role: "tool",
      callId: "c1",
      result: { ok: true, content: '{"temp_c":18}' },
    },
  ];
  const wire = toAnthropic({ conversation: conv, model: "x" });
  expect(wire.messages.length).toBe(3);
  expect(wire.messages[2]).toEqual({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "c1", content: '{"temp_c":18}' }],
  });
});

test("toAnthropic: tool error is marked is_error: true", () => {
  const wire = toAnthropic({
    conversation: [
      { role: "user", text: "x" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "lookup_weather", arguments: {} }],
      },
      { role: "tool", callId: "c1", result: { ok: false, error: "boom" } },
    ],
    model: "x",
  });
  const lastBlock = (wire.messages[2]!.content as { type: string; is_error?: boolean }[])[0]!;
  expect(lastBlock.is_error).toBe(true);
});

test("toAnthropic: tools[] maps to anthropic tools[] with input_schema", () => {
  const wire = toAnthropic({
    conversation: [{ role: "user", text: "x" }],
    model: "x",
    tools: [lookupWeather],
  });
  expect(wire.tools?.[0]).toEqual({
    name: "lookup_weather",
    description: "Returns current weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  });
});

test("toAnthropic: max_tokens passed through when set", () => {
  const wire = toAnthropic({
    conversation: [{ role: "user", text: "x" }],
    model: "x",
    maxTokens: 256,
  });
  expect(wire.max_tokens).toBe(256);
});

// ---------------------------------------------------------------------------
// fromAnthropic

test("fromAnthropic: text-only response parses to assistant Reply", () => {
  const wire: AnthropicWireResponse = {
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const reply = fromAnthropic(wire);
  expect(reply.message.role).toBe("assistant");
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("Hello!");
  expect(reply.message.toolCalls).toBeUndefined();
  expect(reply.stopReason).toBe("end_turn");
  expect(reply.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test("fromAnthropic: text + tool_use blocks combine into single assistant message with toolCalls", () => {
  const wire: AnthropicWireResponse = {
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "c1", name: "lookup_weather", input: { city: "Tokyo" } },
    ],
    model: "x",
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 8 },
  };
  const reply = fromAnthropic(wire);
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("let me check");
  expect(reply.message.toolCalls?.length).toBe(1);
  expect(reply.message.toolCalls?.[0]?.id).toBe("c1");
  expect((reply.message.toolCalls?.[0]?.arguments as { city: string }).city).toBe("Tokyo");
  expect(reply.stopReason).toBe("tool_use");
});

test("fromAnthropic: stop_reason vocabulary maps cleanly", () => {
  const make = (s: string): AnthropicWireResponse => ({
    id: "x",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    model: "x",
    stop_reason: s,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  expect(fromAnthropic(make("end_turn")).stopReason).toBe("end_turn");
  expect(fromAnthropic(make("max_tokens")).stopReason).toBe("max_tokens");
  expect(fromAnthropic(make("stop_sequence")).stopReason).toBe("stop_sequence");
  expect(fromAnthropic(make("tool_use")).stopReason).toBe("tool_use");
  expect(fromAnthropic(make("weird_unknown")).stopReason).toBe("other");
});

test("fromAnthropic: unknown block types are silently dropped", () => {
  const wire: AnthropicWireResponse = {
    id: "x",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", text: "internal monologue dropped" },
      { type: "text", text: "actual reply" },
    ],
    model: "x",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const reply = fromAnthropic(wire);
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("actual reply");
});

// ---------------------------------------------------------------------------
// anthropicProvider (mocked fetch)

function makeMockFetch(wireResponse: AnthropicWireResponse): typeof fetch {
  const impl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(wireResponse), { status: 200 });
  };
  return impl as typeof fetch;
}

test("anthropicProvider.send: round-trip via mocked fetch", async () => {
  const wire: AnthropicWireResponse = {
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello from Claude" }],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 4 },
  };
  const provider = anthropicProvider(
    { apiKey: "sk-ant-test" },
    { fetch: makeMockFetch(wire) },
  );
  const reply = await provider.send({
    model: "claude-3-5-sonnet-20241022",
    conversation: [{ role: "user", text: "hi" }],
  });
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("Hello from Claude");
  expect(reply.usage?.totalTokens).toBe(12);
});

test("anthropicProvider.send: forwards x-api-key + anthropic-version headers", async () => {
  let capturedHeaders: Headers = new Headers();
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        id: "x", type: "message", role: "assistant",
        content: [{ type: "text", text: "x" }],
        model: "x", stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const provider = anthropicProvider(
    { apiKey: "sk-ant-test" },
    { fetch: captureFetch },
  );
  await provider.send({
    model: "x",
    conversation: [{ role: "user", text: "x" }],
  });
  expect(capturedHeaders.get("x-api-key")).toBe("sk-ant-test");
  expect(capturedHeaders.get("anthropic-version")).toBe("2023-06-01");
});

test("anthropicProvider.sendStream: throws not-implemented for now", () => {
  const provider = anthropicProvider({ apiKey: "sk" });
  expect(() =>
    provider.sendStream({
      model: "x",
      conversation: [{ role: "user", text: "x" }],
    }),
  ).toThrow(/not yet implemented/);
});
