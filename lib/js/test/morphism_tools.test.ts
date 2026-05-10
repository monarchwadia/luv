// Phase K red tests: morphism extensions for tool calling.

import { test, expect } from "bun:test";
import { fromOpenAI, toOpenAI } from "../src/morphism.ts";
import type { Conversation, Tool } from "../src/types.ts";

const FIXTURE_DIR = "/workspaces/luv/core/fixtures/openai";

const lookupWeather: Tool = {
  name: "lookup_weather",
  description: "Returns current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
  // Handler not used by the morphism; only needed to satisfy the Tool type.
  handler: async () => ({ ok: true, content: "" }),
};

test("toOpenAI: 020 — emits tools array alongside messages", async () => {
  const conv: Conversation = [
    { role: "user", text: "What's the weather in Tokyo?" },
  ];
  const wire = toOpenAI({
    conversation: conv,
    model: "gpt-4o-mini",
    tools: [lookupWeather],
  });
  const expected = JSON.parse(
    await Bun.file(`${FIXTURE_DIR}/020_tool_calls_basic/request.json`).text(),
  );
  expect(wire).toEqual(expected);
});

test("fromOpenAI: 020 — parses tool_calls into Reply.message.toolCalls + tool_use stop", async () => {
  const wire = JSON.parse(
    await Bun.file(`${FIXTURE_DIR}/020_tool_calls_basic/response.json`).text(),
  );
  const reply = fromOpenAI(wire);
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text).toBe("");
  expect(reply.message.toolCalls?.length).toBe(1);
  expect(reply.message.toolCalls?.[0]?.id).toBe("call_abc123");
  expect(reply.message.toolCalls?.[0]?.name).toBe("lookup_weather");
  expect((reply.message.toolCalls?.[0]?.arguments as { city: string }).city).toBe("Tokyo");
  expect(reply.stopReason).toBe("tool_use");
});

test("toOpenAI: 021 — round-trip serializes assistant.toolCalls + tool result message", async () => {
  const conv: Conversation = [
    { role: "user", text: "What's the weather in Tokyo?" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        {
          id: "call_abc123",
          name: "lookup_weather",
          arguments: { city: "Tokyo" },
        },
      ],
    },
    {
      role: "tool",
      callId: "call_abc123",
      result: { ok: true, content: '{"temp_c":18,"condition":"sunny"}' },
    },
  ];
  const wire = toOpenAI({
    conversation: conv,
    model: "gpt-4o-mini",
    tools: [lookupWeather],
  });
  const expected = JSON.parse(
    await Bun.file(`${FIXTURE_DIR}/021_tool_round_trip/request.json`).text(),
  );
  expect(wire).toEqual(expected);
});

test("fromOpenAI: 021 — text reply after tool result is plain assistant text", async () => {
  const wire = JSON.parse(
    await Bun.file(`${FIXTURE_DIR}/021_tool_round_trip/response.json`).text(),
  );
  const reply = fromOpenAI(wire);
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text).toContain("Tokyo");
  expect(reply.message.toolCalls).toBeUndefined();
  expect(reply.stopReason).toBe("end_turn");
});

test("fromOpenAI: 022 — parallel tool calls yield two ToolCall entries in order", async () => {
  const wire = JSON.parse(
    await Bun.file(`${FIXTURE_DIR}/022_parallel_tool_calls/response.json`).text(),
  );
  const reply = fromOpenAI(wire);
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.toolCalls?.length).toBe(2);
  expect(reply.message.toolCalls?.[0]?.id).toBe("call_tokyo_1");
  expect((reply.message.toolCalls?.[0]?.arguments as { city: string }).city).toBe("Tokyo");
  expect(reply.message.toolCalls?.[1]?.id).toBe("call_berlin_1");
  expect((reply.message.toolCalls?.[1]?.arguments as { city: string }).city).toBe("Berlin");
  expect(reply.stopReason).toBe("tool_use");
});

test("toOpenAI: tool result with ok=false serializes the error as content", () => {
  const conv: Conversation = [
    { role: "user", text: "x" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "c1", name: "lookup_weather", arguments: { city: "Tokyo" } }],
    },
    {
      role: "tool",
      callId: "c1",
      result: { ok: false, error: "city not found" },
    },
  ];
  const wire = toOpenAI({ conversation: conv, model: "gpt-4o-mini" });
  expect(wire.messages[2]).toEqual({
    role: "tool",
    tool_call_id: "c1",
    content: "Error: city not found",
  });
});
