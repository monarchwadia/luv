# luv spec

The luv specification: a language-agnostic, version-controlled description of
the luv canonical conversation type and the morphisms that map it to and from
real LLM provider APIs.

This folder contains **no executable code**. It is the source of truth.
Hydrations into specific languages consume this spec; they do not define it.

## Why a spec, not a reference implementation

A reference implementation in any single language anchors the spec to that
language's defaults: how nulls vs. missing fields are distinguished, integer
widths, error taxonomy, enum vs. tagged-union representation, streaming
back-pressure semantics. Those defaults leak into the "canonical" shape and
make every other hydration a translation of the reference instead of a peer
realization of the spec. The spec must stay portable on its own terms.

## What the spec contains

1. **Canonical types** — the luv-side conversation model (`Conversation`,
   `Message`, `Reply`, `Role`, `FinishReason`, streaming events, etc.),
   defined in language-neutral terms.

2. **Morphisms** — one spec per provider API, describing the bidirectional
   transformation between luv canonical values and the provider's wire
   format. Each morphism enumerates field mappings, enum mappings, lossy
   conversions, and edge cases.

3. **Conformance bench** — JSON input/output pairs at the morphism boundary
   (`{ luv_value.json, expected_provider_value.json }` and the reverse).
   Any hydrated implementation must reproduce these outputs exactly. The
   bench is the executable form of the spec.

## Non-goals

- Transport, auth, retries, rate limiting — concerns of the hydrations, not
  the morphism.
- SDK ergonomics, helpers, middleware — downstream of the spec.
- Performance characteristics — out of scope; the spec describes shapes and
  semantics, not runtime behavior.
