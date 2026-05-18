# Converge in Zig — parallelized execution plan

Single-source the luv logic in Zig; consume it from TS (and later other
languages) over a generated, codec-based wasm boundary. The TS public API and
the existing TS test suite do not change.

## Locked decisions (do not relitigate)

1. **Option C — sans-IO god object.** The pure transforms *and* the agent
   loop + middleware policy live in Zig as a sans-IO effect state machine.
   The host performs effects only; it never re-implements orchestration.
2. **Codec boundary, not JSON.** The binary codec (`core/src/wasm_abi/codec.zig`)
   is the interchange contract. JSON parsing stays on the host; wasm bricks
   never link `std.json`.
3. **Generated from Zig.** Types, codec encode/decode, the async driver, and
   the public-API wrappers are generated from the Zig source of truth — not
   hand-written.
4. **No third-party dependencies** (runtime or dev), per project rule.
5. **Lego invariant.** The god object *composes* bricks; it does not *contain*
   them. Pure bricks remain directly callable without the driver.
6. **Hand-written TS floor.** Only the irreducible host-capability glue is
   hand-written: the network adapter (`fetch` + streaming chunk reader), a
   small wasm bootstrap stub, and the TS-only type declarations for
   consumer-supplied closures/options. No business logic, nothing that mirrors
   Zig, nothing that can drift.

## The green-bar contract (the reason this is safe to parallelize)

- **Existing TS test files are never edited.** New *additive* test files
  (differential / conformance) may be created; the existing `bun test` suite
  must stay green throughout, untouched.
- **Branch-by-abstraction.** New Zig/wasm paths are built beside the old TS;
  the public wrapper is the seam. Signatures stay byte-identical.
- **Differential gate before deletion.** No TS logic is removed until a
  differential test proves the wasm path produces identical output for the
  same inputs, through the unchanged public API.
- **Foundation streams are purely additive** — they touch no file under
  `lib/js/src`, so they cannot turn the suite red.

Consequence: every step below has its own test and a defined pass criterion.
A stream is "broken" only if its own gate fails; the shared `bun test` suite
is a continuous invariant, never modified.

## Dependency graph

```
        ┌──────────── Foundation (additive, parallel) ────────────┐
        A. Codec & conformance     B. Type generator     C. Effect ABI + loader
        (no wasm, no src touched)  (no wasm)              (wasm, isolated echo)
        └───────────────┬───────────────┬───────────────────┬──────┘
                        │               │                   │
            ┌───────────┴───────────────┴─────────┐         │
            ▼                                      ▼         ▼
        D. Pure bricks (per-brick parallel)   E. Orchestration   F. Host adapters
        depends: A + C                        machine (C-spec)    depends: C
        each brick independent                depends: A + C      parallel to D/E
            └───────────────┬─────────────────────┴─────────────────┘
                            ▼
                    G. Integration / CI gate (merge-point + continuous)
```

A, B, C run fully in parallel. D, E, F begin once A+C exist; every brick in D
is its own parallel sub-stream; E runs parallel to D (it composes bricks via
effects, no direct code dependency).

---

## Stream A — Codec contract & cross-impl conformance
No wasm. No file under `lib/js/src` touched.

| Step | Work | Test gate |
|---|---|---|
| A1 | Freeze codec spec; author golden fixtures (canonical value ↔ codec bytes) | `zig build test`: Zig codec round-trips every fixture |
| A2 | Generate TS codec (encode/decode) from `codec.zig` | New additive test: TS-encoded == golden bytes; TS-decoded == value; **Zig bytes == TS bytes** for each fixture |

Exit: byte-exact codec parity TS↔Zig. `bun test` untouched throughout.

## Stream B — Zig→TS type generator
No wasm. Additive, then one type-only re-export.

| Step | Work | Test gate |
|---|---|---|
| B1 | Generator emits pure-data subset (`Role`, `StopReason`, `Usage`, `Conversation`, `Reply`, `ToolCall` data) + per-type rules for `Message`/`ToolResult` → `types.generated.ts` | tsc compiles generated file; structural type-assertion test |
| B2 | `types.ts` re-exports the generated subset (structurally identical → zero interface change) | `bun test` green, unmodified; tsc build green |

Exit: enum/data types single-sourced from Zig; public type surface identical.

## Stream C — Effect protocol & wasm loader
Wasm, but isolated to a trivial echo machine; no real brick, no `src` touched.

