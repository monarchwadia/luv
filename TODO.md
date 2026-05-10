# TODO

Tracked work, roughly ordered by effort vs impact within each section. See
`IDEA.md` for the longer-form pitch behind the differentiator items.

## DX polish (close the gap with mainstream LLM SDKs)

- [ ] **README** with four-paragraph quickstart + 3-4 usage patterns. *~1 hour.*
- [ ] **`tool()` helper** that takes a typed JSON Schema literal (no zod dep —
      keep zero deps) and produces a typed `Tool` with inferred `args` types
      in the handler. *~50 lines.*
- [ ] **`stream.text()` helper** — `for await (const text of stream.text())`
      yields just the text deltas, hides start/stop events for the common
      streaming use case. *~10 lines.*
- [ ] **`usage` on `Reply`** — surface token counts from the morphism on both
      Zig and TS sides. *~30 lines per side.*
- [ ] **`createClient({apiKey, baseUrl})`** wrapper that bundles
      `send` / `sendStream` / `runAgent` calls without re-passing credentials.
      *~40 lines.*
- [ ] **Structured error subclasses** — `RateLimitError`, `AuthError`,
      `ContextWindowExceededError`, `ContentFilterError`, all extending
      `HttpError`. Map from HTTP status + response body shape. *~60 lines.*
- [ ] **`agentStep()`** primitive — single iteration of the loop, returns the
      next message + whether more turns are needed. Enables pause / resume /
      approval flows on top of the existing `runAgent`. *~80 lines.*
- [ ] **Provider subpath imports** — `import { send } from 'luv-js/openai'`
      that pre-curries provider construction. Also `luv-js/anthropic`,
      `luv-js/gemini` once those morphisms exist.
- [ ] **Document `Message`-array transforms** — `prependSystem`, `truncate`,
      `mapTool` etc. as a small `luv-js/utils` namespace. (The fuller transform
      suite lives below under "differentiator features".)

## Differentiator features (see IDEA.md)

These are the architecture-uniquely-enabled wins. Order is rough effort vs
impact — pick the ones that match where the project wants to go.

### Tier 1 — ship these first; they define the package

- [ ] **Middleware suite** as `luv-js/middleware`:
    - [ ] `retry(provider, { attempts, backoff })`
    - [ ] `cache(provider, { keyFn, store })`
    - [ ] `rateLimit(provider, { rps })`
    - [ ] `fallbackChain([primary, secondary, ...])`
    - [ ] `meter(provider, { onUsage })`
    - [ ] `trace(provider, { onSpan })`
    - [ ] `redact(provider, { patterns })`
- [ ] **Transforms suite** as `luv-js/transforms`:
    - [ ] `truncate(conv, { maxTokens, keep })`
    - [ ] `summarize(conv, { provider, keepRecent })`
    - [ ] `redact(conv, { patterns })`
    - [ ] `anonymize(conv, { mapping })`
    - [ ] `branch(conv)` — structural copy
    - [ ] `splice(conv, idx, replacement)`
    - [ ] `prependSystem(conv, text)`
    - [ ] `extractToolUses(conv)`
    - [ ] `stripToolMessages(conv)`
    - [ ] `pipe(...)` helper for composing the above
- [ ] **Recording / replay middleware**:
    - [ ] `record(provider, { tape })` — writes JSONL of every (request, reply)
    - [ ] `replay({ tape })` — Provider that reads the JSONL and serves replies
    - [ ] Tape format spec; tape versioning
    - [ ] Test-mode helper: auto-record in CI=false, auto-replay in CI=true
- [ ] **`asTool(agent)`** — turn a runAgent definition into a `Tool` so agents
      can delegate to sub-agents via the standard tools mechanism. ~20 lines.
- [ ] **`approveToolCalls(provider, { onCallRequested })`** — Provider
      middleware that intercepts replies with `tool_calls` and asks the
      caller to allow/deny/modify each before the agent loop executes them.
      ~40 lines.

### Tier 2 — useful but bigger

- [ ] **`ConversationTree`** — git-for-conversations: fork, checkout, diff,
      merge. ~150 lines.
- [ ] **`liveAgent` + `useLuvConversation` hook** — server runs the agent and
      streams `Message` deltas over WebSocket; React/Vue/Svelte hook mirrors
      the array on the client. ~50 lines server + ~30 lines per framework
      hook.
