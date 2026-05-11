// One-shot send to a model. Edit and re-run.
//
//   bun 01_hello.ts                                  (from this directory)
//   cd lib/js && bun run sandbox examples/sandbox/01_hello.ts   (from lib/js)

import "./_env.ts";
import { send } from "../../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) throw new Error("OPENAI_API_KEY not in .env");

const reply = await send({
  apiKey,
  model: "gpt-4o-mini",
  conversation: [
    { role: "user", text: "Say hi in one short sentence." },
  ],
});

if (reply.message.role === "assistant") {
  console.log(reply.message.text);
}
console.log(`(stopReason=${reply.stopReason}, tokens=${reply.usage?.totalTokens ?? "?"})`);
