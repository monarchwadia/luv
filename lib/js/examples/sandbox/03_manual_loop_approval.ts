// Manual agent loop: drive turns yourself, intercept pending tool calls
// before they run. This is the "approval gate" pattern — pure data
// flowing through pendingToolCalls + respondToToolCall.
//
//   bun 03_manual_loop_approval.ts                                  (from this directory)
//   cd lib/js && bun run sandbox examples/sandbox/03_manual_loop_approval.ts   (from lib/js)

import "./_env.ts";
import * as readline from "node:readline/promises";
import {
  openaiProvider,
  pendingToolCalls,
  respondToToolCall,
  tool,
  type Conversation,
  type ToolResult,
} from "../../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) throw new Error("OPENAI_API_KEY not in .env");

const writeFile = tool({
  name: "write_file",
  description: "Writes content to a file at the given path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  } as const,
  handler: async ({ path, content }) => {
    return { ok: true, content: `wrote ${content.length} bytes to ${path}` };
  },
});

const provider = openaiProvider({ apiKey });
const tools = [writeFile];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt: string, fallback = ""): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer === "" ? fallback : answer;
}

let conv: Conversation = [
  { role: "user", text: "Create a file foo.txt that contains 'hahaha'. but in pirate speak" },
];

try {
  for (let i = 0; i < 5; i++) {
    console.log(`\n--- turn ${i + 1} ---`);

    const reply = await provider.send({ model: "gpt-5.4", conversation: conv, tools });
    conv = [...conv, reply.message];

    const pending = pendingToolCalls(conv);
    if (pending.length === 0) {
      if (reply.message.role === "assistant") console.log(`assistant: ${reply.message.text}`);
      break;
    }

    for (const call of pending) {
      console.log(`\n  pending: ${call.name}(${JSON.stringify(call.arguments)})`);
      const choice = (await ask("  [A]pprove / [d]eny / [e]dit args? ", "a")).toLowerCase();

      let result: ToolResult;
      let args = call.arguments;

      if (choice === "d") {
        const reason = await ask("  reason: ", "user denied");
        result = { ok: false, error: reason };
      } else {
        if (choice === "e") {
          const edited = await ask(`  new args (JSON) [${JSON.stringify(call.arguments)}]: `, "");
          if (edited !== "") {
            try { args = JSON.parse(edited); }
            catch (e) { console.log(`  invalid JSON, keeping original args (${(e as Error).message})`); }
          }
        }
        const t = tools.find((x) => x.name === call.name)!;
        try {
          result = await t.handler(args as never, {});
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      console.log(`  → ${result.ok ? result.content : `ERR: ${result.error}`}`);
      conv = respondToToolCall(conv, call.id, result);
    }
  }
} finally {
  rl.close();
}
