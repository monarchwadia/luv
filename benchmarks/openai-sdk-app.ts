import OpenAI from "openai";
const client = new OpenAI();
const r = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
});
console.log(r.choices[0].message.content);
