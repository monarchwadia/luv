# luv — TypeScript reference implementation

Implementation of the luv spec (`spec/SPEC.md`) in TypeScript. Runs in Bun;
the core `src/` is Web-API-only and works in browsers, Node, Bun, and
Deno. The bench runner (`test/`) is Bun-specific because it walks the
filesystem to discover spec cases.

Zero npm dependencies, runtime or dev.

## Layout

```
impl/typescript/
  package.json
  tsconfig.json
  src/
    index.ts                 — public exports
    types.ts                 — canonical types (Role, Block, Message, Node, Conversation, Reply, StreamEventReply, ValidationResult)
    encode.ts                — canonical JSON encoders + stringify
    stream.ts                — consume_luv_stream_reply, produce_luv_stream_reply
    validate.ts              — validate_luv_{conversation,message,block,reply,stream_reply}
    morphisms/
      openai_chat.ts         — three arrows for the openai_chat morphism
  test/
    bench.test.ts            — walks spec/cases/ and spec/morphisms/*/cases/, byte-compares
```

## Universal use

The `src/` code uses only standard JavaScript and Web APIs (no `node:fs`,
no `node:path`, no Bun-specific globals). It can be imported directly in
a browser, in Node, in Bun, or in any modern JS runtime.

```ts
import {
  consume_luv_stream_reply,
  produce_luv_stream_reply,
  validate_luv_conversation,
  stringify,
  encodeReply,
} from "./src/index.ts";

import { luv_conversation_to_openai_request } from "./src/morphisms/openai_chat.ts";

const reply = consume_luv_stream_reply(stream);
const bytes = stringify(encodeReply(reply));  // canonical JSON bytes
```

## Running the bench

```
cd impl/typescript
bun test
```

The bench walks the spec at `../../spec/` and runs each `input.json`
through the corresponding arrow, byte-comparing the canonical output to
`expected.json`. Tests pass iff the bytes match exactly.

## Arrows registered

Universal (spec-level) arrows:
- `consume_luv_stream_reply`
- `produce_luv_stream_reply`
- `validate_luv_conversation`

OpenAI morphism arrows:
- `luv_conversation_to_openai_request` (the bench fixes `model: "gpt-4o-mini"`)
- `openai_response_to_luv_reply`
- `openai_stream_to_luv_stream`

Other validators (`validate_luv_message`, `validate_luv_block`,
`validate_luv_reply`, `validate_luv_stream_reply`) are exported but not
yet exercised by bench cases.

## Design notes

- **Canonical JSON.** Encoders construct plain objects with property
  insertion in canonical key order; `JSON.stringify` preserves that order
  in ES2015+. `stringify` walks the value tree to reject lone surrogates
  before serializing (Section 3 rule 3).
- **Validators.** Single-pass walk over the input, accumulating errors,
  with a final stable sort by JSON Pointer path (depth-first, left-to-
  right traversal order).
- **OpenAI morphism.** The luv→request arrow takes an `opts` parameter
  for the model and other non-canonical request fields. The bench fixes
  `opts.model = "gpt-4o-mini"` to match the canonical case fixtures.
- **No npm deps.** All code is hand-written; Bun's built-in TypeScript
  support handles compilation. Tests use `bun:test`.
