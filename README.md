# luv

**The conversation is the data structure.** A library for people who build
libraries, agents, and tools on top of LLMs.

luv is a canonical conversation type plus structure-preserving transformations
("morphisms") to and from real provider APIs. You carry one portable
conversation value; luv moves it to and from any provider. No per-provider
adapter code at your call site.

**Zero third-party dependencies, forever.**

---

## Why you'd want it

- **One conversation, any provider.** Switch providers mid-conversation without
  writing a "convert my messages to OpenAI format" function. That function *is*
  a morphism, and it already exists.
- **Conversations are trees.** Forks, regenerations, and "what if" agent
  branches live in the same data structure — `id` + `parent_id`, always. Linear
  consumers can ignore the fork structure.
- **It's a substrate, not a framework.** Canonical types and pure transforms.
  Bring your own orchestration, memory, retries, and cost tracking — luv stays
  out of your way.

```ts
import { newConversation, append, LuvClient } from "luv";

const openai    = new LuvClient({ api_key: OPENAI_KEY,    model: "gpt-4o" });
const anthropic = new LuvClient({ api_key: ANTHROPIC_KEY, model: "claude-opus-4-8" });

let conv = newConversation([{ role: "user", text: "Analyze this dataset." }]);

const r1 = await openai.send({ conversation: conv });     // OpenAI
conv = append(conv, r1.message);

const r2 = await anthropic.send({ conversation: conv });  // same conversation, Anthropic
conv = append(conv, r2.message);
```

> **Status:** Three morphisms shipped — OpenAI, Anthropic, and AWS Bedrock
> Converse (bench 61/61 green, smoke 11/11). The portability property is
> demonstrated: same conversation, three providers, zero adapter code.
> npm package not yet published — work against
> [`impl/typescript/`](impl/typescript/) for now.

---

## Five things to know

1. **Carry the conversation.** Build a `Conversation`, `send` it, `append` the
   reply, send again. Never hand-build provider request bodies.
2. **It's a tree.** Linear chat is the degenerate case. Fork by appending two
   nodes with the same `parent_id`. Walk `parent_id` when order matters.
3. **Errors are data *and* exceptions.** An `error` block mirrors the `LuvError`
   exception 1:1. Which you get is config (`error_mode: "throw" | "as_block"`),
   not a code change. `reply.finish_reason === "error"` is the failure check.
4. **Streaming ≡ non-streaming.** `client.stream(...)` reduces to the same
   `Reply` as `client.send(...)`. Don't write two paths that can disagree.
5. **Usage is provider-tagged, never normalized.** Token counts aren't
   commensurable across providers. `usage.raw` is the provider's own object;
   `usage.provider` + `usage.model` make it priceable.

---

## Canonical types

Object key order is **normative** — the canonical JSON form is byte-stable, so
fixtures and cross-language implementations agree exactly.

```ts
type Role = "system" | "user" | "assistant" | "tool";

type Block =
  | { kind: "text";        text: string }
  | { kind: "tool_call";   id: string; name: string; arguments: string }
  | { kind: "tool_result"; tool_call_id: string; content: Block[] }
  | { kind: "error";       category: string; message: string; details: unknown };

interface Message      { role: Role; content: Block[]; }
interface Node         { id: string; parent_id: string | null; message: Message; }
interface Conversation { spec_version: string; nodes: Node[]; }

type FinishReason = "end_turn" | "max_tokens" | "content_filter" | "error";
interface Usage   { provider: string; model: string; raw: unknown; }
interface Reply   { message: Message; finish_reason: FinishReason; usage: Usage | null; }

type StreamEventReply =
  | { kind: "start" }
  | { kind: "delta";  text: string }
  | { kind: "finish"; finish_reason: FinishReason; usage: Usage | null };
```

---

## Run the reference impl

TypeScript, Web-standard APIs only (`fetch`, `ReadableStream`, `TextDecoder`);
runs on Bun and any modern runtime.

```bash
cd impl/typescript
bun test        # bench: 61 cases, no network
bun run smoke   # end-to-end live test (needs API keys)
```

`OPENAI_API_KEY` is read from `/workspaces/luv/.env` or the process env.

---

## Not what you're looking for?

luv is not the easiest way to talk to one LLM — for a single provider, that
provider's SDK is simpler. It's not an agent framework, memory layer, or RAG
library either; Vercel AI SDK, LangChain, and LlamaIndex solve different
problems. luv is the wire-level portability and persistence substrate
*underneath* whatever you build.

It deliberately omits token counting, cost tracking, retries/backoff, auth
orchestration, agent orchestration, memory, RAG, and multimodal inputs. Those
belong above luv.

---

## Docs

- **[VISION.md](VISION.md)** — what luv is, who it's for, the demos.
- **[spec/SPEC.md](spec/SPEC.md)** — canonical types, laws, conformance contract (source of truth).
- **[spec/morphisms/openai_chat/](spec/morphisms/openai_chat/)** — first worked morphism + transport.
- **[spec/morphisms/bedrock_converse/](spec/morphisms/bedrock_converse/)** — AWS Bedrock Converse morphism.
- **[DECISIONS.md](DECISIONS.md)** — design decisions and rejected paths.
- **[ROADMAP.md](ROADMAP.md)** — what's shipped and what's next.
- **[AGENTS.md](AGENTS.md)** — rules for AI agents (and humans) contributing to luv.
