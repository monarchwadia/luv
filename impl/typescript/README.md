# luv — TypeScript reference implementation

Hydration of the luv spec (`spec/SPEC.md`) in TypeScript. Runs in Bun;
the core `src/` is Web-API-only and works in browsers, Node, Bun, and
Deno. Zero npm dependencies, runtime or dev.

## Quickstart

```ts
import { openaiClient } from "luv";

const client = openaiClient({ api_key: process.env.OPENAI_API_KEY! });

const reply = await client.send(
  {
    spec_version: "1.0",
    nodes: [
      {
        id: "n1",
        parent_id: null,
        message: {
          role: "user",
          content: [{ kind: "text", text: "Hello!" }],
        },
      },
    ],
  },
  { model: "gpt-4o-mini" },
);

console.log(reply.message.content[0]);  // { kind: "text", text: "Hello! ..." }
```

Streaming:

```ts
for await (const event of client.stream(conv, { model: "gpt-4o-mini" })) {
  if (event.kind === "text_delta") process.stdout.write(event.text);
}
```

Errors:

```ts
import { LuvError } from "luv";

try {
  await client.send(conv, { model: "gpt-4o-mini" });
} catch (e) {
  if (e instanceof LuvError) {
    console.log(e.data.category);  // "auth" | "rate_limit" | ...
    console.log(e.data.message);
    console.log(e.data.details);   // canonical JSON string
  }
}
```

Configure per-error policy:

```ts
const client = openaiClient({
  api_key,
  on_error: {
    rate_limit: "as_block",  // surface as data instead of throwing
    content_filter: "as_block",
  },
});
```

## Layout

```
impl/typescript/
  package.json
  tsconfig.json
  src/
    index.ts                       — public exports
    types.ts                       — canonical types + LuvError + ErrorCategory
    encode.ts                      — canonical JSON encoders + stringify
    stream.ts                      — consume_luv_stream_reply, produce_luv_stream_reply
    validate.ts                    — five validators
    morphisms/
      openai_chat.ts               — three morphism arrows
    transport/
      openai_chat.ts               — three transport arrows + openaiClient
  test/
    bench.test.ts                  — walks spec/{cases,morphisms/*/cases}, byte-compares
  scripts/
    record.ts                      — refresh recorded fixtures against live API
    smoke.ts                       — end-to-end live API smoke test
```

## Scripts

| Command | What it does |
|---|---|
| `bun test` | Run the bench against on-disk fixtures (no network). |
| `bun run verify` | Verify request-shape cases (luv→provider) against the live API; no file writes. |
| `bun run record` | Refresh recorded fixtures (input.json + regenerated expected.json) by hitting the live API. Reviewable via `git diff`. |
| `bun run smoke` | Live end-to-end smoke test of `client.send` + `client.stream`. |

All scripts that hit the live API expect `OPENAI_API_KEY` in either
the environment or `<repo-root>/.env`.

## Universal use

The `src/` code uses only standard JavaScript and Web APIs (`fetch`,
`ReadableStream`, `TextDecoder`). It can be imported directly in a
browser, in Node, in Bun, or in any modern JS runtime. The bench runner
(`test/`) is Bun-specific because it walks the filesystem; everything
under `src/` is universal.

## Arrows registered with the bench

Universal (spec-level) arrows — `spec/cases/`:
- `consume_luv_stream_reply`
- `produce_luv_stream_reply`
- `validate_luv_conversation`

OpenAI morphism arrows — `spec/morphisms/openai_chat/cases/`:
- `luv_conversation_to_openai_request`
- `openai_response_to_luv_reply`
- `openai_stream_to_luv_stream`

OpenAI transport arrows — `spec/morphisms/openai_chat/cases/`:
- `luv_send_to_openai_http_request`
- `openai_http_response_to_luv_reply`
- `openai_http_stream_to_luv_stream`

Also exported but not (yet) exercised by bench cases:
`validate_luv_message`, `validate_luv_block`, `validate_luv_reply`,
`validate_luv_stream_reply`.

## OpenAI-compatible providers

`openaiClient` works with any provider that mirrors OpenAI's Chat
Completions wire format. Pass a `base_url`:

```ts
const togetherClient = openaiClient({
  api_key: process.env.TOGETHER_API_KEY!,
  base_url: "https://api.together.xyz/v1",
});
```

See `spec/morphisms/openai_chat/transport.md` for the full list of
known-compatible providers.

## Design notes

- **Canonical JSON.** Encoders construct plain objects with property
  insertion in canonical key order; `JSON.stringify` preserves that
  order in ES2015+. `stringify()` walks the value tree to reject lone
  surrogates before serializing (Section 3 rule 3).
- **Validators.** Single-pass walk, stable sort by JSON Pointer path at
  the end. Path format matches the spec exactly (`/nodes/<i>/...`).
- **Streaming.** `openaiClient.stream()` returns `AsyncIterable<StreamEventReply>` —
  the natural shape for TS (`for await`). Internally it reads the
  Response body via `ReadableStream` and emits luv events as bytes
  arrive; no buffering of the full response.
- **Recording.** `bun run record` refreshes `input.json` from the live
  API and regenerates `expected.json` from the current arrow. Diffs
  surface in `git diff` for human review before commit. Standard
  snapshot-test workflow.
- **No npm deps.** All code is hand-written. Bun's built-in TypeScript
  support handles compilation. Tests use `bun:test`. The transport
  layer uses `fetch`, `ReadableStream`, and `TextDecoder` — all Web
  Standard APIs available in every modern runtime.
