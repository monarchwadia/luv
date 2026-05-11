// runAgent loop with one tool, showing the colocated tool-result shape.
//
//   bun 02_agent_with_tool.ts                                  (from this directory)
//   cd lib/js && bun run sandbox examples/sandbox/02_agent_with_tool.ts   (from lib/js)

import "./_env.ts";
import { runAgent, anthropicProvider, tool, pendingToolCalls } from "../../src/index.ts";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not in .env");

const lookupWeather = tool({
  name: "lookup_weather",
  description: "Returns current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  } as const,
  handler: async ({ city }) => {
    // Fake weather API.
    return { ok: true, content: JSON.stringify({ city, temp_c: 18, condition: "sunny" }) };
  },
});

const result = await runAgent({
  provider: anthropicProvider({ apiKey }),
  model: "claude-sonnet-4-6",
  conversation: [{ role: "user", text: "What's the weather in Tokyo?" }],
  tools: [lookupWeather],
});

console.log(`reason=${result.reason}, iterations=${result.iterations}`);
console.log(`pending after run: ${pendingToolCalls(result.conversation).length}`);
console.log("---conversation---");
for (const m of result.conversation) {
  if (m.role === "assistant") {
    if (m.text) console.log(`assistant: ${m.text}`);
    for (const c of m.toolCalls ?? []) {
      console.log(`  → call ${c.name}(${JSON.stringify(c.arguments)})`);
      if (c.result) console.log(`    ↳ ${c.result.ok ? c.result.content : `ERR: ${c.result.error}`}`);
    }
  } else {
    console.log(`${m.role}: ${m.text}`);
  }
}