| Step | Work | Test gate |
|---|---|---|
| C1 | Define effect ABI: kinds (`http_request`, `http_read_chunk`, `sleep`, `tool_call`, `now`, `emit`), `start/poll/resume`, optional batched effects for parallelism. Trivial Zig echo machine exporting it | `zig build test`: echo machine state transitions |
| C2 | wasm loader + bootstrap (embed bytes; browser + node/bun) | Additive test: identity round-trip through `poll/resume` from TS |
| C3 | Generated async driver template (`poll → await interpret → resume`) | Additive test: `drive()` against echo machine with mock effect handlers |

Exit: a working generated driver proven against a fake machine, end to end.

## Stream D — Pure bricks (per-brick parallel sub-streams)
Depends: A + C. Bricks: `morphism-openai`, `sse_decoder`, `tool_calls`
(Zig exists) · `anthropic`, `tool_args`, `error-classify`, `object`
(Zig must be written). Each brick is an independent parallel sub-stream.

Per brick **X**:

| Step | Work | Test gate |
|---|---|---|
| X.1 | Ensure/author Zig impl of X | `zig build test`: X's Zig unit tests |
| X.2 | wasm export for X | `zig build test`: export-level test |
| X.3 | **Differential test** (new file): old `X.ts` vs wasm path over X's existing fixtures | outputs byte-identical |
| X.4 | Swap `X.ts` internals to call wasm via shim — **public signature byte-identical** | full existing `bun test` green, unmodified |
| X.5 | Delete dead TS logic in X | only after X.3 + X.4 green; `bun test` still green |

Exit per brick: X is single-sourced in Zig; consumer API and tests unchanged.

## Stream E — Orchestration state machine (Option C core)
Depends: A + C. Runs parallel to D (composes bricks via effects).

| Step | Work | Test gate |
|---|---|---|
| E1 | Agent loop as Zig sans-IO machine emitting effects | `zig build test`: state transitions with mock effect feed |
| E2 | Middleware policy (retry / rate-limit / fallback) as Zig effect transformers | `zig build test`: per-transformer unit tests |
| E3 | Differential-conformance suite (new files): old TS `runAgent`/`agentStep` vs Zig machine + host interpreter across matrix — multi-turn, tool calls, retry, fallback, abort, middleware order, streaming | identical observable behavior |
| E4 | Swap `runAgent`/`agentStep` internals to drive the Zig machine — signatures unchanged | existing agent `bun test` green, unmodified |
| E5 | Delete dead TS loop/middleware | only after E3 + E4 green |

Exit: orchestration single-sourced in Zig; `runAgent`/`agentStep` API intact.

## Stream F — Host capability adapters (the irreducible hand-written TS)
Depends: C (ABI defined). Parallel to D/E.

| Step | Work | Test gate |
|---|---|---|
| F1 | Network adapter: `http_request` + `http_read_chunk` via `fetch` + streaming body reader | Test against a local mock server (reuse integration `Bun.serve` pattern): adapter satisfies the effect contract |
| F2 | wasm bootstrap stub (browser + node/bun) | Instantiates across the bundler matrix |

Exit: the only hand-written runtime TS exists and is contract-tested.

## Stream G — Integration & CI gate (merge-point + continuous)

| Step | Work | Test gate |
|---|---|---|
| G1 | Run the bundler matrix **after the first D brick** (fail-fast on wasm-asset loading) **and** after E4 | matrix green across node/bun/esbuild/vite/webpack |
| G2 | Fold wasm build + codec-gen + type-gen into `make ci` | `make ci` green end to end |
| G3 | Strip differential scaffolding (optional, last) | `bun test` + matrix still green |

---

## Per-language note (why this scales)

After Stream A–C exist, a new language SDK = generated codec + generated
driver template (one per concurrency family: async/await · goroutine/channel ·
blocking-thread) + generated wrappers/types, plus that language's own
`http_request`/`http_read_chunk` body and a load stub. No re-implemented
orchestration; the hand-written floor per language is the network adapter and
bootstrap only.

## Start here

Kick off **A1, B1, C1** simultaneously — three independent, additive,
zero-risk lanes that unblock everything. D/E/F cannot start until A+C land;
the first cross-cutting risk (wasm asset in bundlers) is retired at G1, run
immediately after the first D brick — not deferred to the end.

## Open (low-stakes, decide later)

- Single-blob vs per-brick wasm artifacts (no `std.json` duplication concern
  remains under the codec boundary — defer; start single-blob).
- Whether the effect ABI ships batched/parallel effects in v1 or sequential
  only (affects parallel tool calls; design in C1).
