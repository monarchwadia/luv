// pendingToolCalls + respondToToolCall — pure functional utilities over the
// canonical luv Conversation. Mirrors core/src/morphisms/luv/tool_calls.zig.

import { test, expect } from "bun:test";
import {
  pendingToolCalls,
  respondToToolCall,
} from "../src/tool_calls.ts";
import type { Conversation, ToolCall, ToolResult } from "../src/types.ts";

// ---------- pendingToolCalls ----------

test("pendingToolCalls: empty conversation → empty", () => {
  expect(pendingToolCalls([])).toEqual([]);
});

test("pendingToolCalls: no assistant messages → empty", () => {
  const conv: Conversation = [
    { role: "system", text: "hi" },
    { role: "user", text: "yo" },
  ];
  expect(pendingToolCalls(conv)).toEqual([]);
});

test("pendingToolCalls: assistant message with no toolCalls → empty", () => {
  const conv: Conversation = [
    { role: "assistant", text: "ok" },
  ];
  expect(pendingToolCalls(conv)).toEqual([]);
});

test("pendingToolCalls: returns calls with result=undefined", () => {
  const c1: ToolCall = { id: "a", name: "f", arguments: { x: 1 } };
  const c2: ToolCall = { id: "b", name: "g", arguments: { y: 2 } };
  const conv: Conversation = [
    { role: "assistant", text: "", toolCalls: [c1, c2] },
  ];
  expect(pendingToolCalls(conv)).toEqual([c1, c2]);
});

test("pendingToolCalls: skips calls that already have a result", () => {
  const resolved: ToolCall = {
    id: "a",
    name: "f",
    arguments: {},
    result: { ok: true, content: "done" },
  };
  const pending: ToolCall = { id: "b", name: "g", arguments: {} };
  const conv: Conversation = [
    { role: "assistant", text: "", toolCalls: [resolved, pending] },
  ];
  expect(pendingToolCalls(conv)).toEqual([pending]);
});

test("pendingToolCalls: respects optional filter predicate", () => {
  const c1: ToolCall = { id: "a", name: "read", arguments: {} };
  const c2: ToolCall = { id: "b", name: "write", arguments: {} };
  const conv: Conversation = [
    { role: "assistant", text: "", toolCalls: [c1, c2] },
  ];
  expect(pendingToolCalls(conv, (c) => c.name === "write")).toEqual([c2]);
});

test("pendingToolCalls: aggregates across multiple assistant turns", () => {
  const c1: ToolCall = { id: "a", name: "f", arguments: {} };
  const c2: ToolCall = {
    id: "b",
    name: "g",
    arguments: {},
    result: { ok: true, content: "x" },
  };
  const c3: ToolCall = { id: "c", name: "h", arguments: {} };
  const conv: Conversation = [
    { role: "user", text: "go" },
    { role: "assistant", text: "", toolCalls: [c1, c2] },
    { role: "user", text: "more" },
    { role: "assistant", text: "", toolCalls: [c3] },
  ];
  expect(pendingToolCalls(conv)).toEqual([c1, c3]);
});

// ---------- respondToToolCall ----------

test("respondToToolCall: sets result on the matching tool call", () => {
  const conv: Conversation = [
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "f", arguments: {} }],
    },
  ];
  const result: ToolResult = { ok: true, content: "42" };
  const next = respondToToolCall(conv, "a", result);

  expect(next).toEqual([
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "f", arguments: {}, result }],
    },
  ]);
});

test("respondToToolCall: does not mutate the input conversation", () => {
  const original: Conversation = [
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "f", arguments: {} }],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  respondToToolCall(original, "a", { ok: true, content: "ok" });
  expect(original).toEqual(snapshot);
});

test("respondToToolCall: preserves siblings on the same assistant message", () => {
  const c1: ToolCall = { id: "a", name: "f", arguments: {} };
  const c2: ToolCall = { id: "b", name: "g", arguments: {} };
  const conv: Conversation = [
    { role: "assistant", text: "", toolCalls: [c1, c2] },
  ];
  const next = respondToToolCall(conv, "b", { ok: true, content: "B" });

  expect(next[0]).toEqual({
    role: "assistant",
    text: "",
    toolCalls: [c1, { ...c2, result: { ok: true, content: "B" } }],
  });
});

test("respondToToolCall: only touches the assistant message that owns the call", () => {
  const conv: Conversation = [
    { role: "user", text: "first" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "f", arguments: {} }],
    },
    { role: "user", text: "second" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "b", name: "g", arguments: {} }],
    },
  ];
  const next = respondToToolCall(conv, "b", { ok: false, error: "nope" });

  expect(next[0]).toEqual(conv[0]!);
  expect(next[1]).toEqual(conv[1]!);
  expect(next[2]).toEqual(conv[2]!);
  expect(next[3]).toEqual({
    role: "assistant",
    text: "",
    toolCalls: [
      { id: "b", name: "g", arguments: {}, result: { ok: false, error: "nope" } },
    ],
  });
});

test("respondToToolCall: unknown callId returns conversation unchanged (by value)", () => {
  const conv: Conversation = [
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "f", arguments: {} }],
    },
  ];
  const next = respondToToolCall(conv, "nope", { ok: true, content: "x" });
  expect(next).toEqual(conv);
});

test("respondToToolCall: overwriting an existing result is allowed", () => {
  const conv: Conversation = [
    {
      role: "assistant",
      text: "",
      toolCalls: [
        {
          id: "a",
          name: "f",
          arguments: {},
          result: { ok: true, content: "first" },
        },
      ],
    },
  ];
  const next = respondToToolCall(conv, "a", { ok: false, error: "second" });
  const m = next[0]!;
  if (m.role !== "assistant") throw new Error("expected assistant");
  expect(m.toolCalls?.[0]?.result).toEqual({ ok: false, error: "second" });
});
