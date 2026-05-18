# Generate SDKs — Zig is the only hand-written logic; emit per language

Convergence (`converge-in-zig.md`) put all luv *logic* in Zig, consumed from
TS over the codec/wasm boundary. But the boundary glue (~1009 LOC of
`*_bridge.ts` + `sync.ts`, +~331 LOC `codec.ts`) is hand-written and would be
re-hand-written for every new language. This plan makes that glue **generated
from a single Zig-side descriptor**, so a new language SDK = a small backend
template, not a re-implementation.

## The ceiling (honest, non-negotiable)

"Only write Zig, emit all languages" is impossible at 100%. The freestanding
wasm boundary forces each language to hand-write its irreducible **effect
handlers** (HTTP `fetch`, SSE byte-pump, timer) and a thin idiomatic async
shim. Target ceiling: **Zig = only hand-written logic; per language =
generated (loader/codec/bridges/types) + ~one network adapter + async shim.**
Not zero per-language code — minimal, mechanical, uniform.

## Locked decisions

1. **Single Zig descriptor (`core/src/wasm_abi/abi.zig`)** is the source of
   truth for the boundary: every brick, its wasm export(s), ABI kind, the
   public fn it backs, status→error map, and declared host-guard carve-outs.
2. **Generator extends `gen_ts_types.zig`** (already Zig→TS type-gen) into
   `gen_sdk` — emits loader + bridges (+ codec, phase 3) + types per language
   via a pluggable **language backend** (the only per-language-differing part).
3. **Branch-by-abstraction + existing tests as the acceptance gate.** The
   codec conformance corpus, every `*_bridge` differential, and
   `agent.test.ts`/`stages.test.ts` (all unmodified, all green vs the
   hand-written bridges) verify the *generated* output. Generate alongside →
   prove byte/behaviour-identical via those suites → then delete hand-written.
4. **Carve-outs are declared, not invented.** Mechanical 90% generated;
   genuinely bespoke exceptions (`response_format` stays TS, anthropic
   content guard, tool_args `undefined` guard) declared in the descriptor or
   a tiny per-brick `*_extras` (~10–20 LOC each) the generated bridge imports.
5. **Green-bar contract** (same as converge): existing tests never modified;
   additive until a generated artifact is proven equal, then the
   hand-written one is deleted. Suite green at every commit.

## The keystone — `abi.zig` descriptor

```zig
pub const AbiKind = enum { bytes_io, handle_start, handle_poll,
                           handle_feed, handle_void, decoder };
pub const ErrCase = struct { status: i32, error_class: []const u8,
                             message: []const u8 };
pub const Brick = struct {
    module: []const u8,            // "tool_args"
    fn_name: []const u8,           // "parseArguments"
    wasm_export: []const u8,       // "luv_validate_tool_args"
    abi: AbiKind,
    err_map: []const ErrCase = &.{},
    host_guards: []const []const u8 = &.{},
};
pub const bricks = [_]Brick{ ... }; // 7 bricks + agent, as data
```

It is pure data (zero behaviour). A Zig test asserts internal consistency
(unique non-empty names, valid kinds). Real export-existence is enforced
later: the generated loader links against the real wasm — a missing export
fails there (and in `make gen-check`).

## Phases (gated, lowest-risk first)

**P1 — descriptor (`abi.zig`) + consistency test.** Pure data, additive,
zero behaviour change → TS suite untouched. Gate: `zig build test` green.
*Value even if we stop here: the boundary is one inspectable artifact.*

**P2 — generate loader + bridges (keep `codec.ts` hand-written).** Extend
`gen_ts_types.zig` → `gen_sdk.zig`: emit `loader`/`bridges` for TS from
`abi.zig` + `luv.zig` reflection. Generate **alongside** the hand-written
bridges; a parity test asserts generated≡hand-written; flip imports; delete
the ~1009 LOC of hand-written bridges + `sync.ts` glue. Gate: every existing
differential + full `bun test` + tsc green, unmodified. **Removes the bulk.**

**P3 — declarative wire schema → generate the codec.** Replace imperative
`codec.zig`/`codec.ts` with a comptime wire schema the generator emits from,
for Zig *and* every language. Kills `codec.ts` (~331) + the hand-written
Zig encode/decode duplication. Gate: codec conformance corpus (A1/A2)
green against generated codec, both impls.

**P4 — second language backend (Python or Go).** New backend template
(wasm runtime, bytes/error idioms); loader/codec/bridge logic reused.
Proves "one descriptor → N SDKs." Gate: a port of the conformance corpus +
a smoke SDK test in that language.

**P5 — fold into CI + strip scaffolding.** `make gen` also runs `gen_sdk`;
`gen-check` covers generated bridges/codec drift. Delete dead
`echo_loader.ts`/`EchoMachine` (C2 relics). Gate: `make ci` green.

## Honest scoping

P1 is tiny/safe (transcribe known mappings into data). P2 is a real project
but far smaller/safer than the migration — the mappings already exist and
the acceptance tests are already green. P3 is the larger refactor (it *is*
idea #1). P4 is the payoff. Irreducible per-language floor remains: HTTP
adapter + SSE pump + timer + async shim — generated boundary, hand-written
effects.

## Start here

P1 — `core/src/wasm_abi/abi.zig` + its consistency test. Pure data, zero
risk, immediately useful, unblocks the generator.
