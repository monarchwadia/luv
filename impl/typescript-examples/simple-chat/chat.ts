// simple-chat — a minimal terminal chatbot built on luv.
//
// The whole demo is: build a canonical luv Conversation in memory, append
// a node for each turn, stream the assistant reply back via the OpenAI
// transport. Everything provider-specific is contained in `openaiClient`;
// the conversation itself is the same canonical shape any other luv
// transport (Anthropic, etc.) would consume unchanged.
//
//   bun chat.ts        (set OPENAI_API_KEY first — see README)

import { createInterface } from "node:readline/promises";
import { LUV_SPEC_VERSION, LuvError, openaiClient } from "luv";
import type { Conversation } from "luv";

// ---------- env ----------

// Load the repo-root .env regardless of cwd. Existing process env wins.
const rootEnv = Bun.file(new URL("../../../.env", import.meta.url));
for (const line of (await rootEnv.text()).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  const [, key, rawVal] = m;
  if (!key || process.env[key]) continue;
  process.env[key] = (rawVal ?? "").replace(/^["']|["']$/g, "");
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in the repo-root .env or your environment");
  process.exit(1);
}

const MODEL = process.env.LUV_CHAT_MODEL ?? "gpt-4o-mini";
const client = openaiClient({ api_key: apiKey });

// ---------- conversation ----------

const conv: Conversation = {
  spec_version: LUV_SPEC_VERSION,
  nodes: [
    {
      id: "n0",
      parent_id: null,
      message: {
        role: "system",
        content: [
          { kind: "text", text: "You are a helpful assistant. Keep answers concise." },
        ],
      },
    },
  ],
};

function append(role: "user" | "assistant", text: string) {
  const last = conv.nodes[conv.nodes.length - 1]!;
  conv.nodes.push({
    id: `n${conv.nodes.length}`,
    parent_id: last.id,
    message: { role, content: [{ kind: "text", text }] },
  });
}

// ---------- repl ----------

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.once("close", () => {
  closed = true;
});

console.log(`simple-chat — model ${MODEL}.  type "exit" to quit.\n`);

while (!closed) {
  let line: string;
  try {
    line = (await rl.question("you> ")).trim();
  } catch (err) {
    if ((err as { code?: string })?.code === "ERR_USE_AFTER_CLOSE") break;
    throw err;
  }
  if (closed) break;
  if (!line) continue;
  if (line === "exit" || line === "quit") break;

  append("user", line);

  process.stdout.write("bot> ");
  let reply = "";
  try {
    for await (const ev of client.stream(conv, { model: MODEL })) {
      if (ev.kind === "text_delta") {
        process.stdout.write(ev.text);
        reply += ev.text;
      }
    }
    process.stdout.write("\n");
    append("assistant", reply);
  } catch (err) {
    process.stdout.write("\n");
    if (err instanceof LuvError) {
      console.error(`[luv:${err.data.category}] ${err.data.message}`);
    } else {
      console.error(err);
    }
    // Drop the failed user turn so the next prompt isn't poisoned.
    conv.nodes.pop();
  }
}

rl.close();
