# simple-chat — minimal terminal chatbot

The smallest demo of luv as a local dep: a Bun + TypeScript REPL that
streams a real conversation through the OpenAI transport. About 80 lines
total. No build step, no bundler, no UI — just `bun chat.ts`.

## What it shows

- **Local path import.** `"luv": "../../typescript"` in `package.json`
  resolves to the in-repo implementation; `import { openaiClient } from "luv"`
  Just Works. No copy-pasted bundle, no published version required.
- **Canonical conversation, hand-built.** Each turn appends a `Node` with
  a `parent_id`. The whole `Conversation` is sent unchanged each call —
  the morphism handles provider shape.
- **Streaming.** The client returns an async iterable of
  `StreamEventReply`; this prints the `text_delta` events as they arrive.
- **Errors as data.** Provider failures throw `LuvError`, which carries a
  canonical `category` you can branch on without inspecting HTTP details.

## Run it

First time, build the luv package:

```sh
cd impl/typescript
bun install
bun run build         # produces dist/, what "luv" resolves to
```

Then install + run the example:

```sh
cd impl/typescript-examples/simple-chat
bun install
bun dev
```

The script reads `OPENAI_API_KEY` directly from the repo-root `.env`
(resolved via `import.meta.url`, so cwd doesn't matter). Existing env
vars take precedence. Override the model with `LUV_CHAT_MODEL`.

Type messages at the `you>` prompt. `exit`, `quit`, or Ctrl-D to leave.

## Files

```
chat.ts        the whole REPL
package.json   { "dependencies": { "luv": "../../typescript" } }
tsconfig.json  standard Bun-flavored TS config
```

## Swap providers

Change one line. The conversation is identical:

```ts
import { anthropicClient } from "luv";
const client = anthropicClient({ api_key: process.env.ANTHROPIC_API_KEY! });
```

That's the point of luv — the conversation is the contract; the morphism
is the swap.
