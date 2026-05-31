# luv core specification

This document is the single source of truth for the luv canonical types, the
laws every morphism must satisfy, and the vocabulary used throughout the
spec.

Individual morphism specifications (`spec/morphisms/<provider>/<provider>.md`)
extend this document. A morphism specification does not redefine principles,
canonical types, laws, or glossary terms — it references them by name.

---

## About this spec

luv is a small canonical conversation type and a family of *morphisms* —
bidirectional, structure-preserving transformations between the canonical
type and the wire formats of real LLM provider APIs. The spec is
language-agnostic; language-specific *implementations* are derived from
it.

### Benefits

- **Provider portability.** A canonical `Conversation` can be sent to any
  luv-supported provider, and a `Reply` from one provider is a valid
  Message to append before sending to another. Switching providers
  mid-conversation is a property of the type system, not a feature
  someone has to implement.
- **Cross-language conformance testing.** Every morphism ships JSON
  input/expected pairs at the morphism boundary. Any implementation in any
  language runs the same suite and verifies byte-equal outputs (Section 5).
- **Explicit lossy regions.** Where provider APIs diverge, the gap is
  enumerated in each morphism's `homomorphism_exceptions` table (Law L3)
  rather than hidden behind abstraction. You always know what you give up.
- **Small surface.** The canonical model is deliberately minimal (P5).
  Reading the spec end-to-end is short, and implementations can be small.
- **LLM-friendly.** The spec is structured for unambiguous machine
  reading (P1); generating a new implementation with an LLM is well-supported.

### Who this is for

- Library authors implementing LLM provider support in a new language.
- Builders of agentic systems that need to switch providers
  mid-conversation for cost, capability, or fallback reasons.
- Researchers benchmarking provider behavior on identical inputs.
- Teams that want to reason precisely about what is preserved across
  providers, rather than trust a provider-shaped abstraction.

### Drawbacks

- **Lossy by design (P7).** Provider-specific features outside the
  canonical model are not representable in luv values; they are named in
  each morphism's `homomorphism_exceptions` and effectively unavailable
  to portable code.
- **Narrow v1.** The current canonical types cover text and tool use.
  Multimodal inputs (images, audio), embeddings, fine-tuning, and
  provider-managed conversation state are out of scope until future
  spec versions.
- **Strict wire determinism.** An implementation must implement or import a
  canonical JSON serializer that obeys Section 3 exactly. Most
  off-the-shelf JSON libraries vary on key order, escape choices, and
  whitespace.
- **Vocabulary commitment.** The spec uses elementary category-theory
  vocabulary. The terms are basic and defined in the glossary (Section 6);
  if that is unwelcome friction, this spec is not for you.

### Who might not want this

- **Single-provider apps.** If you are committed to one provider and will
  not switch, a direct integration with that provider's official SDK is
  simpler.
- **Apps depending on provider-specific affordances.** If the features
  you need fall in the loss table (provider-only tool-call shapes, audio
  modalities, safety controls, etc.), the canonical type cannot carry
  them and luv will feel restrictive.
- **Teams already on a higher-level framework.** Vercel AI SDK,
  LangChain, LlamaIndex, and the official provider SDKs solve different
  problems. luv is a wire-level portability spec, not an agent framework
  or a developer-ergonomics layer.

---

## 1. Principles

### P1. The spec's primary consumer is an LLM.

Names, structure, and section order are chosen to keep the meaning stable
when an LLM reads, edits, or implements the spec — not to be terse for
humans. When in conflict, choose unambiguous machine reading over human
concision.

### P2. Arrow names are fully explicit.

Most arrows are named `<source_object>_to_<target_object>`, with both
endpoints spelled out (`luv_conversation_to_openai_request`, never
`to_openai`). The direction and both endpoints are visible in the name
itself, so a reader never has to infer them from context.

Canonical reduction and expansion arrows — operations that collapse a
canonical type into a simpler form, or lift a value into a richer form,
where the target is uniquely determined by the source — use the form
`<operation>_<source>` instead (e.g., `consume_luv_stream_reply`,
`produce_luv_stream_reply`). The target is implicit because the
operation name fixes it.

### P3. No category-theory term appears in the spec without a glossary entry.

The glossary (Section 6) is the single source for vocabulary. Any
category-theory term used in the spec without a corresponding glossary
entry is a spec bug.

### P4. Category theory is the modeling language.

Basic category theory (objects, arrows, composition, laws) gives a precise
vocabulary for talking about structure-preserving transformations between
provider APIs. Using an established language is clearer than inventing
project jargon, and most LLMs already know the basic terms. The spec uses
only elementary concepts, and every one of them is defined in the glossary
— no prior category theory knowledge is required to read or implement the
spec.

### P5. The luv canonical types are simple to a fault.

The canonical data model should be human-readable, a pleasure to work with
across contexts (browsers, servers, scripts, REPLs, hand-written examples),
and obvious at first sight. *Explainer: simplicity is the default. New
canonical structure is added only when no existing shape can carry the
information; provider-specific features belong in the morphism, not in the
canonical model. We resist adding variants, optional fields, and extra
layers.*

