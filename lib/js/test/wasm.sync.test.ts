// F2 gate — synchronous embedded-wasm bootstrap. Importing the module
// instantiates wasm synchronously (no await); calls are sync. Embedded bytes
// are committed, so this runs with no zig build needed (suite stays green).
import { test, expect } from "bun:test";
import { buildRequest, parseReply } from "../src/wasm/sync.ts";

test("sync.buildRequest: CodecSendRequest -> OpenAI wire JSON (synchronous)", () => {
  const json = buildRequest({
    model: "gpt-4o-mini",
    messages: [
      { role: 0, text: "be terse", toolCalls: [] },
      { role: 1, text: "hi", toolCalls: [] },
    ],
    maxTokens: 32,
    temperature: null,
    stream: false,
    tools: [
      { name: "calc", description: "adds", inputSchema: '{"type":"object"}' },
    ],
  });
  const wire = JSON.parse(json);
  expect(wire.model).toBe("gpt-4o-mini");
  expect(wire.messages[0]).toEqual({ role: "system", content: "be terse" });
  expect(wire.messages[1]).toEqual({ role: "user", content: "hi" });
  expect(wire.max_tokens).toBe(32);
  expect(wire.tools[0].function.name).toBe("calc");
});

test("sync.parseReply: OpenAI response JSON -> CodecReply (synchronous)", () => {
  const reply = parseReply(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  expect(reply.role).toBe(2);
  expect(reply.stopReason).toBe(0);
  expect(reply.text).toBe("hello");
});
