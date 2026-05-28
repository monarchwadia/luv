# luv — Design decisions

Each entry: what was considered, what was chosen, and why. Lists rejected
or deferred paths so future contributors don't reinvent them without
knowing the reasoning.

---

## Conversation envelope vs. flat list

**Considered:** `Conversation := [Node, ...]` (a bare JSON array at top
level).

**Chosen:** `Conversation := { spec_version, nodes }` (an envelope
object).

**Why:** A canonical conversation needs to declare which version of
luv it conforms to, so readers know how to interpret it before parsing
the rest. The envelope also leaves room for future top-level metadata
without changing the array shape.

---

## Forking model: tree vs. flat list with parent pointers

**Considered:**

- **C2.** Nested tree (`Node := { message, children: [Node, ...] }`).
- **C3.** Flat list with `parent_id` references (chosen).
- **C4.** Linear conversations + external fork relationships.

**Chosen:** C3 — flat list, `parent_id` on each Node.

**Why:**

- Maps naturally to relational and document storage (`messages` table
  with `parent_id` foreign key vs. anti-relational nested blobs).
- Linear case stays small (~one extra column) instead of becoming a
  100-level-deep nested tree.
- Append is O(1) regardless of conversation depth.
- Identity is explicit (every node has an id; references survive merges
  and partial deletes).
- Diff/merge between conversation states becomes a set operation on
  ids instead of structural tree diffing.

---

## Conversation head pointer

**Considered:** A `head: <id>` field on `Conversation` indicating
which leaf is "active."

**Rejected:** Navigation state is per-session and per-consumer, not
canonical conversation data. The git model — repo stores all commits;
HEAD is per-checkout — applies here. Apps that need to bundle "where
the user was looking" can wrap luv in their own envelope.

---

## Alternatives vs. forks split

**Considered:** Distinguishing "user-intent forks" from "n>1 alternative
completions" via separate fields or node kinds.

**Rejected.** The data shape is identical: N siblings sharing a
`parent_id`. The provenance (regeneration vs. retry vs. agent
exploration vs. n>1 sampling) is consumer concern, not canonical
data. Apps that need provenance store it externally.

---

## Errors: exceptions vs. data

**Considered:**

- **Throw only.** Errors are exceptions; never appear in the
  conversation.
- **Data only.** Errors are blocks; transports never throw.
- **Configurable per category** (chosen).

**Chosen:** Both representations coexist, with per-category policy.
The canonical form is the `error` Block; the `LuvError` exception
mirrors the same shape. Switching modes is `throw` ↔ `as_block` —
trivial because the data is the same.

**Why:** Different consumers want different ergonomics. Simple chat
apps want try/catch; persistence/replay/agentic apps want errors as
recoverable conversation state. Supporting both at zero cost lets
each consumer pick its idiom.

---

## ErrorCategory: subclasses vs. single class with data

**Considered:**

- Multiple `LuvError` subclasses (`LuvAuthError`, `LuvRateLimitError`,
  etc.) — TS `instanceof` based dispatch.
- Single `LuvError` class with a `data` field (chosen) carrying
  `{ category, message, details }`.

**Chosen:** Single class with `data` field.

**Why:** The class mirrors the canonical error Block 1:1. Switching
between "throw" and "as_block" modes is trivial — construct the same
data either way. Subclasses would require parallel hierarchies (one
for the canonical block kind, one for the JS error class) that drift
over time.

---

## `validation` → `local_validation` rename

**Considered:** Naming the ErrorCategory `validation`.

**Chosen:** `local_validation`.

**Why:** Disambiguates from provider-side validation (which is
`bad_request`). `local_validation` specifically means "a luv
validator (Section 2.7) rejected this canonical data."

---

## FinishReason "error"

**Considered:**

- Keep FinishReason at three values (`end_turn`, `max_tokens`,
  `content_filter`); detect failure by scanning for error blocks.
- Add `"error"` to FinishReason (chosen).

**Chosen:** Add `"error"`.

**Why:** One-field check (`reply.finish_reason === "error"`) is
ergonomic; saves every consumer from writing the same block-scan
boilerplate. The cost is one more enum value (P5 cost is small).

---

## JSON Schema for validation

**Considered:** Shipping a JSON Schema alongside the spec for shape
validation.

**Rejected** (for v1).

**Why:**

- Covers maybe 60% of the spec (type shapes and enum values) and
  falsely implies it covers more.
- Cannot express byte-level encoding rules (key order, escape choices,
  whitespace) — those are Section 3 concerns.
- Cannot express cross-element invariants (parent_id resolution,
  single root, ancestry). Those need a graph validator.
- Adds a second source of truth that can drift from the prose spec.
- The bench plus the spec-defined validator arrows cover every
  Schema-checkable property and more.

If a real use case emerges (editor tooling, code generation), we
can generate a JSON Schema from Section 2 at that point.

---

## RFC 8785 (JCS) as canonical encoding

**Considered:** Adopting RFC 8785 (JSON Canonicalization Scheme) as
the canonical encoding to unlock existing cross-language JCS
libraries.

**Deferred.**

