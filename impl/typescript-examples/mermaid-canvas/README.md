# mermaid-canvas — speak a diagram into being

Click **Record**, start talking, and watch a Mermaid diagram draw and
re-draw itself in real time from what you say. The transcript runs along
the bottom; the diagram fills the top 70% of the screen.

The browser handles listening and drawing. The server does one thing:
turn the running transcript into Mermaid source by asking an LLM
**through luv**. The conversation it sends is a canonical luv
`Conversation` — swapping OpenAI for Anthropic is a one-line change.

## What it shows

- **luv as the LLM layer.** `server.ts` builds a canonical `Conversation`
  (system prompt + the live transcript) and calls `client.send(...)`.
  Nothing in the request shape is provider-specific until the morphism.
- **Errors as data.** Provider failures come back as `LuvError` with a
  canonical `category`, returned to the browser as a clean JSON error.
- **A real prototype, two files.** `server.ts` (Bun + luv) and
  `index.html` (Mermaid + Web Speech API). No bundler, no framework.

## Run it

First time, build the luv package:

```sh
cd impl/typescript
bun install
bun run build         # produces dist/, what "luv" resolves to
```

Then install + run the example:

```sh
cd impl/typescript-examples/mermaid-canvas
bun install
bun dev
```

Open **http://localhost:3000 in Chrome** (the Web Speech API is a Chrome
thing), click **Record**, allow the mic, and start talking.

`OPENAI_API_KEY` is read from the repo-root `.env` (resolved via
`import.meta.url`, so cwd doesn't matter). Existing env vars win.
Override the model with `LUV_CANVAS_MODEL`, the port with `PORT`.

## How it works

```
mic ──Web Speech API──▶ transcript ──POST /diagram──▶ server.ts
                                                          │
                                              luv Conversation
                                                          │
                                                  client.send (OpenAI)
                                                          │
browser ◀── Mermaid source ◀────────────────────────────┘
   │
mermaid.render ──▶ SVG in the viewer
```

- Finalized speech results are appended to the transcript and trigger a
  **debounced** (~1s) request, so we don't hammer the API mid-sentence.
- The previous good diagram is sent as context, so the model **evolves**
  the picture instead of redrawing from scratch.
- If the model emits syntax that doesn't parse yet, the last good render
  stays on screen and a small warning appears.

## Notes / knobs

- **Chrome only** for speech — the Web Speech API isn't in Firefox/Safari.
  It's crappy but free and real-time, which is what a prototype wants.
- **Whisper upgrade path.** To swap Chrome's recognizer for OpenAI
  Whisper: record mic audio in the browser (`MediaRecorder`), POST the
  blob to a new `/transcribe` route, and call the OpenAI audio endpoint
  there. The `/diagram` half stays identical — it only ever sees text.
- **Swap providers.** Change `openaiClient` to `anthropicClient` in
  `server.ts`; the `Conversation` is unchanged. That's the luv point.

## Files

```
server.ts      Bun server: serves the page, POST /diagram → luv → Mermaid
index.html     the whole UI: viewer, transcript, Record, speech + mermaid
package.json   { "dependencies": { "luv": "../../typescript" } }
tsconfig.json  standard Bun-flavored TS config
```
