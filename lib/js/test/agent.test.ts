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

test("runAgent: surfaces caught provider error via result.error", async () => {
  const provider: Provider = {
    send: async () => { throw new Error("boom"); },
    sendStream: () => { throw new Error("not used"); },
  };
  const result = await runAgent({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
  });
  expect(result.reason).toBe("error");
  expect(result.error).toBeDefined();
  expect(result.error?.message).toBe("boom");
});

test("runAgent: does NOT mutate the input conversation array", async () => {
  const original: Message[] = [{ role: "user", text: "hi" }];
  const snapshot = JSON.stringify(original);
  const provider: Provider = {
    async send() {
      return { message: { role: "assistant", text: "ok" }, stopReason: "end_turn" };
    },
    sendStream() { throw new Error("not used"); },
  };
  await runAgent({ provider, model: "gpt-4o-mini", conversation: original });
  // Caller's array is untouched even though loop appended internally.
  expect(JSON.stringify(original)).toBe(snapshot);
  expect(original.length).toBe(1);
});

test("runAgent: executes parallel tool calls concurrently (not sequentially)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowTool: Tool = {
    name: "slow",
    description: "takes time",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { ok: true, content: "done" };
    },
  };
  const provider: Provider = (() => {
    let i = 0;
    return {
      async send() {
        i++;
        if (i === 1) {
          return {
            message: {
              role: "assistant",
              text: "",
              toolCalls: [
                { id: "a", name: "slow", arguments: {} },
                { id: "b", name: "slow", arguments: {} },
                { id: "c", name: "slow", arguments: {} },
              ],
            },
            stopReason: "tool_use",
          };
        }
        return { message: { role: "assistant", text: "all done" }, stopReason: "end_turn" };
      },
      sendStream() { throw new Error("not used"); },
    };
  })();
  await runAgent({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [slowTool],
  });
  expect(maxInFlight).toBeGreaterThanOrEqual(2); // at least 2 ran in parallel
});

test("runAgent: tool handler that throws becomes ok=false ToolResult, loop continues", async () => {
  const throwingTool: Tool = {
    name: "broken",
    description: "always throws",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => { throw new Error("kaboom"); },
  };
  const provider: Provider = (() => {
    let i = 0;
    return {
      async send() {
        i++;
        if (i === 1) {
          return {
            message: {
              role: "assistant", text: "",
              toolCalls: [{ id: "c1", name: "broken", arguments: {} }],
            },
            stopReason: "tool_use",
          };
        }
        return { message: { role: "assistant", text: "I failed" }, stopReason: "end_turn" };
      },
      sendStream() { throw new Error("not used"); },
    };
  })();
  const result = await runAgent({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [throwingTool],
  });
  expect(result.reason).toBe("end_turn");
  const toolMsg = result.conversation.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  if (toolMsg && toolMsg.role === "tool") {
    expect(toolMsg.result.ok).toBe(false);
    if (!toolMsg.result.ok) expect(toolMsg.result.error).toContain("kaboom");
  }
});

test("runAgent: maxIterations boundary — N iterations are allowed, N+1 is the cap", async () => {
  // Provider that always returns a tool call → loop never exits naturally.
  const noopTool: Tool = {
    name: "noop",
    description: "noop",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ ok: true, content: "" }),
  };
  let sends = 0;
  const provider: Provider = {
    async send() {
      sends++;
      return {
        message: {
          role: "assistant", text: "",
          toolCalls: [{ id: `c${sends}`, name: "noop", arguments: {} }],
        },
        stopReason: "tool_use",
      };
    },
    sendStream() { throw new Error("not used"); },
  };
  const result = await runAgent({
    provider,
    model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [noopTool],
    maxIterations: 3,
  });
  expect(result.reason).toBe("max_iterations");
  // The loop sent send 3 times (iterations 1, 2, 3). Iteration 4 hits the cap.
  // result.iterations is the iteration counter when the cap was checked, which
  // is one past the last successful iteration (4 here).
  expect(result.iterations).toBe(4);
  expect(sends).toBe(3);
});

test("runAgent: parallel tool results appear in the order matching the call order", async () => {
  const recordTool = (name: string, delayMs: number): Tool => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, content: name };
    },
  });
  const provider: Provider = (() => {
    let i = 0;
    return {
      async send() {
        i++;
        if (i === 1) {
          return {
            message: {
              role: "assistant", text: "",
              toolCalls: [
                { id: "a", name: "fast", arguments: {} },
                { id: "b", name: "slow", arguments: {} },
                { id: "c", name: "fast", arguments: {} },
              ],
            },
            stopReason: "tool_use",
          };
        }
        return { message: { role: "assistant", text: "done" }, stopReason: "end_turn" };
      },
      sendStream() { throw new Error(""); },
    };
  })();
  const result = await runAgent({
    provider, model: "gpt-4o-mini",
    conversation: [{ role: "user", text: "x" }],
    tools: [recordTool("fast", 1), recordTool("slow", 30)],
  });
  // Find the tool messages in order; their callIds should match the call order
  // even though "slow" finished last in real time.
  const toolMsgs = result.conversation.filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBe(3);
  if (toolMsgs[0]?.role === "tool") expect(toolMsgs[0].callId).toBe("a");
  if (toolMsgs[1]?.role === "tool") expect(toolMsgs[1].callId).toBe("b");
  if (toolMsgs[2]?.role === "tool") expect(toolMsgs[2].callId).toBe("c");
});

test("runAgent: provider.send receives the cumulative conversation, not just the original", async () => {
  const seenLengths: number[] = [];
  const noopTool: Tool = {
    name: "noop",
    description: "noop",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => ({ ok: true, content: "" }),
  };
  let i = 0;
  const provider: Provider = {
    async send(opts) {
      seenLengths.push(opts.conversation.length);
      i++;
      if (i < 2) {
        return {
          message: {
            role: "assistant", text: "",
            toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
          },
          stopReason: "tool_use",
        };
      }
      return { message: { role: "assistant", text: "done" }, stopReason: "end_turn" };
    },
    sendStream() { throw new Error(""); },
  };
  await runAgent({
    provider, model: "x",
    conversation: [{ role: "user", text: "go" }],
    tools: [noopTool],
  });
  // 1st send: 1 message (user)
  // 2nd send: 3 messages (user + assistant + tool result)
  expect(seenLengths).toEqual([1, 3]);
});
