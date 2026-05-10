// Example: Bun server using luv-js for both backend chat completion and as a
// CORS-friendly proxy for browser clients. Run with:
//
//   set -a && . ../../.env && set +a && bun run examples/server.ts
//
// Then:
//   curl -X POST http://localhost:3000/chat \
//     -H 'content-type: application/json' \
//     -d '{"text":"hi"}'

import { send, sendStream } from "../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in environment");
  process.exit(1);
}

Bun.serve({
  port: 3000,
  routes: {
    "/chat": {
      POST: async (req) => {
        const { text } = (await req.json()) as { text: string };
        const reply = await send({
          apiKey,
          model: "gpt-4o-mini",
          conversation: [{ role: "user", text }],
          maxTokens: 128,
        });
        return Response.json(reply);
      },
    },
    "/chat/stream": {
      POST: async (req) => {
        const { text } = (await req.json()) as { text: string };
        const stream = sendStream({
          apiKey,
          model: "gpt-4o-mini",
          conversation: [{ role: "user", text }],
          maxTokens: 128,
        });
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            for await (const event of stream) {
              controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
            }
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    },
  },
});

console.log("listening on http://localhost:3000");
