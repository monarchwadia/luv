// Example: Bun server using luv-js for both backend chat completion and as a
// CORS-friendly proxy for browser clients. Run with:
//
//   bun run example:server     (from lib/js/)
//
// Then:
//   curl -X POST http://localhost:3000/chat \
//     -H 'content-type: application/json' \
//     -d '{"text":"hi"}'
//
// Bind address: 0.0.0.0 so the host machine can reach the server when this
// runs inside a devcontainer. VS Code typically auto-forwards port 3000;
// see .devcontainer/devcontainer.json `forwardPorts` if it doesn't.

import { send, sendStream } from "../src/index.ts";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in environment");
  process.exit(1);
}

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  routes: {
    "/": () => new Response(Bun.file(`${import.meta.dir}/browser/index.html`)),
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

console.log("listening on http://0.0.0.0:3000");
