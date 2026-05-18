// Production loader functional gate — real wasm, codec bridge both ways.
// Skips if wasm unbuilt (suite stays green). Build: cd core && zig build wasm.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { loadLuv } from "../src/wasm/loader.ts";

const WASM = new URL(
  "../../../core/zig-out/wasm/luv_core.wasm",
  import.meta.url,
);
const have = existsSync(WASM);

test.skipIf(!have)(
  "loader.buildRequest: CodecSendRequest -> OpenAI wire JSON (text + tool call)",
  async () => {
    const luv = await loadLuv(await Bun.file(WASM).arrayBuffer());
    const json = luv.buildRequest({
      model: "gpt-4o-mini",
      messages: [
        { role: 0, text: "be terse", toolCalls: [] },
        { role: 1, text: "weather?", toolCalls: [] },
        {
          role: 2,
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "lookup",
              args: '{"city":"Tokyo"}',
              result: { ok: true, content: '{"t":18}' },
            },
          ],
        },
      ],
      maxTokens: 64,
      temperature: null,
      stream: false,
    });
    const wire = JSON.parse(json);
    expect(wire.model).toBe("gpt-4o-mini");
    expect(wire.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(wire.messages[1]).toEqual({ role: "user", content: "weather?" });
    expect(wire.max_tokens).toBe(64);
    // assistant tool call expands to an assistant message + a tool result message
    const asst = wire.messages.find(
      (m: { role: string; tool_calls?: unknown[] }) =>
        m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(asst.tool_calls[0].function.name).toBe("lookup");
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({
      city: "Tokyo",
    });
    const toolMsg = wire.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMsg.content).toBe('{"t":18}');
  },
);

test.skipIf(!have)(
  "loader.parseReply: OpenAI response JSON -> CodecReply",
  async () => {
    const luv = await loadLuv(await Bun.file(WASM).arrayBuffer());
    const resp = JSON.stringify({
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
    });
    const reply = luv.parseReply(resp);
    expect(reply.role).toBe(2); // assistant
    expect(reply.stopReason).toBe(0); // "stop" -> end_turn
    expect(reply.text).toBe("hello");
  },
);
