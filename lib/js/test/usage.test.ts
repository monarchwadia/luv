// DX-4 (TS side): usage is surfaced from OpenAI responses.

import { test, expect } from "bun:test";
import { fromOpenAI } from "../src/morphism.ts";

test("fromOpenAI: carries usage when present", async () => {
  const wire = JSON.parse(
    await Bun.file("/workspaces/luv/core/fixtures/openai/001_single_user/response.json").text(),
  );
  const reply = fromOpenAI(wire);
  expect(reply.usage).toBeDefined();
  expect(reply.usage!.promptTokens).toBeGreaterThan(0);
  expect(reply.usage!.completionTokens).toBeGreaterThan(0);
  expect(reply.usage!.totalTokens).toBe(
    reply.usage!.promptTokens + reply.usage!.completionTokens,
  );
});

test("fromOpenAI: usage is undefined when wire response omits it", () => {
  const wire = {
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };
  const reply = fromOpenAI(wire);
  expect(reply.usage).toBeUndefined();
});
