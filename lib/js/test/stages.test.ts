// Stage tests: pre-handler decisions short-circuit / mutate calls; the
// agent loop runs stages in order before invoking the handler. Mirrors
// core/src/agent/agent.zig stage tests.

import { test, expect } from "bun:test";
import { runAgent, describeWithStages } from "../src/agent.ts";
import { tool } from "../src/tool.ts";
import type {
  Decision,
  Provider,
  ProviderSendOptions,
  Reply,
  Stage,
  Tool,
} from "../src/types.ts";

function makeMockProvider(replies: Reply[]): Provider {
  let i = 0;
  return {
    send: async (_: ProviderSendOptions): Promise<Reply> => {
      if (i >= replies.length) throw new Error("mock out of replies");
      return replies[i++]!;
    },
    sendStream: () => { throw new Error("not used"); },
  };
}

// ---------------- describeWithStages (pure) ----------------

test("describeWithStages: empty stages returns the description unchanged", () => {
  expect(describeWithStages("writes files", undefined)).toBe("writes files");
  expect(describeWithStages("writes files", [])).toBe("writes files");
});

test("describeWithStages: stages with no description are skipped", () => {
  const stages: Stage[] = [{ kind: "noisy", fn: async () => ({ kind: "run" }) }];
  expect(describeWithStages("writes files", stages)).toBe("writes files");
});

test("describeWithStages: weaves stage descriptions into the output", () => {
  const stages: Stage[] = [
    { kind: "jail", description: "paths restricted to project root", fn: async () => ({ kind: "run" }) },
    { kind: "approval", description: "requires user approval", fn: async () => ({ kind: "run" }) },
  ];
  const got = describeWithStages("writes files", stages);
  expect(got.startsWith("writes files\n\nThis tool runs through")).toBe(true);
  expect(got).toContain("- jail: paths restricted to project root");
  expect(got).toContain("- approval: requires user approval");
});

// ---------------- Stage execution in runAgent ----------------

const empty = { type: "object", properties: {}, required: [] } as const;

function makeTrackingTool(): { tool: Tool; calls: { count: number; lastArgs: unknown } } {
  const state = { count: 0, lastArgs: undefined as unknown };
  const t = tool({
    name: "writes",
    description: "writes files",
    inputSchema: empty,
    handler: async (args) => {
      state.count += 1;
      state.lastArgs = args;
      return { ok: true, content: "ran" };
    },
  });
  return { tool: t, calls: state };
}

test("runAgent: stage with deny decision short-circuits the handler", async () => {
  const { tool: writes, calls } = makeTrackingTool();
  const denyStage: Stage = {
    kind: "test-deny",
    description: "denies every call",
    fn: (): Decision => ({ kind: "deny", error: "always denied for test" }),
  };
  const tracked: Tool = { ...writes, stages: [denyStage] };

  const provider = makeMockProvider([
    {
      message: { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "writes", arguments: {} }] },
      stopReason: "tool_use",
    },
    { message: { role: "assistant", text: "ok" }, stopReason: "end_turn" },
  ]);

  const result = await runAgent({
    provider,
    model: "x",
    conversation: [{ role: "user", text: "go" }],
    tools: [tracked],
  });

  expect(result.reason).toBe("end_turn");
  expect(calls.count).toBe(0);

  const errMsg = result.conversation
    .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
    .find((c) => c.result && !c.result.ok)?.result;
  expect(errMsg).toBeDefined();
  if (errMsg && !errMsg.ok) expect(errMsg.error).toContain("always denied for test");
});

test("runAgent: stage with synthesize decision skips handler and returns the synthetic result", async () => {
  const { tool: writes, calls } = makeTrackingTool();
  const synthStage: Stage = {
    kind: "test-synth",
    description: "synthesizes",
    fn: (): Decision => ({ kind: "synthesize", result: { ok: true, content: "from cache" } }),
  };
  const tracked: Tool = { ...writes, stages: [synthStage] };

  const provider = makeMockProvider([
    {
      message: { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "writes", arguments: {} }] },
      stopReason: "tool_use",
    },
    { message: { role: "assistant", text: "done" }, stopReason: "end_turn" },
  ]);

  const result = await runAgent({
    provider,
    model: "x",
    conversation: [{ role: "user", text: "go" }],
    tools: [tracked],
  });

  expect(calls.count).toBe(0);
  const okResult = result.conversation
    .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
    .find((c) => c.result?.ok)?.result;
  expect(okResult).toBeDefined();
  if (okResult?.ok) expect(okResult.content).toBe("from cache");
});

test("runAgent: stage with edit decision rewrites args before the handler runs", async () => {
  const { tool: writes, calls } = makeTrackingTool();
  const editStage: Stage = {
    kind: "test-edit",
    description: "rewrites args",
    fn: (): Decision => ({ kind: "edit", args: { x: 99 } }),
  };
  const tracked: Tool = { ...writes, stages: [editStage] };

  const provider = makeMockProvider([
    {
      message: { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "writes", arguments: { x: 1 } }] },
      stopReason: "tool_use",
    },
    { message: { role: "assistant", text: "ok" }, stopReason: "end_turn" },
  ]);

  await runAgent({
    provider,
    model: "x",
    conversation: [{ role: "user", text: "go" }],
    tools: [tracked],
  });

  expect(calls.count).toBe(1);
  expect(calls.lastArgs).toEqual({ x: 99 });
});

test("runAgent: stages run in order; first short-circuit wins", async () => {
  const { tool: writes, calls } = makeTrackingTool();
  const order: string[] = [];
  const stages: Stage[] = [
    {
      kind: "first",
      fn: (): Decision => { order.push("first"); return { kind: "run" }; },
    },
    {
      kind: "deny",
      fn: (): Decision => { order.push("deny"); return { kind: "deny", error: "blocked" }; },
    },
    {
      kind: "third",
      fn: (): Decision => { order.push("third"); return { kind: "run" }; },
    },
  ];
  const tracked: Tool = { ...writes, stages };

  const provider = makeMockProvider([
    {
      message: { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "writes", arguments: {} }] },
      stopReason: "tool_use",
    },
    { message: { role: "assistant", text: "ok" }, stopReason: "end_turn" },
  ]);

  await runAgent({
    provider,
    model: "x",
    conversation: [{ role: "user", text: "go" }],
    tools: [tracked],
  });

  expect(order).toEqual(["first", "deny"]); // third never ran
  expect(calls.count).toBe(0);
});

test("runAgent: send() sees tool description enriched with stage info", async () => {
  let seenDescription = "";
  const captureProvider: Provider = {
    send: async (opts: ProviderSendOptions): Promise<Reply> => {
      if (opts.tools?.[0]) seenDescription = opts.tools[0].description;
      return { message: { role: "assistant", text: "ok" }, stopReason: "end_turn" };
    },
    sendStream: () => { throw new Error("not used"); },
  };

  const { tool: writes } = makeTrackingTool();
  const tracked: Tool = {
    ...writes,
    stages: [{ kind: "jail", description: "paths must be inside /workspaces/luv", fn: async () => ({ kind: "run" }) }],
  };

  await runAgent({
    provider: captureProvider,
    model: "x",
    conversation: [{ role: "user", text: "x" }],
    tools: [tracked],
  });

  expect(seenDescription).toContain("writes files");
  expect(seenDescription).toContain("- jail: paths must be inside /workspaces/luv");
});