### P6. The spec document itself is human-readable.

The document is structured, named, and worded to be a pleasure to read
end-to-end. Section order matches the order in which an LLM or a human
would want to consume the spec; prose is clear; tables are short.
*Explainer: when P6 and P1 (LLM-primary) appear to conflict, P1 wins. In
practice what is unambiguous for an LLM is also clear for a human, so the
conflict is rare.*

### P7. Morphisms are lossy by design.

LLM provider APIs do not share a common operation set: system prompts,
refusal and safety signals, streaming formats, and finish-reason
vocabularies all differ in ways that matter for code. A perfectly lossless
transformation between any two of them is impossible, and trying to build
one would bloat the canonical types with provider-specific features
(violating P5). *Explainer: each morphism enumerates its exceptions in a
`homomorphism_exceptions` table; Law L3 requires that table to be
exhaustive. The goal is to keep the exception set small, stable, and
confined to features that don't matter much — not to eliminate it.*

### P8. The spec governs wire-level behavior only.

The canonical JSON encoding (Section 3) is the contract between
implementations. Internal representation of canonical values — record
versus tagged union versus dictionary versus class — is implementation
discretion. Arrows are conceptual functions; an implementation may expose them
as methods, free functions, classes, async functions, or any idiom that
fits the language. *Explainer: two implementations in different languages
interoperate iff they produce identical canonical JSON bytes for identical
canonical inputs. Anything below the wire is out of scope.*

```
    Implementation A                  Implementation B
    (e.g. Rust)                       (e.g. Python)

    ┌────────────────┐                ┌────────────────┐
    │   internal     │                │   internal     │
    │ representation │                │ representation │
    │  (any shape)   │                │  (any shape)   │
    └────────┬───────┘                └────────▲───────┘
             │                                 │
             │ encode                   decode │
             ▼                                 │
    ──────────────────────────────────────────────────────
      canonical JSON bytes  ← governed by this spec
      {"role":"user","content":[{"kind":"text","text":"hi"}]}
    ──────────────────────────────────────────────────────
```

---

## 2. Canonical types

The canonical types are the luv-side objects. Every morphism's arrows have
one of these types as their domain or codomain on the luv side.

All canonical types are defined by their canonical JSON encoding (Section 3).
The encoding is the type; two values are equal iff their canonical JSON
encodings are byte-equal.

The type notation used in this section is illustrative; the normative
definition of each type is its canonical JSON form. Primitive names denote
concepts, not host-language types: `Text` is a sequence of Unicode scalar
values; an ordered sequence (e.g. `[Block, ...]`) is a finite,
zero-indexed list; a brace literal denotes a record with named fields. An
implementation may represent canonical values in any internal shape its
host language admits (see P8).

The canonical types are shared across all morphisms. Because every
morphism produces and consumes the same canonical types, a reply from one
provider can be appended to a conversation and sent to a different
provider with no conversion step in between. That sharing is what makes
provider switching work: a conversation grows by appending replies from
different providers without ever leaving the canonical type.

```
       luv canonical                provider wire
       (this spec)                  (per-morphism spec)

       Conversation ──luv_conversation_to_openai_request──► OpenAI.Request

       Reply        ◄──openai_response_to_luv_reply──────── OpenAI.Response
```

### 2.1 Role

An enumeration of conversational roles.

```
Role := "system" | "user" | "assistant"
```

Canonical JSON form: a string equal to one of the three literals above.

### 2.2 Message

A single utterance in a conversation. A message has a role and an
ordered list of content blocks.

```
Message := {
  role: Role,
  content: [Block, ...]
}
```

Where `Block` is a sum type with four variants:

```
Block :=
  | { kind: "text", text: Text }
  | { kind: "tool_call", id: Text, name: Text, args: Text }
  | { kind: "tool_result", call_id: Text, text: Text }
  | { kind: "error", category: ErrorCategory, message: Text, details: Text }

ErrorCategory :=
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "content_filter"
  | "server_error"
  | "network"
  | "tool_execution"
  | "local_validation"
  | "unknown"
```

**Block variants.**

- **text** — natural-language content. `text` may be empty.
- **tool_call** — an assistant's request to invoke a tool. `id` is the
  provider-issued identifier for this specific call. `name` is the tool
  being invoked. `args` is the tool arguments encoded as canonical JSON
  (Section 3) carried as a `Text` value; each tool defines its own
  argument schema, which luv does not validate.
- **tool_result** — a tool's response, sent back into the conversation.
  `call_id` references the `id` of the originating `tool_call`. `text`
  carries the tool's output as a string; use canonical JSON for
  structured results.
- **error** — a failure observed during the production of this message,
  surfaced as conversation data rather than thrown out-of-band. `category`
  identifies the failure class; `message` is a human-readable summary;
  `details` is canonical JSON (Section 3) carried as `Text` for any
  structured payload (HTTP status, retry-after, provider error body,
  etc.). *Rationale: luv treats errors as conversation state because
  conversations are the unit of persistence, replay, and forking. An
  error that happened during a previous turn is part of that turn's
  history; rendering, storing, and reasoning about it benefits from it
  being data alongside text and tool calls.* Implementations may
  surface errors as blocks or as thrown exceptions; the choice is
  per-category configuration (transport spec) and outside the canonical
  spec.