- [ ] **`lintConversation(conv, rules)`** — pure-function structural lint over
      `Message[]`. Built-in rules: noConsecutiveSystem, everyToolCallHasResult,
      maxLength, noPII. ~60 lines + per-rule.
- [ ] **`estimate(conv, { model, tokenizer, pricing })`** — token + cost
      preview before sending. Per-provider pricing tables. Per-model tokenizer
      selection. ~100 lines + tokenizer dep (or rough estimator with no dep).

### Tier 3 — defer until users ask

- [ ] **Property-based testing harness** for agent loops — generates random
      conversations + scripted provider replies, asserts loop invariants.
- [ ] **Type-state tracking** — `Conversation<HasUserMessage = true>` etc.
      for compile-time agent state machines. Probably over-engineered.

## Provider expansion

- [ ] **Anthropic morphism** (Zig + TS) — proves the cross-provider story
      against a genuinely-different wire shape. Use this to validate the
      luv canonical type stays a real forgetful quotient (not "OpenAI with
      different names").
- [ ] **Anthropic provider factory** — `anthropicProvider({apiKey})`.
- [ ] **Anthropic e2e tests** (Zig side, gated on env key).
- [ ] **Gemini morphism** + provider factory + e2e — third major shape.
- [ ] **OpenRouter / Ollama / vLLM compat shims** — thin wrappers around the
      OpenAI provider with `baseUrl` overrides and any per-platform quirks.

## MCP (client-only)

- [ ] **MCP client** as `core/src/mcp/` (Zig) and `lib/js/src/mcp/` (TS):
    - [ ] stdio transport + JSON-RPC framing
    - [ ] `initialize`, `tools/list`, `tools/call` methods
    - [ ] `connect({ command, args }) → Connection`
    - [ ] `connection.listTools() → Tool[]` — returns luv-shaped tools
          whose handlers call back through MCP
    - [ ] `connection.close()`
- [ ] **MCP fixture format** — captured stdio sessions, replayable for tests.
- [ ] **MCP examples** — connect to a known public MCP server, list tools,
      use them in `runAgent`.

## Documentation & evangelism

- [ ] **README** in `lib/js/` (covered above in DX polish).
- [ ] **Architecture overview doc** at repo root — the "Conversation is the
      API" framing, the Provider abstraction, the morphism boundary.
- [ ] **Migration guide** from OpenAI SDK / Vercel AI SDK to luv-js.
- [ ] **Changelog** — start one before the first published version.
- [ ] **Per-provider notes** under `core/src/morphisms/<provider>.md` — keep
      these current as morphisms grow.

## Videos (the explainer set)

- [ ] **"What is luv?"** — 3-5 min. The Conversation = `Message[]` framing.
      Why "the array is the API" matters. The three usage modes (manual /
      runAgent / hooks). Demo: switch providers mid-conversation.
- [ ] **"Building a tool-using agent in 5 minutes"** — start from `bun
      install`, end with a live agent loop calling a real tool. Hits the
      `tool()` helper, `runAgent`, lifecycle hooks, AbortSignal cancellation.
- [ ] **"Provider middleware: caching, retry, rate limit, recording"** — the
      composability story. Show wrapping a real provider in 5 layers, watch
      it Just Work.
- [ ] **"Conversation transforms"** — the `pipe()` story. Truncation,
      summarization, redaction. Pure functions, easy to test.
- [ ] **"Sub-agents as tools"** — the `asTool(agent)` pattern. Hierarchical
      agents in 20 lines.
- [ ] **"Time travel for agents"** — `ConversationTree`. Branching, diffing,
      "what if the model had said X."
- [ ] **"Live chat UI in 50 lines"** — `liveAgent` + `useLuvConversation`.
      Streaming a real conversation across a WebSocket, both ends mirror the
      same array.
- [ ] **"Architecture deep-dive"** — long-form. The forgetful-quotient
      framing for the canonical type. The Provider vtable. The fixture
      pattern. Why luv ships in two languages with shared fixtures rather
      than one wasm core.

## Internal / infra

- [ ] CI for the Zig side (`make test` + `make e2e`-with-secret-gate).
- [ ] CI for the TS side (`make js-test`).
- [ ] Publish workflow — bump version, build, npm publish.
- [ ] Pick a real package name (currently `luv-js`, private).
