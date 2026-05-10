// Example: manual agent loop driven by agentStep — gives the caller a chance
// to inspect / approve / mutate the conversation between iterations.
//
// Run with:
//   bun run example:manual-loop     (from lib/js/)

import { agentStep, openaiProvider, tool } from "../src/index.ts";
import type { Message } from "../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in environment");
  process.exit(1);
}

const provider = openaiProvider({ apiKey });

const lookupWeather = tool({
  name: "lookup_weather",
  description: "Returns current weather for a city as a JSON string.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  handler: async ({ city }) => ({
    ok: true,
    content: JSON.stringify({ city, temp_c: 18, condition: "sunny" }),
  }),
});

let conversation: Message[] = [
  { role: "user", text: "Use the lookup_weather tool to find Tokyo's weather, then summarize in one short sentence." },
];

const MAX_TURNS = 5;
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  console.log(`\n--- turn ${turn} ---`);
  const step = await agentStep({
    provider,
    model: "gpt-4o-mini",
    conversation,
    tools: [lookupWeather],
  });
  conversation = [...conversation, ...step.newMessages];

  // Inspect / intervene between steps
  for (const m of step.newMessages) {
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      if (calls.length > 0) console.log(`assistant requested: ${calls.map((c) => c.name).join(", ")}`);
      else if (m.text) console.log(`assistant: ${m.text}`);
    } else if (m.role === "tool") {
      console.log(`tool result for ${m.callId}: ${m.result.ok ? m.result.content : "ERR " + m.result.error}`);
    }
  }

  if (step.done) {
    console.log(`\nfinished: reason=${step.reason}`);
    break;
  }
}