**`ErrorCategory` values.**

| Value | Meaning |
|---|---|
| `auth` | Authentication or authorization failure (HTTP 401, invalid API key). |
| `rate_limit` | Provider rate limit exceeded (HTTP 429). |
| `bad_request` | Request was malformed or rejected by the provider for shape reasons (HTTP 400). |
| `content_filter` | Provider's safety system blocked the request or response content. |
| `server_error` | Provider-side internal error (HTTP 5xx). |
| `network` | Network-level failure (connection refused, DNS, TLS, timeout, connection drop). |
| `tool_execution` | A tool handler threw or returned malformed output. Emitted by the agent layer, not the transport. |
| `local_validation` | A luv validator (Section 2.7) rejected canonical data. |
| `unknown` | Catchall for failures that do not map to any of the above. |

**Role conventions (not enforced at the type level).**

- `text` blocks may appear in messages of any role.
- `tool_call` blocks appear only in assistant messages.
- `tool_result` blocks appear only in user messages.
- `error` blocks may appear in messages of any role; most naturally in
  the role of whoever generated the failure (assistant errors in
  assistant messages, tool errors in user messages).

A morphism may reject canonical messages that violate these conventions
by listing the rejection under its `homomorphism_exceptions`.

**Canonical JSON form (Message):**

```json
{"role":"<role>","content":[<block>, ...]}
```

Key order is fixed: `role` precedes `content`. Both fields are required.
`content` must contain at least one Block; an empty content array is
not a valid canonical Message.

**Canonical JSON form (Block):** a JSON object whose first key is
`kind`, followed by variant-specific fields in the order they appear in
the Block definition above.

### 2.3 Conversation

A conversation is a top-level container with a spec version marker and
a finite list of nodes. The version field declares which version of the
luv spec the conversation conforms to; readers determine how to
interpret the value from this field before parsing the rest.

```
Conversation := {
  spec_version: Text,
  nodes: [Node, ...]
}

Node := {
  id: Text,
  parent_id: Text | null,
  message: Message
}
```

**`spec_version`.** In this version of the spec, the value is the
string `"1.0"`. Future spec revisions will use higher version strings
following semantic-versioning conventions. Implementations should
refuse conversations whose `spec_version` they do not understand.

**Canonical JSON form (Conversation).**

```json
{"spec_version":"1.0","nodes":[{"id":"<id>","parent_id":"<id-or-null>","message":{...}}, ...]}
```

Key order is fixed: `spec_version` precedes `nodes`. Both fields are
required.

**Canonical JSON form (Node).** A node's key order is fixed: `id`
precedes `parent_id` precedes `message`. For root nodes, `parent_id`
is the JSON literal `null`.

An empty conversation is `{"spec_version":"1.0","nodes":[]}`.

**Well-formedness invariants.** A canonical Conversation is well-formed
iff all of the following hold:

1. **Known `spec_version`.** `spec_version` is a value the validator
   recognizes (currently `"1.0"`).
2. **Unique ids.** No two nodes share an `id`.
3. **Valid parent references.** For every node with non-null
   `parent_id`, a node with that `id` exists in `nodes`.
4. **Single root.** Exactly one node has `parent_id: null` (zero for
   an empty `nodes`).
5. **Topological array order.** A node's parent (if any) appears
   earlier in the `nodes` array than the node itself.
6. **Acyclic.** No node is its own ancestor. (Implied by 4+5.)
7. **`tool_result.call_id` resolves in ancestry.** If a node contains a
   `tool_result` block with `call_id: X`, then a node carrying a
   `tool_call` block with `id: X` must exist on the path from that node
   through `parent_id` to the root.

A conversation that violates any invariant is malformed; morphisms may
reject malformed conversations.

**Ordering.**

- Within siblings (nodes sharing the same `parent_id`), order is given
  by array position.
- The cross-branch order of nodes on different branches is not defined
  by the canonical type. Consumers that need a single linear projection
  designate a branch or apply their own interleaving rule.

**On mutation and pruning.**

The spec defines canonical conversation *states*, not operations on
them. Append, edit, fork, and prune are app-level concerns. A few
properties follow directly from the invariants:

- **Ids are stable in practice.** Modifying a node's `id` would orphan
  every node referencing it (invariant 2) and every `tool_result`
  referencing a `tool_call` in its content (invariant 6). Treat ids as
  immutable.
- **Fork-on-edit is the recommended pattern.** To "edit" a previous
  turn, the canonical pattern is to create a new node that shares the
  same `parent_id` as the original. Both versions persist; the consumer
  navigates to whichever it considers active. This preserves edit
  history, composes cleanly with replay and audit, and matches the way
  conversation UIs naturally render forks.
