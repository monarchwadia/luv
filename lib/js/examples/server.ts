// Example: Bun server demonstrating luv-js running both server-side AND
// inside the browser (via Bun's HTML bundler). Run with:
//
//   bun run example:server     (from lib/js/)
//
// Bind address: 0.0.0.0 so the host machine can reach the server when this
// runs inside a devcontainer. VS Code typically auto-forwards port 3000;
// see .devcontainer/devcontainer.json `forwardPorts` if it doesn't.

import { send, sendStream } from "../src/index.ts";

const PKG_ROOT = `${import.meta.dir}/..`;

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in environment");
  process.exit(1);
}

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  routes: {
    "/": () => new Response(Bun.file(`${PKG_ROOT}/examples/browser/index.html`)),

    // Bundled luv-js, ready for `<script type="module">` consumption in the browser.
    "/dist/index.js": () =>
      new Response(Bun.file(`${PKG_ROOT}/dist/index.js`), {
        headers: { "content-type": "application/javascript" },
      }),

    // The wasm binary the bundle's loader requests via `new URL(...)`.
    "/wasm/luv_core.wasm": () =>
      new Response(Bun.file(`${PKG_ROOT}/wasm/luv_core.wasm`), {
        headers: { "content-type": "application/wasm" },
      }),

    // Demo-only: hand the API key to the browser. In real apps the key stays
    // on the server. We do this here so the "client-side" toggle can show
    // luv-js running directly in the browser against OpenAI.
    "/config": () =>
      Response.json({
        apiKey,
        model: "gpt-4o-mini",
        warning: "demo only — never expose your real OpenAI key to the browser in production",
      }),

    // Server-side path: browser POSTs here, server uses luv-js's send/sendStream.
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
