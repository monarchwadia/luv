// Phase I red tests: pure-TS morphism (port of core/src/morphisms/openai/openai.zig).
// These exercise the same shape contract the Zig morphism is held to,
// against the same fixture files in core/fixtures/openai/.

import { test, expect } from "bun:test";
import { fromOpenAI, toOpenAI } from "../src/morphism.ts";
import type { Conversation } from "../src/types.ts";

const FIXTURE_001_REQUEST = "/workspaces/luv/core/fixtures/openai/001_single_user/request.json";
const FIXTURE_001_RESPONSE = "/workspaces/luv/core/fixtures/openai/001_single_user/response.json";

test("toOpenAI: 001_single_user matches the fixture request shape", async () => {
  const conv: Conversation = [
    { role: "user", text: "Say hello in one short sentence." },
  ];
  const wire = toOpenAI({
    conversation: conv,
    model: "gpt-4o-mini",
    maxTokens: 32,
    temperature: 0,
  });

  const expected = JSON.parse(await Bun.file(FIXTURE_001_REQUEST).text());
  expect(wire).toEqual(expected);
});

test("toOpenAI: omits null optional fields (no max_tokens, no stream)", () => {
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
  });
  expect(wire).toEqual({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
  });
  // explicit checks the test cares about
  expect("max_tokens" in wire).toBe(false);
  expect("stream" in wire).toBe(false);
  expect("temperature" in wire).toBe(false);
});

test("toOpenAI: stream=true is emitted when set", () => {
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
    stream: true,
  });
  expect(wire.stream).toBe(true);
});

test("toOpenAI: emits each system message as its own array entry", () => {
  const wire = toOpenAI({
    conversation: [
      { role: "system", text: "be terse" },
      { role: "system", text: "answer in english" },
      { role: "user", text: "hi" },
    ],
    model: "gpt-4o-mini",
  });
  expect(wire.messages).toEqual([
    { role: "system", content: "be terse" },
    { role: "system", content: "answer in english" },
    { role: "user", content: "hi" },
  ]);
});

test("fromOpenAI: 001_single_user parses to assistant Reply with end_turn", async () => {
  const wire = JSON.parse(await Bun.file(FIXTURE_001_RESPONSE).text());
  const reply = fromOpenAI(wire);
  expect(reply.message.role).toBe("assistant");
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text.length).toBeGreaterThan(0);
  expect(reply.stopReason).toBe("end_turn");
});

test("fromOpenAI: maps finish_reason vocabulary", () => {
  const base = {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "length",
      },
    ],
  };
  expect(fromOpenAI(base).stopReason).toBe("max_tokens");
  expect(fromOpenAI({ ...base, choices: [{ ...base.choices[0]!, finish_reason: "content_filter" }] }).stopReason).toBe("content_filter");
  expect(fromOpenAI({ ...base, choices: [{ ...base.choices[0]!, finish_reason: "tool_calls" }] }).stopReason).toBe("tool_use");
  expect(fromOpenAI({ ...base, choices: [{ ...base.choices[0]!, finish_reason: "weird_unknown" }] }).stopReason).toBe("other");
});

test("fromOpenAI: ignores unknown response fields gracefully (annotations, service_tier, etc.)", () => {
  const wire = {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    service_tier: "default",
    system_fingerprint: "fp_abc",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hi",
          refusal: null,
          annotations: [],
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
  const reply = fromOpenAI(wire);
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text).toBe("Hi");
});

test("fromOpenAI: refusal coerced to text when content is null", () => {
  const wire = {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal: "I cannot help with that." },
        finish_reason: "stop",
      },
    ],
  };
  const reply = fromOpenAI(wire);
  if (reply.message.role !== "assistant") throw new Error("expected assistant");
  expect(reply.message.text).toBe("I cannot help with that.");
});

test("fromOpenAI: throws on empty choices array", () => {
  const wire = {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [],
  };
  expect(() => fromOpenAI(wire)).toThrow();
});

test("toOpenAI: temperature: 0 is emitted (not dropped as falsy)", () => {
  // Regression — undefined was correctly omitted, but 0 must still be sent.
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
    temperature: 0,
  });
  expect(wire.temperature).toBe(0);
  expect("temperature" in wire).toBe(true);
});

test("toOpenAI: maxTokens: 0 is emitted as max_tokens: 0", () => {
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
    maxTokens: 0,
  });
  expect(wire.max_tokens).toBe(0);
});

test("toOpenAI: response_format passes through to wire request when set", () => {
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "result",
        schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        strict: true,
      },
    },
  });
  expect(wire.response_format).toBeDefined();
  expect(wire.response_format?.json_schema.name).toBe("result");
});

test("toOpenAI: response_format omitted when not set", () => {
  const wire = toOpenAI({
    conversation: [{ role: "user", text: "hi" }],
    model: "gpt-4o-mini",
  });
  expect(wire.response_format).toBeUndefined();
});

test("toOpenAI: consecutive same-role messages preserved verbatim (OpenAI tolerates them)", () => {
  // Anthropic rejects this; OpenAI accepts. luv's contract: pass through.
  const wire = toOpenAI({
    conversation: [
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "user", text: "third" },
    ],
    model: "gpt-4o-mini",
  });
  expect(wire.messages.length).toBe(3);
  expect(wire.messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
});

test("toOpenAI: single empty conversation produces a request with empty messages array", () => {
  const wire = toOpenAI({
    conversation: [],
    model: "gpt-4o-mini",
  });
  expect(wire.messages).toEqual([]);
});

test("fromOpenAI: assistant content is empty string when both content and refusal are null", () => {
  const reply = fromOpenAI({
    id: "x", object: "chat.completion", created: 1, model: "x",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal: null },
        finish_reason: "stop",
      },
    ],
  });
  if (reply.message.role !== "assistant") throw new Error();
  expect(reply.message.text).toBe("");
});

test("fromOpenAI: usage with only some token fields populates the others as 0", () => {
  const reply = fromOpenAI({
    id: "x", object: "chat.completion", created: 1, model: "x",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5 },  // missing completion + total
  });
  expect(reply.usage?.promptTokens).toBe(5);
  expect(reply.usage?.completionTokens).toBe(0);
  expect(reply.usage?.totalTokens).toBe(0);
});