- **In-place message edits are allowed but lossy.** A node's `message`
  may be modified while preserving its `id` and `parent_id`, provided
  the result is still well-formed. (In particular, an edit that removes
  a `tool_call` block referenced by some descendant's `tool_result`
  violates invariant 7 and is therefore malformed — the descendants
  must also be removed, or the edit should be performed as a fork.) The
  prior content is not retained by the canonical type; this mode is
  appropriate only when edit history is not needed.
- **Logical pruning is free.** A consumer may treat any subtree as
  inactive (navigate elsewhere) without removing it from the canonical
  conversation. The data continues to live in the `nodes` array;
  invariants are undisturbed.
- **Physical pruning forces cascade.** If an interior node is
  physically removed from the array, all of its descendants must be
  removed with it to keep invariant 3 satisfied. There is no canonical
  in-place re-parenting operation.

### 2.4 FinishReason

An enumeration of reasons a Reply terminated.

```
FinishReason := "end_turn" | "max_tokens" | "content_filter" | "error"
```

Canonical JSON form: a string equal to one of the four literals above.

- `end_turn` — natural completion.
- `max_tokens` — output stopped because a token cap was reached.
- `content_filter` — provider safety system blocked the content.
- `error` — the turn failed before a natural finish reason could be
  reported (transport failure, network drop, parse error). The
  reply's `message.content` will contain an `error` block describing
  the failure.

Additional finish reasons (e.g., a dedicated `tool_use`) are deferred
to future spec versions.

### 2.5 Reply

The canonical result of producing one assistant turn in response to a
Conversation.

```
Reply := {
  message: Message,
  finish_reason: FinishReason,
  usage: Usage | null
}

Usage := {
  provider: String,
  model: String,
  raw: <morphism-defined object>
}
```

Canonical JSON form:

```json
{"message":{"role":"assistant","content":[<block>, ...]},"finish_reason":"<reason>","usage":<Usage>|null}
```

Key order is fixed: `message`, then `finish_reason`, then `usage`. The
nested message's `role` must be `"assistant"`. Its content blocks are
restricted to `text`, `tool_call`, and `error` (per the Block role
conventions in Section 2.2; `tool_result` blocks never appear in a
Reply because the assistant does not produce tool results, and an
`error` block indicates a Reply that terminated abnormally — see
Section 2.4 for the corresponding `error` finish_reason).

**Usage.** Token accounting is deliberately *not* collapsed into a
common metric. Token counts are not commensurable across providers
(different tokenizers and vocabularies), and pricing varies by provider,
model, and tier — so a single canonical token count would mislead more
than it helps. Instead, `usage` is a provider-tagged envelope:

- `provider` — the morphism id that produced the Reply (e.g.,
  `"openai_chat"`, `"anthropic_messages"`).
- `model` — the model id the provider reported; the key for pricing.
- `raw` — the provider's own usage object, preserved faithfully and in
  full: no field is dropped or normalized, and keys keep the provider's
  order. Its shape is *documented* by the producing morphism (see each
  morphism spec), but the morphism does not reconstruct or filter it —
  the universal core treats `raw` as opaque and carries the envelope
  through `consume` and `produce` unchanged.

`usage` is present on every Reply but is `null` when no usage is
available (e.g., a Reply that terminated with an `error`, or a stream
the provider did not annotate with usage). This boundary is deliberate
(see DECISIONS.md): luv canonicalizes the provider-independent
*conversation*, and preserves-with-provenance the provider-dependent
*usage*.

### 2.6 Stream and StreamEvent

A `Stream<T>` is a finite, ordered sequence of events that can be
*consumed* into a single value of type `T`. Streams are the incremental
form of a value: a producer emits events that, in aggregate, describe
the same `T` a non-streaming producer would produce all at once.

**consume.** Each canonical type for which `Stream<T>` is defined has a
*consume* arrow that collapses a stream into the value it represents.
The arrow is named `consume_luv_stream_<lowercase_type>`. The v1 instance
is `consume_luv_stream_reply`, which maps `Stream<Reply>` to `Reply`.

**Stream<Reply>.** In this version of the spec, `Stream<Reply>` is the
only realized instance of `Stream<T>`. Its events are:

```
StreamEvent<Reply> :=
  | { kind: "message_start" }
  | { kind: "block_start", block: Block }
  | { kind: "text_delta", text: Text }
  | { kind: "args_delta", args: Text }
  | { kind: "block_end" }
  | { kind: "message_end", finish_reason: FinishReason, usage: Usage | null }
```

In `block_start`, `block` is a `Block` in its initial form:

- `text` blocks: `text` is `""`; the final text accumulates via
  `text_delta` events.
- `tool_call` blocks: `args` is `""` (with `id` and `name` set to their
  final values); the final args accumulate via `args_delta` events.
- `error` blocks: complete at `block_start` (`category`, `message`,
  `details` all final); no delta events follow before `block_end`.

`tool_result` blocks do not appear in `Stream<Reply>` (per the Block
role conventions in Section 2.2, `tool_result` blocks belong in user
messages, not assistant replies).

A well-formed `Stream<Reply>` matches the grammar:

```
Stream<Reply> := message_start
                 (block_start (text_delta | args_delta)* block_end)*
                 message_end
```

