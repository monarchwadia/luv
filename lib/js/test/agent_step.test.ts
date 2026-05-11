// DX-7 red tests: agentStep — single-iteration variant of runAgent that lets
// callers drive the loop themselves (pause/resume, approval flows).

import { test, expect } from "bun:test";
import { agentStep } from "../src/agent.ts";
import type { Conversation, Message, Provider, Reply, Tool } from "../src/types.ts";

function makeMockProvider(replies: Reply[]): Provider {
  let i = 0;
  return {
    send: async () => {
      if (i >= replies.length) throw new Error("out of replies");
      return replies[i++]!;
    },
    sendStream: () => { throw new Error("not used"); },
  };
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  handler: async (args) => ({ ok: true, content: (args as { msg: string }).msg }),
};

test("agentStep: single text reply → done=true, end_turn", async () => {
  const provider = makeMockProvider([
    { message: { role: "assistant", text: "Hello!" }, stopReason: "end_turn" },
  ]);
  const result = await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "hi" }],
  });
  expect(result.done).toBe(true);
  expect(result.reason).toBe("end_turn");
  expect(result.newMessages.length).toBe(1);
  expect(result.newMessages[0]?.role).toBe("assistant");
});

test("agentStep: tool call reply → done=false, continue", async () => {
  const provider = makeMockProvider([
    {
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { msg: "hi" } }],
      },
      stopReason: "tool_use",
    },
  ]);
  const result = await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "echo hi" }],
    tools: [echoTool],
  });
  expect(result.done).toBe(false);
  expect(result.reason).toBe("continue");
  // Single assistant message with colocated tool result on its toolCall.
  expect(result.newMessages.length).toBe(1);
  const m = result.newMessages[0]!;
  expect(m.role).toBe("assistant");
  if (m.role === "assistant") {
    expect(m.toolCalls?.length).toBe(1);
    expect(m.toolCalls?.[0]?.result).toBeDefined();
  }
});

test("agentStep: caller drives the loop, can intervene between steps", async () => {
  const provider = makeMockProvider([
    {
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { msg: "first" } }],
      },
      stopReason: "tool_use",
    },
    {
      message: { role: "assistant", text: "all done" },
      stopReason: "end_turn",
    },
  ]);

  let conv: Message[] = [{ role: "user", text: "go" }];
  const interventions: string[] = [];

  for (let i = 0; i < 5; i++) {
    const step = await agentStep({
      provider,
      model: "gpt-4o-mini",
      conversation: conv as Conversation,
      tools: [echoTool],
    });
    conv = [...conv, ...step.newMessages];
    // Caller intervention: track when an assistant message gains a resolved tool call.
    const last = step.newMessages[step.newMessages.length - 1];
    if (last?.role === "assistant" && last.toolCalls?.some((c) => c.result !== undefined)) {
      interventions.push("saw tool result");
    }
    if (step.done) break;
  }

  expect(interventions).toEqual(["saw tool result"]);
  expect(conv.length).toBe(3); // user + assistant(call+result) + assistant(text)
  const last = conv[conv.length - 1];
  expect(last?.role).toBe("assistant");
  if (last?.role === "assistant") expect(last.text).toBe("all done");
});

test("agentStep: aborted signal → done=true, aborted", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const provider = makeMockProvider([
    { message: { role: "assistant", text: "x" }, stopReason: "end_turn" },
  ]);
  const result = await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    signal: ctl.signal,
  });
  expect(result.done).toBe(true);
  expect(result.reason).toBe("aborted");
  expect(result.newMessages.length).toBe(0);
});

test("agentStep: surfaces caught provider error via result.error", async () => {
  const provider: Provider = {
    send: async () => { throw new Error("network down"); },
    sendStream: () => { throw new Error("not used"); },
  };
  const result = await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
  });
  expect(result.done).toBe(true);
  expect(result.reason).toBe("error");
  expect(result.error).toBeDefined();
  expect(result.error?.message).toBe("network down");
});

test("agentStep: lifecycle hooks fire (onTurnStart, onToolCall, onToolResult, onFinish)", async () => {
  const provider = makeMockProvider([
    {
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { msg: "hi" } }],
      },
      stopReason: "tool_use",
    },
  ]);
  let turnStartObserved = 0;
  let toolCallName = "";
  let toolResultOk: boolean | undefined;
  let finishReason = "";

  await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "go" }],
    tools: [echoTool],
    onTurnStart: (i) => { turnStartObserved = i; },
    onToolCall: (c) => { toolCallName = c.name; },
    onToolResult: (_c, r) => { toolResultOk = r.ok; },
    onFinish: (r) => { finishReason = r; },
  });

  expect(turnStartObserved).toBe(1);
  expect(toolCallName).toBe("echo");
  expect(toolResultOk).toBe(true);
  // For a single step, finish reason is the same as the step's reason.
  expect(finishReason).toBe("continue");
});
