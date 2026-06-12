// End-to-end live API smoke test. Exercises both openaiClient and
// anthropicClient — send, stream, and a bad-api-key auth-error path.
// Skips a provider if its API key isn't set.
//
// Usage:
//   bun run scripts/smoke.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Conversation, Reply } from "../src/index.js";
import {
  openaiClient,
  anthropicClient,
  bedrockClient,
  LuvError,
  type OpenAIClient,
  type AnthropicClient,
  type BedrockClient,
} from "../src/index.js";

const ENV_PATH = join(import.meta.dir, "..", "..", "..", ".env");
const ENV = loadEnv();

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
    }
  }
  return env;
}

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

interface ProviderUnderTest {
  name: string;
  client: OpenAIClient | AnthropicClient | BedrockClient;
  badClient: OpenAIClient | AnthropicClient | BedrockClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendOpts: any;
}

async function smokeProvider(p: ProviderUnderTest) {
  console.log(`\n--- ${p.name} ---`);

  console.log(`${p.name}.send (non-streaming)`);
  const reply: Reply = await p.client.send(greeting, p.sendOpts);
  assert(reply.message.role === "assistant", "reply.message.role === assistant");
  assert(
    reply.message.content.length >= 1,
    `reply has ${reply.message.content.length} content block(s)`,
  );
  const first = reply.message.content[0];
  assert(first.kind === "text", `first block is text (got '${first.kind}')`);
  if (first.kind === "text") {
    assert(
      first.text.length > 0,
      `text non-empty (got ${first.text.length} chars)`,
    );
    console.log(`    text: ${JSON.stringify(first.text)}`);
  }
  assert(
    reply.finish_reason === "end_turn",
    `finish_reason === end_turn (got '${reply.finish_reason}')`,
  );

  console.log(`${p.name}.stream (streaming)`);
  let textPieces = 0;
  let messageStart = false;
  let messageEnd = false;
  let finishReason: string | null = null;
  let accumulated = "";

  for await (const event of p.client.stream(greeting, p.sendOpts)) {
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
  assert(
    accumulated.length > 0,
    `accumulated text non-empty (${accumulated.length} chars)`,
  );
  console.log(`    accumulated: ${JSON.stringify(accumulated)}`);
  assert(messageEnd, "stream emitted message_end");
  assert(
    finishReason === "end_turn",
    `finish_reason === end_turn (got '${finishReason}')`,
  );

  console.log(`${p.name} bad api_key should throw LuvError (auth)`);
  try {
    await p.badClient.send(greeting, p.sendOpts);
    fail++;
    console.log("  ✗ expected LuvError, got success");
  } catch (e) {
    if (e instanceof LuvError) {
      assert(
        e.data.category === "auth",
        `LuvError.data.category === auth (got '${e.data.category}')`,
      );
    } else {
      fail++;
      console.log(`  ✗ expected LuvError, got: ${e}`);
    }
  }
}

const providers: ProviderUnderTest[] = [];

if (ENV.OPENAI_API_KEY) {
  providers.push({
    name: "openai_chat",
    client: openaiClient({ api_key: ENV.OPENAI_API_KEY }),
    badClient: openaiClient({ api_key: "sk-deliberately-invalid-key-12345" }),
    sendOpts: { model: "gpt-4o-mini" },
  });
} else {
  console.log("(skipping openai_chat: OPENAI_API_KEY not set)");
}

if (ENV.ANTHROPIC_API_KEY) {
  providers.push({
    name: "anthropic_messages",
    client: anthropicClient({ api_key: ENV.ANTHROPIC_API_KEY }),
    badClient: anthropicClient({
      api_key: "sk-ant-deliberately-invalid-key-12345",
    }),
    sendOpts: { model: "claude-haiku-4-5", max_tokens: 1024 },
  });
} else {
  console.log("(skipping anthropic_messages: ANTHROPIC_API_KEY not set)");
}

if (ENV.AWS_ACCESS_KEY_ID && ENV.AWS_SECRET_ACCESS_KEY) {
  const region = ENV.AWS_REGION || "us-east-1";
  providers.push({
    name: "bedrock_converse",
    client: bedrockClient({
      region,
      access_key_id: ENV.AWS_ACCESS_KEY_ID,
      secret_access_key: ENV.AWS_SECRET_ACCESS_KEY,
      session_token: ENV.AWS_SESSION_TOKEN || undefined,
    }),
    badClient: bedrockClient({
      region,
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }),
    sendOpts: { model_id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  });
} else {
  console.log("(skipping bedrock_converse: AWS_ACCESS_KEY_ID not set)");
}

console.log("Live smoke test\n");
for (const p of providers) {
  await smokeProvider(p);
}
console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
