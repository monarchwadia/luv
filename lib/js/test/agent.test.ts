// Phase L red tests: runAgent + Provider abstraction, exercised via
// scripted scenario fixtures replayed through a mock Provider.

import { test, expect } from "bun:test";
import { runAgent } from "../src/agent.ts";
import type {
  Conversation,
  Message,
  Provider,
  ProviderSendOptions,
  Reply,
  Tool,
  ToolResult,
} from "../src/types.ts";

const SCENARIO_DIR = "/workspaces/luv/core/fixtures/agent_scenarios";

interface ScenarioFile {
  starting_conversation: Conversation;
  tools: Array<{
    name: string;
    description: string;
    input_schema: unknown;
  }>;
  tool_handlers: Record<string, ToolResult>;
  provider_replies: Reply[];
  max_iterations: number;
  expected_final_conversation?: readonly Message[];
  expected_reason: string;
  expected_iterations: number;
}

async function loadScenario(slug: string): Promise<ScenarioFile> {
  const path = `${SCENARIO_DIR}/${slug}/scenario.json`;
  return JSON.parse(await Bun.file(path).text()) as ScenarioFile;
}

function makeMockProvider(replies: Reply[]): Provider {
  let i = 0;
  return {
    send: async (_opts: ProviderSendOptions): Promise<Reply> => {
      if (i >= replies.length) {
        throw new Error(`mock provider out of replies (sent ${i})`);
      }
      return replies[i++]!;
    },
    sendStream: () => {
      throw new Error("sendStream not used in agent scenario tests");
    },
  };
}

function makeToolsFromScenario(s: ScenarioFile): Tool[] {
  return s.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as Tool["inputSchema"],
    handler: async () => s.tool_handlers[t.name] ?? { ok: false, error: "no handler" },
  }));
}

test("runAgent: 001 simple chat — single turn, no tools, end_turn", async () => {
  const s = await loadScenario("001_simple_chat");
  const result = await runAgent({
    provider: makeMockProvider(s.provider_replies),
    model: "gpt-4o-mini",
    conversation: s.starting_conversation,
    tools: makeToolsFromScenario(s),
    maxIterations: s.max_iterations,
  });
  expect(result.reason).toBe(s.expected_reason as typeof result.reason);
  expect(result.iterations).toBe(s.expected_iterations);
  expect(result.conversation).toEqual(s.expected_final_conversation as Conversation);
});

test("runAgent: 002 tool round trip — appends assistant + tool result + final assistant", async () => {
  const s = await loadScenario("002_tool_round_trip");
  const result = await runAgent({
    provider: makeMockProvider(s.provider_replies),
    model: "gpt-4o-mini",
    conversation: s.starting_conversation,
    tools: makeToolsFromScenario(s),
    maxIterations: s.max_iterations,
  });
  expect(result.reason).toBe(s.expected_reason as typeof result.reason);
  expect(result.iterations).toBe(s.expected_iterations);
  expect(result.conversation).toEqual(s.expected_final_conversation as Conversation);
});

test("runAgent: 003 hits max_iterations cap when model keeps requesting tools", async () => {
  const s = await loadScenario("003_max_iterations");
  const result = await runAgent({
    provider: makeMockProvider(s.provider_replies),
    model: "gpt-4o-mini",
    conversation: s.starting_conversation,
    tools: makeToolsFromScenario(s),
    maxIterations: s.max_iterations,
  });
  expect(result.reason).toBe("max_iterations");
  // After 2 iterations of (assistant tool_call + tool_result), iteration counter is 3 when we check the cap.
  expect(result.iterations).toBe(s.expected_iterations);
  // Last message is the second tool result (loop bailed before the third send).
  const last = result.conversation[result.conversation.length - 1]!;
  expect(last.role).toBe("tool");
});

test("runAgent: lifecycle hooks fire for each turn / tool call / result / finish", async () => {
  const s = await loadScenario("002_tool_round_trip");
  const turns: number[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let finishReason = "";

  await runAgent({
    provider: makeMockProvider(s.provider_replies),
    model: "gpt-4o-mini",
    conversation: s.starting_conversation,
    tools: makeToolsFromScenario(s),
    maxIterations: s.max_iterations,
    onTurnStart: (i) => turns.push(i),
    onToolCall: (c) => toolCalls.push(c.name),
    onToolResult: (c, r) => toolResults.push(`${c.name}:${r.ok ? "ok" : "err"}`),
    onFinish: (reason) => { finishReason = reason; },
  });
  expect(turns).toEqual([1, 2]);
  expect(toolCalls).toEqual(["lookup_weather"]);
  expect(toolResults).toEqual(["lookup_weather:ok"]);
  expect(finishReason).toBe("end_turn");
});

test("runAgent: AbortSignal cancels mid-loop and returns aborted", async () => {
  const s = await loadScenario("003_max_iterations");
  const ctl = new AbortController();
  const result = await runAgent({
    provider: {
      send: async () => {
        ctl.abort();
        return s.provider_replies[0]!;
      },
      sendStream: () => { throw new Error("not used"); },
    },
    model: "gpt-4o-mini",
    conversation: s.starting_conversation,
    tools: makeToolsFromScenario(s),
    maxIterations: 100,
    signal: ctl.signal,
  });
  expect(result.reason).toBe("aborted");
});

test("runAgent: unknown tool name produces ok=false tool result", async () => {
  const provider = makeMockProvider([
    {
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "no_such_tool", arguments: {} }],
      },
      stopReason: "tool_use",
    },
    {
      message: { role: "assistant", text: "I cannot do that." },
      stopReason: "end_turn",
    },
  ]);
  const result = await runAgent({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "do something impossible" }],
    tools: [],
    maxIterations: 5,
  });
  expect(result.reason).toBe("end_turn");
  // Conversation should have the tool result message with ok=false
  const toolMsg = result.conversation.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  if (toolMsg && toolMsg.role === "tool") {
    expect(toolMsg.result.ok).toBe(false);
    if (!toolMsg.result.ok) expect(toolMsg.result.error).toContain("no_such_tool");
  }
});
