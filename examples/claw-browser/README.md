# claw-browser

A working agent CLI that lives entirely in a browser tab. No install, no
server, no backend — just `index.html` + `app.js` + a bundled copy of
`luv.js`. The agent uses the File System Access API to read and write
real files on disk; it uses luv's canonical conversation type plus the
OpenAI and Anthropic morphisms to talk to a model of your choice.

## What it can do

- Open a folder on your machine (with explicit one-time permission).
- Chat with an LLM about that folder's contents.
- Let the LLM call three tools:
  - `list_files(path)` — list directory entries
  - `read_file(path)` — read a file's contents
  - `write_file(path, contents)` — write a file (asks for approval first)
- Stream the assistant's reply token-by-token.
- Switch providers (OpenAI / Anthropic) live without code changes.

All within ~400 lines of vanilla JS plus the bundled luv runtime
(~50 KB).

## Run it

You need a Chromium-based browser (Chrome, Edge, Brave, Arc, Opera) —
the File System Access API isn't yet in Firefox or Safari.

From the repo root, start any static server:

```sh
bun --hot serve .
# or
python3 -m http.server 8000
# or
npx serve
```

Then open `http://localhost:<port>/examples/claw-browser/index.html`.

1. Paste your `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` into the field.
2. Pick the matching provider and model from the dropdowns.
3. Click **open folder** and grant read/write access to the folder you
   want the agent to work on.
4. Type a request like "list the files here and tell me what this
   project is about" and hit send.

## What it does NOT do (yet)

- Forks in the UI. The data model supports them (every node has
  `parent_id`) but the V1 UI walks linearly. A future update will
  expose regenerate / branch buttons.
- Persistence. Reload = fresh conversation. IndexedDB save/load is on
  the roadmap.
- Multimodal. Text only for now.
- Local model execution. WebGPU + a small in-browser model would be a
  natural future morphism.

## How it's built

Three files:

```
index.html   — UI shell + styles
app.js       — 400 lines: tools, agent loop, DOM rendering, approval modal
luv.js       — bundled luv runtime (canonical types + transports)
```

`luv.js` is regenerated from `impl/typescript/` with:

```sh
cd impl/typescript
bun run scripts/bundle-browser.ts
```

That script wraps Bun's bundler to produce a single ESM file with all
of luv's runtime inlined.

## Security model

The browser is the sandbox. The agent can do exactly what the user has
granted via File System Access — typically one folder, with permission
revocable from the browser's settings at any time. Network access is
limited to the OpenAI / Anthropic endpoints (and any CORS-permitted
sites the agent reaches via `fetch`, which the spec'd tools don't
currently expose).

The user-approval gate on `write_file` is a UX safeguard, not a
security boundary; the browser's sandbox is the real boundary.

## Why this is interesting

A complete agent CLI as a single web page. Open it from a URL or a
local file. Share it as a link. Run it offline once cached. No node
runtime, no native install, no docker, no electron. The browser's
native APIs do everything.
