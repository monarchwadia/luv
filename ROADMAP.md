# luv — Roadmap

Ordered roughly by adoption-leverage. Each item has a current status.

Status legend: **shipped** · **next** · **planned** · **deferred**

## Spec & TS reference impl

- ~~Canonical types (Conversation, Block, Message, Node, Reply, Stream<Reply>, ValidationResult)~~ — **shipped**
- ~~Eight principles, four laws, conformance contract~~ — **shipped**
- ~~OpenAI morphism + transport + 14 bench cases~~ — **shipped**
- ~~Record/verify/smoke scripts~~ — **shipped**
- ~~Errors-as-data: error blocks, FinishReason "error", LuvError~~ — **shipped**

## Next provider verticals

- ~~**Anthropic morphism + transport**~~ — **shipped**
  - Spec: `spec/morphisms/anthropic_messages/{anthropic_messages.md, transport.md}`
  - Impl: `impl/typescript/src/{morphisms,transport}/anthropic_messages.ts`
  - The first portability demo — same conversation, two providers.
- ~~**Bedrock Converse morphism**~~ — **shipped**
  - Spec: `spec/morphisms/bedrock_converse/bedrock_converse.md`
  - Impl: `impl/typescript/src/{morphisms,transport}/bedrock_converse.ts`
  - Targets AWS Bedrock Converse API — one morphism covering all chat
    models on Bedrock (Claude, Llama, Mistral, Nova, etc.).
  - No transport spec (SigV4 signing + event-stream decoding are
    impl-level concerns, not contract-grade).
  - 16 bench cases, 11/11 smoke.
- **Gemini morphism + transport** — **planned**
  - After Anthropic. Different enough wire shape to validate the spec
    where two morphisms can't.

## Adoption artifacts

- **`examples/claw/`** — reference agent CLI — **next**
  - 400–600 lines. Demonstrates: regenerate via fork, undo via parent
    walk, branch from any node, tool approval, conversation
    persistence, multi-provider switch, slash commands.
  - The single most valuable artifact for the agent-CLI niche.
- **`examples/web-fork-ui/`** — minimal browser chat UI with fork
  rendering — **planned**
  - The launch artifact: someone watches a 30-second screen recording
    and sees forks as a native data structure.
- **Repo-root `README.md`** — **planned**
  - Headlines the killer demo, links to VISION, SPEC, impl quickstart.
  - Currently no root README at all.
- **npm publish (`luv` package)** — **planned**
  - Zero-dep package; install with `npm i luv`.
  - Blocks on Anthropic morphism (so portability is a demonstrated
    property, not a promise).
- **Launch post + Show HN** — **planned**
  - Drafts: "luv: a wire-level spec for portable LLM conversations"
  - Tactical: target builders, not the general "AI thought leader"
    crowd.

## Spec cleanup

- **Bench cases for the four uncovered validators** — **planned**
  - `validate_luv_message`, `validate_luv_block`, `validate_luv_reply`,
    `validate_luv_stream_reply`. Currently spec'd and impl'd but no
    cases exercise them in isolation.
- **Additional bench coverage** — **planned**
  - Multi-tool-call cases (one assistant message with N parallel
    tool_calls).
  - `content_filter` and `max_tokens` finish-reason cases.
  - Round-trip fork cases (Conversation with multiple sibling
    branches).
- **Edge case rules for stream parsing** — **deferred**
  - Multi-line `data:` SSE events; partial chunks at network boundary;
    `[DONE]` mid-stream; ID disagreement across chunks.

## Future morphisms

- **Mistral / Together AI / OpenRouter** — **deferred** (use the OpenAI
  morphism with `base_url` override; promote to dedicated morphism only
  if their behavior diverges).
- **Azure OpenAI** — **deferred** (URL pattern differs enough that a
  thin wrapper or dedicated morphism is likely needed).
- **Local model servers (vLLM, LM Studio, Ollama)** — **deferred** (most
  expose OpenAI-compatible endpoints; users override `base_url`).

## Bigger items, lower priority

- **Multimodal canonical types** — **deferred**. Image, audio, file
  blocks. Significant spec expansion; not until a real use case
  demands it.
- **Embeddings morphism family** — **deferred**. Different shape (vector
  output) than chat morphisms. Would need its own canonical type and
  laws.
- **Middleware layer (formalized)** — **deferred**. Patterns like cache,
  retry, replay are mentioned in design notes; a canonical
  middleware-as-functor framing would slot in after a second morphism
  exists to motivate composition.
- **L5 cross-morphism conformance law (formerly aspirational)** —
  **deferred**. Once Anthropic morphism lands, revisit whether a real
  cross-morphism law can be stated and checked.

## Not on the roadmap

- Agent orchestration framework
- Memory / RAG systems
- Token counting / cost tracking
- Provider observability layer
- Configuration / secrets management

These belong above luv, not in it.
