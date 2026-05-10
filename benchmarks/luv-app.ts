import { createClient } from "/workspaces/luv/lib/js/dist/index.js";
const luv = createClient({ apiKey: process.env.OPENAI_API_KEY! });
const reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "hi" }],
});
if (reply.message.role === "assistant") console.log(reply.message.text);
