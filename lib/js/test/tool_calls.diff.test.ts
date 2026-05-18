// Differential gate for the tool_calls brick swap: TS port vs wasm bridge.
import { test, expect } from "bun:test";
import {
  pendingToolCalls as portPending,
  respondToToolCall as portRespond,
} from "../src/tool_calls.ts";
import {
  pendingToolCalls as wasmPending,
  respondToToolCall as wasmRespond,
} from "../src/wasm/tool_calls_bridge.ts";
import type { Conversation } from "../src/types.ts";

const conv = (): Conversation => [
  { role: "system", text: "be terse" },
  { role: "user", text: "weather + write a file" },
  {
    role: "assistant",
    text: "on it",
    toolCalls: [
      { id: "c1", name: "weather", arguments: { city: "Tokyo" } },
      {
        id: "c2",
        name: "write",
        arguments: { path: "/x" },
        result: { ok: true, content: "done" },
      },
    ],
  },
  { role: "user", text: "more" },
  {
    role: "assistant",
    text: "",
    toolCalls: [{ id: "c3", name: "weather", arguments: { city: "Osaka" } }],
  },
];

test("pendingToolCalls parity: all pending across messages", () => {
  expect(wasmPending(conv())).toEqual(portPending(conv()));
});

test("pendingToolCalls parity: predicate filter (host closure stays TS)", () => {
  const f = (c: { name: string }) => c.name === "weather";
  expect(wasmPending(conv(), f)).toEqual(portPending(conv(), f));
});

test("pendingToolCalls parity: empty + none-pending", () => {
  expect(wasmPending([])).toEqual(portPending([]));
  const resolved: Conversation = [
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "a", name: "n", arguments: {}, result: { ok: true, content: "x" } },
      ],
    },
  ];
  expect(wasmPending(resolved)).toEqual(portPending(resolved));
});

test("respondToToolCall parity: hit sets result", () => {
  expect(wasmRespond(conv(), "c1", { ok: true, content: "18C" })).toEqual(
    portRespond(conv(), "c1", { ok: true, content: "18C" }),
  );
});

test("respondToToolCall parity: err result", () => {
  expect(wasmRespond(conv(), "c3", { ok: false, error: "boom" })).toEqual(
    portRespond(conv(), "c3", { ok: false, error: "boom" }),
  );
});

test("respondToToolCall parity: miss returns structurally-equal conversation", () => {
  expect(wasmRespond(conv(), "nope", { ok: true, content: "x" })).toEqual(
    portRespond(conv(), "nope", { ok: true, content: "x" }),
  );
});

test("respondToToolCall parity: overwrites an existing result", () => {
  expect(wasmRespond(conv(), "c2", { ok: false, error: "second" })).toEqual(
    portRespond(conv(), "c2", { ok: false, error: "second" }),
  );
});

test("respondToToolCall parity: input conversation not mutated", () => {
  const original = conv();
  const snapshot = JSON.parse(JSON.stringify(original));
  wasmRespond(original, "c1", { ok: true, content: "x" });
  expect(original).toEqual(snapshot);
});