Inside a `text` block, only `text_delta` events are valid. Inside a
`tool_call` block, only `args_delta` events are valid. Inside an
`error` block, no delta events are valid.

`consume_luv_stream_reply` produces a `Reply` whose `message` has
`role: "assistant"`. The content array is built from the events in
order:

- `block_start` appends the given block to `content`.
- `text_delta` appends its `text` to the current (text) block's `text`.
- `args_delta` appends its `args` to the current (tool_call) block's `args`.
- `block_end` finalizes the current block.
- `message_end`'s `finish_reason` becomes the reply's `finish_reason`,
  and its `usage` becomes the reply's `usage`.

**produce.** Each canonical type for which `Stream<T>` is defined also
has a *produce* arrow that lifts a value into the canonical singleton
stream that consumes back to it. The arrow is named
`produce_luv_stream_<lowercase_type>`. The v1 instance is
`produce_luv_stream_reply`, which maps `Reply` to `Stream<Reply>`.

`produce_luv_stream_reply(r)` emits, in order:

- one `message_start`;
- for each block `b` in `r.message.content`:
  - one `block_start` whose `block` is `b` in its initial form:
    `text: ""` if `b` is text; `args: ""` if `b` is tool_call (with
    `id` and `name` set to `b`'s values); `b` verbatim if `b` is error;
  - if `b` is a `text` block, one `text_delta` whose `text` is `b.text`;
  - if `b` is a `tool_call` block, one `args_delta` whose `args` is `b.args`;
  - if `b` is an `error` block, no delta event (the block is complete
    at `block_start`);
  - one `block_end`;
- one `message_end` whose `finish_reason` is `r.finish_reason` and whose
  `usage` is `r.usage`.

By construction,
`consume_luv_stream_reply(produce_luv_stream_reply(r)) = r` for every
`Reply` `r`. This identity is the round-trip law for the
`Stream<Reply>` / `Reply` pair and is bench-checkable as a universal
case under `spec/cases/`.

**Canonical JSON form.** A stream is encoded as a JSON array of its
events, in order. Each event is a JSON object with `kind` first,
followed by any variant-specific fields in the order shown above.

**Transport.** How a stream is delivered to or consumed by an
implementation (channels, iterators, callbacks, futures, blocking reads)
is implementation-defined. The spec describes only the sequence of
canonical events, not the transport that carries them.

### 2.7 Validators

Validators are arrows that take a canonical value and return a
`ValidationResult` describing whether the value is well-formed and, if
not, where it fails. Validators are the canonical mechanism for explicit
malformed-input detection. Non-validator arrows assume well-formed
canonical inputs (Section 4); implementations choose whether to run a
validator before applying other arrows.

Unlike other arrows, validators are defined for *alleged* canonical
values — inputs that are claimed to be of a canonical type but may
violate its well-formedness rules. A validator's job is to determine
which.

**ValidationResult and Error.**

```
ValidationResult :=
  | { valid: true }
  | { valid: false, errors: [Error, ...] }

Error := {
  path: Text,
  rule: Text,
  message: Text
}
```

Canonical JSON form: `{"valid":true}` for the valid case;
`{"valid":false,"errors":[<error>, ...]}` for the invalid case. Each
Error: `{"path":"<path>","rule":"<rule>","message":"<text>"}`. Key order
for `ValidationResult`: `valid` precedes `errors`. Key order for
`Error`: `path` precedes `rule` precedes `message`.

**Error paths.** `Error.path` is a **JSON Pointer (RFC 6901)** into the
validated input. The path must resolve to the exact offending element.
Examples:

- `/` — the root value
- `/spec_version` — the conversation's spec_version field
- `/nodes/3` — the 4th node
- `/nodes/3/parent_id` — the `parent_id` field of the 4th node
- `/nodes/3/message/content/1/text` — the `text` field of the 2nd block
  of the message of the 4th node

**Traversal order.** Validators emit errors in depth-first, left-to-right
order over the validated input. Array elements are visited by ascending
index. Object fields are visited in canonical key order (Section 3
rule 1). This guarantees byte-identical `ValidationResult` values across
correct implementations.

**Validator arrows.** This version of the spec defines five validators:

- `validate_luv_conversation : Conversation → ValidationResult`
- `validate_luv_message : Message → ValidationResult`
- `validate_luv_block : Block → ValidationResult`
- `validate_luv_reply : Reply → ValidationResult`
- `validate_luv_stream_reply : Stream<Reply> → ValidationResult`

A validator applies every rule appropriate to its input type, in
traversal order, accumulating errors. It returns `{valid: true}` if no
errors are found.

Larger validators compose smaller ones: `validate_luv_conversation`
applies `validate_luv_message` to each node's message;
`validate_luv_message` applies `validate_luv_block` to each block.
Errors from sub-validators have their `path` rewritten to be relative
to the outer input.

**Rule ids.** Rules are identified by stable string ids. A rule id,
once published in a spec version, is never renamed or repurposed.

#### Shape rules

| Rule id | Checks |
|---|---|
| `shape.role` | Role is `system`, `user`, or `assistant` |
| `shape.finish_reason` | FinishReason is `end_turn`, `max_tokens`, `content_filter`, or `error` |
| `shape.message.fields` | Message has required `{role, content}` with correct types |
| `shape.message.content_nonempty` | `content` has at least one Block |
| `shape.block.kind` | Block.kind is `text`, `tool_call`, `tool_result`, or `error` |
| `shape.block.text` | text variant has `{kind, text}` with correct types |
| `shape.block.tool_call` | tool_call variant has `{kind, id, name, args}` with correct types |
| `shape.block.tool_result` | tool_result variant has `{kind, call_id, text}` with correct types |
| `shape.block.error` | error variant has `{kind, category, message, details}` with correct types and `category` is a known `ErrorCategory` value |
| `shape.reply.fields` | Reply has `{message, finish_reason, usage}` with correct types (`usage` is a Usage object or `null`) |
| `shape.reply.usage` | When `usage` is non-null it has `{provider, model, raw}`; `provider` and `model` are strings (the `raw` shape is morphism-defined and not checked by the universal validator) |
| `shape.reply.assistant_role` | Reply.message.role is exactly `assistant` |
| `shape.reply.content_restriction` | Reply.message.content contains only text, tool_call, or error blocks (no tool_result) |
| `shape.node.fields` | Node has `{id, parent_id, message}` with correct types |
| `shape.stream_event.kind` | StreamEvent.kind matches a defined variant |
| `shape.stream_event.variant_fields` | StreamEvent variant has its required fields |

#### Conversation envelope (Section 2.3)

| Rule id | Checks |
|---|---|
| `shape.conversation.is_object` | Conversation must be a JSON object |
| `shape.conversation.fields` | Conversation has required `{spec_version, nodes}` with correct types |
| `shape.conversation.spec_version` | `spec_version` is a value this implementation recognizes |

#### Conversation graph invariants (Section 2.3)

| Rule id | Checks |
|---|---|
| `invariant.unique_ids` | Node ids are unique within the conversation |
| `invariant.parent_reference` | Every non-null `parent_id` resolves to a node in `nodes` |
| `invariant.single_root` | Exactly one node has `parent_id: null` (zero for empty `nodes`) |
| `invariant.topological_order` | A node's parent appears earlier in `nodes` than the node |
| `invariant.acyclic` | No node is its own ancestor |
| `invariant.tool_result_ancestry` | Every `tool_result.call_id` resolves to a `tool_call` on the ancestral path |

#### Block role conventions (Section 2.2)

| Rule id | Checks |
|---|---|
| `convention.tool_call_block_role` | tool_call blocks appear only in assistant messages |
| `convention.tool_result_block_role` | tool_result blocks appear only in user messages |

#### Stream<Reply> well-formedness (Section 2.6)

| Rule id | Checks |
|---|---|
| `stream.message_start_unique` | Exactly one `message_start` event at the start |
| `stream.message_end_unique` | Exactly one `message_end` event at the end |
| `stream.block_balance` | `block_start` / `block_end` events are balanced and properly nested |
| `stream.text_delta_in_text_block` | `text_delta` events appear only inside text blocks |
| `stream.args_delta_in_tool_call_block` | `args_delta` events appear only inside tool_call blocks |
| `stream.block_start_initial_form` | `block_start.block` has `text: ""` (text) or `args: ""` (tool_call) |
| `stream.no_tool_result_blocks` | No `tool_result` blocks appear (Stream<Reply> is assistant-only) |

**Primary failure point.** For invariant violations that span multiple
elements, the error's `path` points to the **primary failure point**:

| Rule | Primary path points to |
|---|---|
| `invariant.unique_ids` | `/nodes/<i>/id` of the second and each subsequent duplicate occurrence |
| `invariant.parent_reference` | `/nodes/<i>/parent_id` of the Node carrying the dangling reference |
| `invariant.single_root` | `/nodes/<i>` of the second and each subsequent root node |
| `invariant.topological_order` | `/nodes/<i>/parent_id` of the Node appearing earlier than its parent |
| `invariant.acyclic` | `/nodes/<i>` of the Node where the cycle is first observed |
| `invariant.tool_result_ancestry` | `/nodes/<i>/message/content/<j>/call_id` of the `tool_result` Block whose `call_id` does not resolve |
| `stream.block_balance` | The orphan `block_start` or `block_end` event |

For multi-element issues, one error is emitted per offending location;
the related path (if useful) may be mentioned in `message` but is not
encoded structurally in the Error.

---

## 3. Canonical JSON encoding

For Law L1 (Section 4.1) to be checkable, the JSON encoding of canonical
values must be byte-deterministic. The following rules define the canonical
encoding.

1. **Object keys** appear in the order specified by each type's definition
   in Section 2. Unspecified key orders are spec bugs.
2. **No insignificant whitespace.** No spaces around `:` or `,`; no leading
   or trailing whitespace; no newlines anywhere inside a value. A document
   may end with a single trailing `\n` only if it represents a top-level
   file.
3. **Strings.**
   - A string is a sequence of Unicode scalar values (codepoints in
     `U+0000`–`U+D7FF` or `U+E000`–`U+10FFFF`). The full Unicode range is
     supported deliberately, so that any human language is representable
     in canonical text.
   - Lone surrogates (codepoints in `U+D800`–`U+DFFF`) are not valid
     Unicode and are not representable; encoders must reject any input
     containing one.
   - Strings are serialized per RFC 8259 as UTF-8. Non-ASCII codepoints
     are emitted as their literal UTF-8 bytes, not `\uXXXX` escapes.
   - The mandatory escapes are `"`, `\`, and the C0 control range
     `U+0000`–`U+001F`. Each uses its short form where one exists
     (`\n`, `\t`, `\r`, `\b`, `\f`, `\"`, `\\`); otherwise `\u00XX`.
4. **Numbers.** JSON numbers are not used as such by any canonical
   type. When a canonical type needs a numeric value, it is represented
   as a JSON string containing a decimal numeral (e.g., `"42"`, `"0.7"`,
   `"-3.14"`). Decimal strings avoid IEEE 754 cross-language drift:
   every general-purpose language can parse a decimal string to its
   preferred numeric type without loss, whereas JSON-number
   round-tripping varies across implementations.
5. **Booleans.** Serialized as the JSON literals `true` or `false`.
6. **Null.** Serialized as the JSON literal `null`.

---

## 4. Laws

Every arrow in a morphism specification declares which of the following laws
it satisfies. A morphism may declare a law as *not satisfied* only with an
accompanying rationale in the morphism's `laws_satisfied` section.

Non-validator arrows are defined for well-formed canonical inputs only.
Behavior on inputs that violate the well-formedness invariants of their
domain type is undefined; an implementation may choose to validate inputs
before applying an arrow, but the spec does not require it.

### 4.1 L1. Wire determinism.

For any value `c` in the domain of an arrow `A`, the canonical JSON encoding
of `A(c)` is bytewise unique. The same input always produces the same output
bytes.

### 4.2 L2. Bench compliance.

For every case in this morphism's
`cases/<arrow_name>/<n>_<slug>/`, applying the arrow to `input.json`
produces `expected.json` byte-for-byte under the canonical JSON encoding
(Section 3).

### 4.3 L3. Homomorphism exceptions are exhaustive.

L3 applies to arrows declared in a morphism specification (provider
transformation arrows). Universal arrows defined in the core spec —
`consume_luv_stream_*`, `produce_luv_stream_*`, and the `validate_luv_*`
validators — are out of scope for L3.

Every morphism arrow is paired with a `homomorphism_exceptions` table
in its morphism specification. The table lists every kind of input
difference that the arrow may erase — i.e., pairs of distinct domain
values that the arrow maps to the same codomain value. The table is
*exhaustive*: if two domain values differ only in ways named in
`homomorphism_exceptions`, they may produce equal outputs; if they
differ in any way *not* named in the table, they must produce distinct
outputs. This is the formal characterization of where the arrow fails
to be a strict homomorphism, per P7.

### 4.4 L4. Stream coherence.

For every value-level arrow `f` whose codomain is a canonical type `T`
for which `Stream<T>` is defined (Section 2.6), the morphism declares a
corresponding stream-level arrow `stream(f)` whose codomain is
`Stream<T>`. The two must satisfy the coherence equation:

```
consume(stream(f)(s)) = f(consume(s))
```

In plain words: applying the streaming arrow and then consuming its
output yields the same value as consuming the input stream first and
then applying the value-level arrow. Streaming and non-streaming produce
the same result regardless of where consumption happens.

In v1 the only consume arrow defined is `consume_luv_stream_reply`
(Section 2.6), so L4 applies to every arrow with codomain `Reply` —
most directly to the pair `<provider>_response_to_luv_reply`
(value-level) and `<provider>_stream_to_luv_stream` (stream-level).

This is one structural law over the whole morphism, not a per-arrow
declaration. Adding a new arrow into `Reply` later (e.g., a middleware
or transform) does not require restating L4; the law already covers it.

---

## 5. Conformance

An *implementation* of luv is a program that provides one or more
morphisms in some host language. An implementation is conformant if it
satisfies the following.

### 5.1 Arrows implemented by name

For each morphism the implementation claims to support, it provides every
arrow declared in that morphism's specification, named exactly as
specified (per P2). How the arrows are exposed in the host language —
methods, free functions, classes, async functions, or anything else — is
the implementer's discretion (per P8).

### 5.2 Bench compliance

Implemented arrows draw conformance cases from two sources:

- **Universal cases** at `spec/cases/<arrow_name>/<n>_<slug>/` cover
  spec-level arrows that are not tied to any provider — e.g.,
  `consume_luv_stream_reply`. Every implementation must pass these
  regardless of which morphisms it supports.
- **Per-morphism cases** at
  `spec/morphisms/<provider>/cases/<arrow_name>/<n>_<slug>/` cover the
  arrows declared by that morphism. An implementation must pass the cases
  for every morphism it claims to support.

For every case in either source, applying the named arrow to
`input.json` produces bytes equal to `expected.json` under the canonical
JSON encoding (Section 3). This is Law L2.

### 5.3 Test runner mechanics

A conformance test runner needs only the following operations, available
in every general-purpose programming language:

1. Read `input.json` as a sequence of bytes.
2. Apply the arrow under test to that input.
3. Serialize the result per the canonical JSON encoding (Section 3).
4. Read `expected.json` as a sequence of bytes.
5. Compare the byte sequences for equality.

A case passes iff the byte sequences are equal. Internal representation,
parallelism, async, network access, error reporting, and CLI ergonomics
are all implementation-defined.

### 5.4 What the bench verifies (and what it does not)

The bench verifies that an implementation produces canonical JSON output
**byte-equal** to recorded `expected.json` for each `input.json`. This
guarantees behavioral stability over time and agreement between any two
implementations on every recorded case.

The bench does *not* independently verify correctness against the spec
prose. `expected.json` files are typically regenerated from a reference
implementation (via a recorder script that runs the arrow on a fresh
`input.json` and writes the result), then reviewed by humans via
version-control diff before being committed. Two implementations that
both pass the bench agree with each other; if a fixture is wrong,
neither implementation catches that — only the human review does.

Correctness verification happens through:

1. **Human review of `expected.json` diffs** when fixtures are refreshed
   against the live API.
2. **Direct reading of the spec** against the implementation by
   contributors.
3. **Live integration** (smoke tests against real provider endpoints)
   for transport-layer behavior.

The bench is a regression guard and a cross-implementation conformance
contract. It is not a correctness oracle.

---

## 6. Glossary

Every category-theoretic term, and every spec-specific term that carries
load-bearing meaning beyond ordinary English, is defined here. Terms are
listed alphabetically.

### arrow

A structure-preserving map from one *object* to another. In luv, an arrow
is a deterministic function from values of its *domain* object to values
of its *codomain* object. Every arrow has a name of the form
`<source>_to_<target>` (see P2).

### category

A collection of *objects* together with *arrows* between them, equipped
with *composition* and *identity*, satisfying associativity and identity
laws. The luv spec works within a single category whose objects are the
canonical types in Section 2 and the provider wire types introduced by
each morphism.

### codomain

The target *object* of an *arrow*. For
`luv_conversation_to_openai_request`, the codomain is `openai_request`.

### coherence

A property of a family of *arrows* (or laws over them) requiring that
different paths through a structure produce the same result. In luv,
Law L4 is a coherence equation for the streaming *functor*: applying a
value-level arrow before or after stream consumption yields the same
value.

### composition

The combination of two *arrows* into a single arrow. When the first
arrow's *codomain* matches the second arrow's *domain* — that is, the
first arrow goes from A to B and the second goes from B to C — they
combine into a single arrow from A to C, equivalent to applying the
first and then the second. The luv spec uses composition implicitly
(e.g., a streaming arrow followed by `consume` reconstructs a
non-streaming codomain value), but does not currently require morphisms
to declare explicit composed arrows.

### domain

The source *object* of an *arrow*. For
`luv_conversation_to_openai_request`, the domain is `luv_conversation`.

### equivalence class

A set of values that an *arrow* maps to the same output. The
`homomorphism_exceptions` table of an arrow names the dimensions along
which equivalence classes form.

### functor

A structure-preserving map between two categories: it sends each object
to an object and each arrow to an arrow, and preserves *composition* and
*identity*. In luv, the streaming lift (Section 2.6) is a functor from
the value category to the streaming category — every value-level arrow
has a stream-level counterpart, and Law L4 is the corresponding
coherence equation.

### homomorphism

A map between two structures of the same kind that preserves their shared
operations: combining two values and then mapping gives the same result as
mapping each value and then combining. In this spec, a luv morphism's
arrows are *not* strict homomorphisms (see P7); each arrow is paired with
a `homomorphism_exceptions` table (Law L3) that exhaustively enumerates
the kinds of input differences on which structure-preservation fails.

### identity

For every *object* there is an *arrow* from that object to itself that
maps every value to itself unchanged. Every category requires this
identity arrow to exist for every object. luv does not require morphisms
to explicitly declare identity arrows; they exist by convention.

### injective

An *arrow* is injective if it never maps two distinct inputs to the same
output — different inputs always produce different outputs. Law L3
(homomorphism exceptions are exhaustive) characterizes the precise
non-injective behavior of each arrow.

### law

An equational property — or an exhaustiveness condition — that an *arrow*
(or family of arrows) must satisfy. The laws in Section 4 are required to
hold for every arrow in every morphism specification that declares them.

### morphism

In general category theory, *morphism* is a synonym for *arrow*. In this
spec the term is also used in a coarser, packaging sense: a *morphism*
file is the complete specification of the *arrows* between the luv
canonical types (Section 2) and one provider's wire types, together with
field mappings, enum mappings, `homomorphism_exceptions`, and conformance
cases. Each provider has one morphism file under
`spec/morphisms/<provider>/`.

### object

A type in the spec, treated as a set of values. The canonical objects on
the luv side are listed in Section 2; each morphism declares the
provider-side objects it touches.

