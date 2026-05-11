import { test, expect } from "bun:test";
import type {
  AgentFinishReason,
  AgentOptions,
  AgentResult,
  Conversation,
  Message,
  Provider,
  Reply,
  Tool,
  ToolCall,
  ToolResult,
} from "../src/types.ts";

test("Tool: name + description + input schema", () => {
  const t: Tool = {
    name: "lookup_weather",
    description: "Returns current weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    handler: async (_args) => ({ ok: true, content: JSON.stringify({ temp_c: 18 }) }),
  };
  expect(t.name).toBe("lookup_weather");
  expect(t.description).toContain("weather");
  expect(typeof t.handler).toBe("function");
});

test("ToolCall: id + name + parsed arguments", () => {
  const c: ToolCall = {
    id: "call_abc123",
    name: "lookup_weather",
    arguments: { city: "Tokyo" },
  };
  expect(c.id).toBe("call_abc123");
  expect(c.name).toBe("lookup_weather");
  expect((c.arguments as { city: string }).city).toBe("Tokyo");
});

test("ToolResult: ok variant", () => {
  const r: ToolResult = { ok: true, content: '{"temp_c":18}' };
  if (r.ok) expect(r.content).toBe('{"temp_c":18}');
  else throw new Error("expected ok variant");
});

test("ToolResult: err variant", () => {
  const r: ToolResult = { ok: false, error: "tool not found" };
  if (!r.ok) expect(r.error).toBe("tool not found");
  else throw new Error("expected err variant");
});

test("Message system / user just have role + text", () => {
  const a: Message = { role: "system", text: "be terse" };
  const b: Message = { role: "user", text: "hello" };
  expect(a.role).toBe("system");
  expect(b.text).toBe("hello");
});

test("Message assistant can carry toolCalls", () => {
  const m: Message = {
    role: "assistant",
    text: "let me check",
    toolCalls: [
      { id: "c1", name: "lookup_weather", arguments: { city: "Tokyo" } },
    ],
  };
  if (m.role === "assistant") {
    expect(m.text).toBe("let me check");
    expect(m.toolCalls?.[0]?.id).toBe("c1");
  } else throw new Error("narrowing failed");
});

test("Resolved tool call carries its result inline on the ToolCall", () => {
  const m: Message = {
    role: "assistant",
    text: "",
    toolCalls: [{
      id: "c1",
      name: "lookup_weather",
      arguments: { city: "Tokyo" },
      result: { ok: true, content: '{"temp_c":18}' },
    }],
  };
  if (m.role === "assistant") {
    const c = m.toolCalls?.[0]!;
    expect(c.id).toBe("c1");
    expect(c.result).toBeDefined();
    if (c.result?.ok) expect(c.result.content).toContain("temp_c");
    else throw new Error("expected ok result");
  } else throw new Error("narrowing failed");
});

test("Conversation can mix all message variants in order", () => {
  const conv: Conversation = [
    { role: "system", text: "be terse" },
    { role: "user", text: "weather in Tokyo?" },
    {
      role: "assistant",
      text: "checking…",
      toolCalls: [{
        id: "c1",
        name: "lookup_weather",
        arguments: { city: "Tokyo" },
        result: { ok: true, content: '{"temp_c":18}' },
      }],
    },
    { role: "assistant", text: "It's 18°C in Tokyo." },
  ];
  expect(conv.length).toBe(4);
  expect(conv[0]!.role).toBe("system");
  expect(conv[2]!.role).toBe("assistant");
  if (conv[2]!.role === "assistant") {
    expect(conv[2]!.toolCalls?.length).toBe(1);
    expect(conv[2]!.toolCalls?.[0]?.result).toBeDefined();
  }
  expect(conv[3]!.role).toBe("assistant");
});

test("Provider interface has send + sendStream signatures", () => {
  const fakeProvider: Provider = {
    send: async (_opts) => ({
      message: { role: "assistant", text: "ok" },
      stopReason: "end_turn",
    }),
    sendStream: (_opts) => {
      throw new Error("not used in this test");
    },
  };
  expect(typeof fakeProvider.send).toBe("function");
  expect(typeof fakeProvider.sendStream).toBe("function");
});

test("AgentOptions accepts provider + tools + hooks", () => {
  const fakeProvider: Provider = {
    send: async () => ({ message: { role: "assistant", text: "ok" }, stopReason: "end_turn" }),
    sendStream: () => { throw new Error("not used"); },
  };
  const noopTool: Tool = {
    name: "noop",
    description: "does nothing",
    inputSchema: { type: "object" },
    handler: async () => ({ ok: true, content: "" }),
  };
  let turnsObserved = 0;
  const opts: AgentOptions = {
    provider: fakeProvider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
    tools: [noopTool],
    maxIterations: 5,
    onTurnStart: (i) => { turnsObserved = i; },
  };
  expect(opts.tools?.length).toBe(1);
  expect(opts.maxIterations).toBe(5);
  // exercise the hook signature so unused-locals stays quiet
  opts.onTurnStart?.(1);
  expect(turnsObserved).toBe(1);
});

test("AgentResult exposes final conversation + reason + iterations", () => {
  const reason: AgentFinishReason = "end_turn";
  const r: AgentResult = {
    conversation: [{ role: "user", text: "hi" }],
    reason,
    iterations: 1,
  };
  expect(r.iterations).toBe(1);
  expect(r.reason).toBe("end_turn");
  expect(r.conversation.length).toBe(1);
});

test("Reply.message can be an assistant variant", () => {
  const r: Reply = {
    message: { role: "assistant", text: "ok" },
    stopReason: "end_turn",
  };
  expect(r.message.role).toBe("assistant");
});
