// Minimal tool-using agent loop on luv — a reference example, NOT a framework.
//
// It shows three things working together:
//   1. the conversation as a tree (each turn appended as a child node),
//   2. tool-call handling (run the tool, feed the result back, repeat),
//   3. per-turn token usage read straight off Reply.usage.
//
// Run:  bun run examples/agent.ts
// Needs OPENAI_API_KEY (in the repo-root .env or the environment).
//
// Swapping providers is a one-liner: import { anthropicClient } and build it
// with an Anthropic model + max_tokens — the loop below is unchanged, because
// it only ever touches canonical luv types.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Block, Conversation, Message, Reply } from "../src/index.js";
import { openaiClient } from "../src/index.js";

// ---- API key: repo-root .env or process.env ----
function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const env = readFileSync(join(import.meta.dir, "..", "..", "..", ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall through */
  }
  console.error("Set OPENAI_API_KEY (in the repo-root .env or the environment).");
  process.exit(1);
}

// ---- one tiny local tool the model may call ----
const TOOLS = [
  {
    type: "function",
    function: {
      name: "multiply",
      description: "Multiply two numbers and return the product.",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  },
];

function runTool(name: string, args: string): string {
  if (name === "multiply") {
    const { a, b } = JSON.parse(args);
    return String(a * b);
  }
  return `unknown tool: ${name}`;
}

// ---- growing the conversation tree ----
let counter = 0;
function append(conv: Conversation, message: Message): Conversation {
  const parent = conv.nodes.length > 0 ? conv.nodes[conv.nodes.length - 1].id : null;
  counter += 1;
  return {
    ...conv,
    nodes: [...conv.nodes, { id: `n${counter}`, parent_id: parent, message }],
  };
}

const isToolCall = (b: Block): b is Extract<Block, { kind: "tool_call" }> =>
  b.kind === "tool_call";
const isText = (b: Block): b is Extract<Block, { kind: "text" }> => b.kind === "text";

function printUsage(label: string, reply: Reply): void {
  if (reply.usage === null) {
    console.log(`  [${label}] usage: none reported`);
    return;
  }
  // usage is provider-tagged and lossless: print provenance + the raw object.
  console.log(`  [${label}] ${reply.usage.provider} / ${reply.usage.model}`);
  console.log(`           ${JSON.stringify(reply.usage.raw)}`);
}

async function main(): Promise<void> {
  const client = openaiClient({ api_key: loadApiKey() });
  const opts = { model: "gpt-4o-mini", tools: TOOLS };

  let conv: Conversation = { spec_version: "1.0", nodes: [] };
  conv = append(conv, {
    role: "system",
    content: [{ kind: "text", text: "You are concise. Use tools when they help." }],
  });
  conv = append(conv, {
    role: "user",
    content: [{ kind: "text", text: "What is 23 times 19? Use the multiply tool." }],
  });

  for (let turn = 1; turn <= 6; turn++) {
    const reply = await client.send(conv, opts);
    printUsage(`turn ${turn}`, reply);
    conv = append(conv, reply.message);

    const calls = reply.message.content.filter(isToolCall);
    if (calls.length === 0) {
      const text = reply.message.content.filter(isText).map((b) => b.text).join("");
      console.log(`\nassistant: ${text}`);
      return;
    }

    // Run each tool and feed the results back as a user turn (a child node).
    const results: Block[] = calls.map((c) => ({
      kind: "tool_result",
      call_id: c.id,
      text: runTool(c.name, c.args),
    }));
    for (const c of calls) console.log(`  -> ${c.name}(${c.args})`);
    conv = append(conv, { role: "user", content: results });
  }
  console.log("(stopped after max turns)");
}

main();
