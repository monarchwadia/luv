# AGENTS.md

Instructions for AI coding agents working on the luv project. Read this
first.

## What luv is

A canonical conversation type and a family of bidirectional transformations
("morphisms") to and from LLM provider APIs. The spec is language-agnostic;
implementations are hydrated from it. See `VISION.md` for the full pitch.

## Reading order for context

1. **`VISION.md`** — what luv is, who it's for, killer demos. ~130 lines.
2. **`spec/SPEC.md` §1 (Principles)** — eight load-bearing principles. P1, P2, P5, P7, P8 matter most.
3. **`spec/SPEC.md` §2 (Canonical types)** — skim the type definitions.
4. **`DECISIONS.md`** — why things look the way they do (and not other ways).
5. **`ROADMAP.md`** — what's next, with priorities.

After that, drill in to whatever you're working on. `spec/SPEC.md` is the
contract; `impl/typescript/` is the reference; `spec/morphisms/openai_chat/`
is a worked example of how a morphism + transport pair looks end-to-end.

## Project structure

```
luv/
  VISION.md, ROADMAP.md, DECISIONS.md   — directional docs at top level
  AGENTS.md                              — this file
  .env                                   — OPENAI_API_KEY lives here
  spec/                                  — SOURCE OF TRUTH
    SPEC.md                              — canonical types, laws, conformance
    cases/                               — universal bench cases (consume, produce, validate)
    morphisms/<provider>/
      <provider>.md                      — morphism spec (pure data transforms)
      transport.md                       — transport spec (HTTP layer)
      cases/<arrow_name>/<n>_<slug>/     — bench cases, one per case
        input.json
        expected.json
        record.json                      — optional: how to refresh from live API
  impl/typescript/                       — TS reference implementation
    src/                                 — universal core (Web APIs only)
    test/bench.test.ts                   — bench runner
    scripts/record.ts, smoke.ts          — fixture refresh, live smoke
```

## Hard rules

These will get you reverted if you violate them.

1. **No third-party runtime dependencies. One dev exception.** The
   luv project ships with empty `dependencies`, forever. Exactly one
   dev dependency is permitted: `typescript`, used by `bun run build`
   to emit `.d.ts` declarations for the npm package. Tests, scripts,
   and shipped code use only Bun built-ins and Web standard APIs. If
   you find yourself wanting any other dep — runtime or dev — stop
   and ask.

2. **`spec/` is the source of truth.** When the spec and the impl
   disagree, the spec wins. Update the impl to match, not vice versa.
   Exception: a `bun run record` snapshot refresh updates `expected.json`
   from the impl — that's the documented snapshot workflow, but humans
   review the diff before committing.

3. **Don't break the bench.** `bun test` (in `impl/typescript/`) must
   stay green. Currently 27/27.

4. **Canonical JSON key order is normative.** Construct objects with
   keys in the order specified in Section 2; `JSON.stringify` preserves
   insertion order. If you reorder fields, you'll break bench
   byte-comparison.

5. **Arrow names are explicit** (P2). `luv_conversation_to_openai_request`,
   never `to_openai`. Canonical reduction arrows use `<operation>_<source>`
   (`consume_luv_stream_reply`, `produce_luv_stream_reply`).

6. **CT vocabulary requires glossary entries** (P3). If you introduce
   a category-theory term in the spec body, add a glossary entry in
   §6, alphabetically.

## Conventions

- **Filenames**: snake_case for spec files (e.g., `openai_chat.md`),
  camelCase for TS modules where idiomatic.
- **Spec section style**: numbered top-level sections (Section 1, 2, …);
  unnumbered "About this spec" preamble. Subsections like §2.3.
- **Commit messages**: short prefix (`spec:`, `transport:`, `docs:`,
  `chore:`), one-line summary, optional body with bullets. End with the
  Co-Authored-By line per the system prompt convention.
- **No emojis in spec or code.** Markdown formatting only.
- **No premature optimization or hypothetical-future features.** The spec is
  minimal by design (P5).

## Development workflow

```bash
cd impl/typescript

bun test              # Run bench (27 cases). No network.
bun run verify        # Check luv→OpenAI request shapes against live API.
bun run record        # Refresh fixtures from live API (review diffs!).
bun run smoke         # End-to-end live test of client.send + client.stream.
```

API key for `record`/`verify`/`smoke` is read from `/workspaces/luv/.env`
(or process env). Don't commit a real key.

## Adding things

### Add a bench case

For an existing arrow:

