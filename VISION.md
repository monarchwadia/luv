# luv — Vision

## What this is

luv is a canonical conversation type and a family of structure-preserving
transformations to and from real LLM provider APIs. The spec is
language-agnostic; reference implementations are hydrated from it.

Unlike most LLM tooling, luv treats the *conversation* as the central
data structure — not as a transient input that gets thrown away after
the call completes. Conversations fork, persist, replay, validate, and
move between providers. The shape of the data carries the structure;
the runtime is responsible only for moving bytes.

## The killer demo

Same conversation. Different providers. No conversion code.

```ts
const conv = newConversation([{ role: "user", text: "Analyze this" }]);
const r1 = await openai.send({ conversation: conv });
conv.append(r1.message);
const r2 = await anthropic.send({ conversation: conv });
conv.append(r2.message);
const r3 = await gemini.send({ conversation: conv });
```

Three providers, one canonical type, no per-provider message adapters
at the call site. Switching providers mid-conversation is a property
of the type system, not a feature anyone has to implement.

And the second demo, the one most libraries don't have at all: the
conversation is a tree. Forks, alternatives, regenerations, and "what
if" agent branches all live in the same data structure.

## Who this is for

luv is built for **builders of agent-shaped applications** who need a
stable, portable, forkable representation of conversation state. The
four most natural audiences:

- **Mini agent CLIs** (Claude-Code-likes, aider-likes, custom dev
  assistants). 100-line CLIs become possible because forking is built
  in, tool use is in the canonical model, and streaming and
  non-streaming are coherent by construction.
- **Autonomous agent workers** that explore multiple plans, retry
  speculatively, or persist their state across runs. Forks are
  tree-of-thoughts in the type system.
- **History storage systems** that store conversations as primary
  data. Canonical JSON serialization round-trips losslessly; forks,
  edits, and tool-call traces are the data structure, not a schema
  invented per-app.
- **Agentic web UIs** that need native streaming, native forks, and
  native tool-call rendering. The same canonical types work in the
  browser and on the server.

## Who this is not for

luv is not trying to be the easiest way to talk to one LLM. If you're
committed to a single provider and just want a chat endpoint, the
provider's official SDK is simpler.

luv is also not an agent framework, a memory framework, a RAG library,
or a developer-ergonomics layer. Vercel AI SDK, LangChain, and
LlamaIndex solve different problems. luv is a *wire-level portability
and persistence substrate* — the data shape underneath whatever
agent runtime you build on top.

## Architecture in one diagram

```
                      ┌────────────────────────┐
                      │  Your CLI / Worker /   │
                      │  UI / Storage system   │
                      └─────────────┬──────────┘
                                    │
                                    │  uses canonical types
                                    ▼
                      ┌────────────────────────┐
                      │   Canonical types      │
                      │ (Conversation, Reply,  │
                      │  Stream<Reply>, ...)   │
                      └─────────────┬──────────┘
                                    │
                       ┌────────────┴───────────┐
                       │                        │
                       ▼                        ▼
                ┌──────────────┐         ┌──────────────┐
                │  Morphism    │         │  Morphism    │
                │  (openai)    │         │  (anthropic) │
                │  pure data   │         │  pure data   │
                └──────┬───────┘         └──────┬───────┘
                       │                        │
                       ▼                        ▼
                ┌──────────────┐         ┌──────────────┐
                │  Transport   │         │  Transport   │
                │  (HTTP, SSE) │         │  (HTTP, SSE) │
                └──────┬───────┘         └──────┬───────┘
                       │                        │
                       ▼                        ▼
                   OpenAI API              Anthropic API
```

- **Canonical types** are language-agnostic and shared across morphisms.
- **Morphism arrows** are pure data transformations (luv ↔ provider
  wire format). They are tested via byte-deterministic bench cases.
- **Transport arrows** layer HTTP and SSE on top of the morphism arrows.
  They are tested via recorded fixtures.
- **Your application** consumes canonical types directly. You never
  hand-roll a "provider message converter."

## What luv commits to

- **Forking conversations as first-class.** Not bolted on. Not an
  optional UX feature. The canonical conversation is a tree, always.
- **Errors as conversation data.** Provider failures appear in the
  message stream where they happened. They persist, replay, render.
- **Tool use is canonical.** Tool calls and results are blocks, not
  side-channel objects.
- **Streaming and non-streaming are equivalent.** The streaming functor
  guarantees they produce the same Reply regardless of when consumption
  happens.
- **Cross-language portability.** The spec is the contract; any
  language can hydrate it.
- **Zero dependencies.** The luv project itself takes no third-party
  npm/pip/cargo dependencies. Reference implementations are pure host
  language + standard library. Apps that *use* luv may depend on it;
  luv depends on nothing.

## What luv deliberately doesn't do

- Token counting, cost tracking, telemetry.
- Retry / backoff / rate-limit middleware.
- Provider auth orchestration beyond a single API key per client.
- Agent orchestration (planning, ReAct, hierarchical agents).
- Memory systems, RAG, embeddings.
- Multimodal inputs (images, audio) — deferred to a future spec version.

These belong above luv, in your application or in a separate library.
luv provides the substrate they sit on.

## Reading order

- `spec/SPEC.md` — the canonical types, laws, conformance contract.
- `spec/morphisms/openai_chat/openai_chat.md` — first worked morphism.
- `spec/morphisms/openai_chat/transport.md` — first worked transport.
- `impl/typescript/README.md` — quickstart and TS reference impl.
- `ROADMAP.md` — what's next.
- `DECISIONS.md` — rejected paths and the reasons.
