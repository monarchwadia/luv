// End-to-end live API smoke test for the OpenAI transport.
// Exercises openaiClient().send() and openaiClient().stream() against
// the real OpenAI Chat Completions endpoint. Requires OPENAI_API_KEY.
//
// Usage:
//   bun run scripts/smoke.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Conversation, Reply } from "../src/index.ts";
import { openaiClient, LuvError } from "../src/index.ts";

const ENV_PATH = join(import.meta.dir, "..", "..", "..", ".env");

function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^OPENAI_API_KEY=(.*)$/);
      if (m) return m[1].trim().replace(/^"|"$/g, "");
    }
  }
  console.error("OPENAI_API_KEY not found");
  process.exit(1);
}

const api_key = loadApiKey();
const client = openaiClient({ api_key });

const greeting: Conversation = {
  spec_version: "1.0",
  nodes: [
    {
      id: "n1",
      parent_id: null,
      message: {
        role: "user",
        content: [
          { kind: "text", text: "Reply with exactly: The answer is 4." },
        ],
      },
    },
  ],
};

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

async function testSend() {
  console.log("client.send (non-streaming)");
  const reply: Reply = await client.send(greeting, { model: "gpt-4o-mini" });
  assert(reply.message.role === "assistant", "reply.message.role === assistant");
  assert(
    reply.message.content.length >= 1,
    `reply has ${reply.message.content.length} content block(s)`,
  );
  const first = reply.message.content[0];
  assert(first.kind === "text", `first block is text (got '${first.kind}')`);
  if (first.kind === "text") {
    assert(first.text.length > 0, `text non-empty (got ${first.text.length} chars)`);
    console.log(`    text: ${JSON.stringify(first.text)}`);
  }
  assert(
    reply.finish_reason === "end_turn",
    `finish_reason === end_turn (got '${reply.finish_reason}')`,
  );
}

async function testStream() {
  console.log("client.stream (streaming)");
  let textPieces = 0;
  let messageStart = false;
  let messageEnd = false;
  let finishReason: string | null = null;
  let accumulated = "";

  for await (const event of client.stream(greeting, { model: "gpt-4o-mini" })) {
    if (event.kind === "message_start") messageStart = true;
    if (event.kind === "text_delta") {
      textPieces++;
      accumulated += event.text;
    }
    if (event.kind === "message_end") {
      messageEnd = true;
      finishReason = event.finish_reason;
    }
  }

  assert(messageStart, "stream emitted message_start");
  assert(textPieces > 0, `stream emitted ${textPieces} text_delta(s)`);
  assert(accumulated.length > 0, `accumulated text non-empty (${accumulated.length} chars)`);
  console.log(`    accumulated: ${JSON.stringify(accumulated)}`);
  assert(messageEnd, "stream emitted message_end");
  assert(finishReason === "end_turn", `finish_reason === end_turn (got '${finishReason}')`);
}

async function testAuthError() {
  console.log("openaiClient with bad api_key should throw LuvError (auth)");
  const badClient = openaiClient({ api_key: "sk-deliberately-invalid-key-12345" });
  try {
    await badClient.send(greeting, { model: "gpt-4o-mini" });
    fail++;
    console.log("  ✗ expected LuvError, got success");
  } catch (e) {
    if (e instanceof LuvError) {
      assert(e.data.category === "auth", `LuvError.data.category === auth (got '${e.data.category}')`);
    } else {
      fail++;
      console.log(`  ✗ expected LuvError, got: ${e}`);
    }
  }
}

async function main() {
  console.log("Live OpenAI smoke test\n");
  await testSend();
  console.log();
  await testStream();
  console.log();
  await testAuthError();
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

await main();