**Why:** JCS sorts keys alphabetically. luv uses definition-order
keys. Alphabetical order produces uglier wire form for the same
content (`{"content":...,"role":"user"}` vs. `{"role":"user","content":...}`).
Definition order is more readable for the human-reviewing-fixtures
workflow. Revisit if cross-language tooling pressure becomes
significant.

---

## Strict homomorphism

**Considered:** Designing morphisms to be strict homomorphisms (no
information loss in either direction).

**Rejected.**

**Why:** LLM provider APIs do not share a common operation set
(system prompt handling, refusal representation, streaming algebras,
finish-reason vocabularies differ in load-bearing ways). A perfectly
lossless transformation between any two is mathematically impossible
without forcing every provider into the canonical model's exact
shape — which is not within our power. Each morphism instead
declares a `homomorphism_exceptions` table making the loss
*explicit*.

---

## Streaming consumer interface in the spec

**Considered:** Specifying `AsyncIterable<StreamEventReply>` (or
similar) as the canonical streaming interface.

**Rejected.**

**Why:** The spec defines events only (per P8 — wire-level behavior).
How a stream is delivered to or consumed by the host language —
channels, iterators, callbacks, futures, blocking reads — is
implementation-defined. The TS reference impl chooses `AsyncIterable`
because it's idiomatic; other languages pick their own idioms.

---

## Bench cases for transport: byte-level recording

**Considered:**

- No bench for transport; rely on integration tests.
- Bench cases that record real HTTP request/response pairs as JSON
  fixtures (chosen).

**Chosen:** Recorded fixtures, byte-comparison.

**Why:** Bench fixtures cover the same value proposition as
morphism-layer benches — cross-language byte determinism — at the
transport boundary. Catches status-code mapping and SSE parsing bugs
that pure-data morphism benches can't see.

---

## "In-spec subset" terminology

**Considered:** Defining "in-spec subset" as a glossary term for the
domain values where an arrow is a strict homomorphism.

**Rejected.**

**Why:** After L5 (cross-morphism preservation) was dropped, the term
was only referenced from one other glossary entry. The concept
existed but wasn't load-bearing. P5 (simple to a fault) — remove
unused vocabulary.

---

## Vestigial CT vocabulary (retraction, naturality, endomorphism)

**Considered:** Keeping `retraction`, `naturality`, `endomorphism`,
`functor` in the glossary as scaffolding for future use.

**Rejected** (kept only `functor`, which is actively used by Law L4).

**Why:** P3 (no CT term without a glossary entry) implies the
converse should also hold for simplicity — every glossary entry
should justify its presence. Vocabulary the spec doesn't actually
use creates friction for readers without any corresponding clarity
benefit. Reintroduce them when a law or morphism cites them.

---

## Mutation operations as canonical

**Considered:** Defining `append`, `fork`, `edit`, `prune` as
canonical arrows.

**Rejected.**

**Why:** The spec defines canonical *states*, not operations on them.
Mutations are app-level concerns. The well-formedness invariants
constrain what valid states look like; how an app moves between
states is its own design.

---

## OpenAI-side wire type key order

**Considered:** Not specifying key order for `OpenAI.Request`,
`OpenAI.Message`, etc. — letting impls choose.

**Rejected.** The transport bench compares the full HTTP request
byte-for-byte. Without specified key order, two implementations
would produce different bytes for the same canonical input.

**Chosen:** Document key order per OpenAI-side type in the morphism
+ transport spec.

---

## Reference claw as part of luv vs. separate

**Considered:** Bundling a Claude-Code-like CLI agent into the luv
package.

**Chosen:** Reference claw lives at `examples/claw/` (planned). It is
*not* part of luv. It uses luv as a substrate.

**Why:** luv is a substrate; the claw is an application built on top
of it. Bundling would conflate them. Keeping them separate lets the
claw evolve at its own pace and lets users fork it as a starting
point rather than treating it as a framework.

---

## Dependencies: zero runtime; one dev exception

**Considered:** Allowing dev dependencies (TypeScript compiler,
testing framework, linter, bundler).

**Chosen:** Zero runtime dependencies, ever. Exactly one dev
dependency permitted: `typescript`, used solely to emit `.d.ts`
declaration files during `bun run build` (consumed by `npm publish`).
Tests, scripts, and runtime code use only Bun built-ins and Web
standard APIs.

**Why the exception:**

- Bun's bundler can produce JavaScript but does not emit `.d.ts`
  declarations. Without them, the published npm package would either
  ship raw `.ts` (limiting it to TS-aware tooling) or no types at
  all (poor consumer DX). Shipping `.js` + `.d.ts` is the standard
  expectation for an npm library in 2026.
- `typescript` is the single canonical tool for this job; no
  reasonable alternative exists in the JS ecosystem.
- The dependency runs only at publish time. Consumers installing
  `luv` never pull TypeScript transitively — `dependencies` in the
  shipped `package.json` is empty.

Auditable supply chain is preserved: one well-known dev dep, used at
publish time only, never bundled into shipped code. The shipped
runtime in `dist/` is hand-written modulo `tsc`'s transpile output,
which is deterministic and inspectable.

(This is a project-level rule, not a spec rule; reference
implementations in other languages may relax it where their ecosystem
norms differ.)
