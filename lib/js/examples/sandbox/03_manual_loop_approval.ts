// Manual agent loop: drive turns yourself, intercept pending tool calls
// before they run. This is the "approval gate" pattern — pure data
// flowing through pendingToolCalls + respondToToolCall.
//
//   bun 03_manual_loop_approval.ts                                  (from this directory)
//   cd lib/js && bun run sandbox examples/sandbox/03_manual_loop_approval.ts   (from lib/js)

import "./_env.ts";
import {
  anthropicProvider,
  pendingToolCalls,
  respondToToolCall,
  tool,
  type Conversation,
  type ToolResult,
} from "../../src/index.ts";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not in .env");

const writeFile = tool({
  name: "write_file",
  description: "Writes content to a file at the given path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  } as const,
  handler: async ({ path, content }) => {
    // Pretend we wrote it.
    return { ok: true, content: `wrote ${content.length} bytes to ${path}` };
  },
});

const provider = anthropicProvider({ apiKey });
const tools = [writeFile];

let conv: Conversation = [
  { role: "user", text: "Create a file hello.txt that contains 'hello world'." },
];

for (let i = 0; i < 5; i++) {
  console.log(`--- turn ${i + 1} ---`);

  const reply = await provider.send({ model: "claude-sonnet-4-6", conversation: conv, tools });
  conv = [...conv, reply.message];

  const pending = pendingToolCalls(conv);
  if (pending.length === 0) {
    if (reply.message.role === "assistant") console.log(`assistant: ${reply.message.text}`);
    break;
  }

  // Approval gate — auto-approve in this script. Set DENY=1 to deny instead.
  for (const call of pending) {
    console.log(`  pending: ${call.name}(${JSON.stringify(call.arguments)})`);
    let result: ToolResult;
    if (process.env["DENY"]) {
      result = { ok: false, error: "user denied" };
    } else {
      const t = tools.find((x) => x.name === call.name)!;
      result = await t.handler(call.arguments as never, {});
    }
    console.log(`  → ${result.ok ? result.content : `ERR: ${result.error}`}`);
    conv = respondToToolCall(conv, call.id, result);
  }
}
