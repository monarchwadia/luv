import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "hi",
});
console.log(text);
