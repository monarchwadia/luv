// Example: minimal runAgent loop with one tool, against the live OpenAI API.
//
// Run with:
//   bun run example:agent     (from lib/js/)

import { createClient, tool } from "../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in environment");
  process.exit(1);
}

const luv = createClient({ apiKey });

const calc = tool({
  name: "calc",
  description: "Evaluates a basic arithmetic expression and returns the result as a string.",
  inputSchema: {
    type: "object",
    properties: { expr: { type: "string" } },
    required: ["expr"],
  },
  handler: async ({ expr }) => {
    try {
      // demo only — Function() with model-supplied input is unsafe in production
      const value = Function(`"use strict"; return (${expr})`)();
      return { ok: true, content: String(value) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const result = await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [
    { role: "user", text: "Use calc to compute 17 * 23, then explain in one sentence." },
  ],
  tools: [calc],
  maxIterations: 5,
  onTurnStart:  (i) => console.log(`--- turn ${i} ---`),
  onToolCall:   (c) => console.log(`call:  ${c.name}(${JSON.stringify(c.arguments)})`),
  onToolResult: (_c, r) => console.log(`reply: ${r.ok ? r.content : "ERR " + r.error}`),
});

const last = result.conversation[result.conversation.length - 1];
console.log();
console.log("FINAL:", last && last.role === "assistant" ? last.text : "(non-assistant)");
console.log(`reason=${result.reason} iterations=${result.iterations}`);