1. Create `spec/<universal_or_morphism_path>/cases/<arrow_name>/<NNN_slug>/`.
2. Write `input.json` (canonical JSON, one line, trailing newline).
3. Write `expected.json` (canonical JSON, one line, trailing newline).
4. Optional: `record.json` if the case should be refreshable from the
   live API (provider→luv cases).
5. Optional: `notes.md` for human-readable rationale on tricky cases.
6. Run `bun test`; case is auto-discovered.

### Add a morphism

1. Create `spec/morphisms/<provider>/<provider>.md` (see
   `openai_chat.md` as template). Include: objects, arrows, field
   mappings, enum mappings, `homomorphism_exceptions`, `laws_satisfied`.
2. Implement `impl/typescript/src/morphisms/<provider>.ts`.
3. Register the arrows in `impl/typescript/test/bench.test.ts`.
4. Add cases under `spec/morphisms/<provider>/cases/<arrow_name>/`.
5. Run `bun test`.

### Add a transport

1. Create `spec/morphisms/<provider>/transport.md` (see
   `openai_chat/transport.md` as template). Include: endpoint, auth,
   configuration, three arrows (request, response, stream), HTTP
   status → ErrorCategory mapping, SSE rules, out-of-scope items.
2. Implement `impl/typescript/src/transport/<provider>.ts`.
3. Register the three transport arrows in the bench runner.
4. Add cases under `spec/morphisms/<provider>/cases/<transport_arrow>/`.
5. Run `bun test` and `bun run smoke` (with API key for that provider).

### Add a canonical type

This is a bigger change. Steps:

1. Edit `spec/SPEC.md` §2 with the type definition + canonical JSON form.
2. If introducing a CT term, add a glossary entry in §6.
3. If adding validation rules, list them in §2.7's rule tables.
4. Update `impl/typescript/src/types.ts`, `encode.ts`, `validate.ts`.
5. Add bench cases (universal if type-only; per-morphism if provider-tied).
6. Update `DECISIONS.md` if a meaningful alternative was rejected.
7. Run `bun test`.

## Common gotchas

- **The bench is snapshot-style.** Passing bench does NOT mean
  spec-correct; it means the impl matches the recorded fixtures.
  See §5.4 of SPEC.md. Use `bun run smoke` and direct spec reading
  for correctness verification.
- **`expected.json` files are regenerated by `bun run record`.** When
  you change a morphism arrow's behavior, re-run record and review
  the diff carefully before committing.
- **Lone surrogates in strings are rejected** (Section 3 rule 3).
  The TS encoder throws on encountering them. If a test fixture
  unexpectedly contains one, the encoder will refuse.
- **Tool call IDs are non-deterministic.** OpenAI assigns a fresh
  `call_id` each request. After `bun run record`, the new IDs appear
  in both `input.json` and `expected.json`. The diff is benign.
- **Conversations are trees.** Don't assume linear iteration in your
  implementation. Use `parent_id` traversal where needed; topological
  array order lets linear consumers ignore the fork structure.
- **Errors are blocks AND exceptions.** Same data, two carriers.
  Switching between throw mode and as_block mode is configuration,
  not a code change.

## Verification before committing

In order:

1. `cd impl/typescript && bun test` (27/27 pass).
2. If you touched the transport or morphism arrows: `bun run smoke`
   (11/11 pass with valid API key).
3. If you changed any `expected.json`: `git diff` and confirm the
   change is what you meant.
4. If you renamed a canonical type or arrow: grep for old name across
   `spec/` and `impl/`; nothing should refer to it after.
5. Read your own diff before `git commit`.

## When something feels wrong

- If a principle (P1–P8) seems to be pushing you toward a worse
  outcome, the principle probably needs sharpening, not abandoning.
  Flag it; don't quietly violate it.
- If you find yourself wanting to add a dependency, an abstraction
  layer, or a configuration option, you're probably over-engineering.
  The spec is minimal by design.
- If the bench passes but your change feels wrong, you've found a
  fixture or case that's missing. Add it.
- If you can't figure out where something belongs (spec vs impl vs
  docs), ask. Wrong placement is harder to undo than asking.

## Pointers

- Spec contract: `spec/SPEC.md`
- Vision: `VISION.md`
- Roadmap: `ROADMAP.md`
- Decisions log: `DECISIONS.md`
- TS impl quickstart: `impl/typescript/README.md`
- First worked morphism: `spec/morphisms/openai_chat/openai_chat.md`
- First worked transport: `spec/morphisms/openai_chat/transport.md`
