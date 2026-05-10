# Ideas — what luv's architecture uniquely enables

Things that are structurally easy in luv (because Conversation is just an
array and Provider is a tiny vtable) but painful or impossible in other
frameworks.

## The killer demo: cross-provider conversation portability

```typescript
const conv: Message[] = [{ role: 'user', text: 'analyze this' }];
const r1 = await openai.send({ model: 'gpt-4o', conversation: conv });
conv.push(r1.message);
const r2 = await anthropic.send({ model: 'claude-sonnet-4-5', conversation: conv });
conv.push(r2.message);
const r3 = await gemini.send({ model: 'gemini-2.5-pro', conversation: conv });
```

Same array, three providers. **Nobody else can do this** — Vercel AI SDK forces
unified message types per call, LangChain wraps everything in chains, the
official OpenAI/Anthropic SDKs only know their own provider. The luv canonical
type makes mid-conversation provider switching a non-event.

Belongs in the README as the first 5-line example. It's the architectural
promise made visible.

## Provider middleware — composable wrappers, ~20 lines each

```typescript
// All trivial because Provider is just { send, sendStream }
const traced     = trace(provider, { onSpan });
const cached     = cache(provider, { keyFn, store });
const retried    = retry(provider, { attempts: 3, backoff: 'exp' });
const limited    = rateLimit(provider, { rps: 10 });
const fallback   = fallbackChain([primary, secondary, tertiary]);
const recording  = record(provider, { tape: './fixtures/today.json' });
const replayed   = replay({ tape: './fixtures/today.json' });
const metered    = meter(provider, { onUsage });
const approved   = approveToolCalls(provider, { onCallRequested });
const sanitized  = redact(provider, { patterns: [/\b\d{16}\b/] });

// Compose freely:
const prod = retry(rateLimit(meter(traced(provider))));
```

Other frameworks bake retries / rate limiting / caching into the framework
directly, non-composably, and almost none offer recording/replaying as a
first-class primitive. **All of this is ~30 lines per wrapper** because the
Provider interface has only two methods. Ship as a `luv-js/middleware`
subpath.

The recording/replaying middleware is particularly underexploited:

```typescript
// In dev:
const provider = record(openaiProvider({apiKey}), { tape: './tape.json' });
await runAgent({ provider, ... });   // captures every send

// In tests, no API key needed:
const provider = replay({ tape: './tape.json' });
await runAgent({ provider, ... });   // replays bit-perfect
```

Makes integration tests deterministic without writing scenario fixtures by
hand.

## Conversation transforms — pure functions over `Message[]`

```typescript
// All ~10-50 lines, all `(Message[]) => Message[]`
const trimmed   = truncate(conv, { maxTokens: 8000, keep: 'tail' });
const compacted = await summarize(conv, { provider, keepRecent: 4 });
const safe      = redact(conv, { patterns: PII });
const renamed   = anonymize(conv, { 'Acme Corp': 'Company A' });
const forked    = branch(conv);  // structural copy
const replaced  = splice(conv, idx, [newMsg]);
const liftedSys = prependSystem(conv, 'You are…');
const callsOnly = extractToolUses(conv);  // for analytics
const noTools   = stripToolMessages(conv);  // for display
```

LangChain has scattered versions of some of these (token truncation,
summarization), but they're tangled into chain abstractions and not pure
functions. luv's `Message[]` makes them trivial.

The compose pattern is huge:

```typescript
const ready = pipe(
  raw,
  c => prependSystem(c, sys),
  c => redact(c, PII),
  c => truncate(c, { maxTokens: 8000 }),
);
```

## Time travel / branching as a first-class concept

```typescript
const tree = new ConversationTree(initial);
tree.fork('exploration_a');
const ra = await runAgent({ ..., conversation: tree.head() });
tree.commit(ra.conversation);

tree.checkout('main');
tree.fork('exploration_b');
const rb = await runAgent({ ..., conversation: tree.head() });

tree.diff('exploration_a', 'exploration_b');  // → array of differences
```

A git-for-conversations layer is ~150 lines on top of `Message[]`. Useful for:
- Chatbot debugging: "let me re-run from message 5 with a different system prompt"
- Prompt experimentation
- A/B testing prompts in production
- "What if the model had said X instead?" exploration

No framework does this today.

## Sub-agents as tools

```typescript
const researchAgent = asAgent({
  provider: gpt4o,
  model: 'gpt-4o',
  tools: [webSearch, readUrl],
});

// A higher-level agent that can delegate:
await runAgent({
  provider: gpt4o,
  model: 'gpt-4o-mini',
  conversation: [{ role: 'user', text: 'write a report on luv-js' }],
  tools: [
    asTool(researchAgent, { name: 'research', description: 'researches a topic deeply' }),
    writeFileTool,
  ],
});
```

`asTool(agent)` is ~20 lines: wrap a runAgent definition in a `Tool` whose
handler runs the sub-agent and returns the final assistant text. Now you have
hierarchical agents for free, with no framework overhead. CrewAI / AutoGen
build entire systems around this; luv gets it as a one-line helper.

## Live conversation streaming as a primitive

```typescript
// Server:
const stream = liveAgent({ provider, model, conversation, tools });
ws.on('message', msg => stream.append(JSON.parse(msg)));
stream.on('messageAdded', m => ws.send(JSON.stringify(m)));

// Client (browser):
const conv = useLuvConversation(ws);  // hook that mirrors the array
return conv.map(m => <Bubble key={m.id} message={m} />);
```

Because conversations are pure data, live-syncing them across a WebSocket is
~50 lines. The "operational transform" or "CRDT" complexity that group chat
needs doesn't apply because it's append-only most of the time. **The
`useLuvConversation` React/Vue/Svelte hook is the killer DX** for chat UIs.

## Approval gates / human-in-the-loop

```typescript
const guarded = approveToolCalls(provider, {
  onCallRequested: async (call) => {
    if (call.name === 'send_email') {
      const ok = await ui.confirm(`Send email to ${call.arguments.to}?`);
      return ok ? 'allow' : 'deny';
    }
    return 'allow';
  },
});

await runAgent({ provider: guarded, ... });
```

Provider middleware that intercepts replies with tool_calls. ~40 lines. **No
framework I know of has this as a primitive.** Exactly what's needed for
"approval workflows" / "agent UIs that ask before doing destructive things."

## Lint / validate conversations

```typescript
const issues = lintConversation(conv, [
  rules.noConsecutiveSystem,
  rules.everyToolCallHasResult,
  rules.maxLength(50),
  rules.noPII,
]);
```

Pure function over the array. Easy. Useful in production for catching bugs in
conversation construction, in tests for asserting structure.

## Token / cost estimation before sending

```typescript
const est = estimate(conv, {
  model: 'gpt-4o-mini',
  tokenizer: 'cl100k_base',
  pricing: PRICES,
});
// { tokens: 4321, cost_usd: 0.0009 }
```

Other libs do this internally for their own purposes; luv could expose it
because the data is right there in the array.

## What to ship — priority order

If picking one, **middleware suite + transforms** lands luv-js in the
"obviously useful, immediately differentiated" tier. ~600 lines total. The
README example becomes:

```typescript
import { runAgent, openaiProvider } from 'luv-js';
import { retry, cache, meter } from 'luv-js/middleware';
import { truncate, prependSystem } from 'luv-js/transforms';

const provider = retry(cache(meter(openaiProvider({apiKey}))));
const conv = prependSystem(truncate(input, {maxTokens: 8000}), 'You are…');
const result = await runAgent({ provider, model: 'gpt-4o-mini', conversation: conv });
```

Five composable abstractions, all working together because the substrate is
just data and a vtable. **That's the demo.**

If picking two, add **recording/replaying**. It's the single biggest dev
experience win — instant deterministic tests, free CI of agent code without
API keys, ability to share repro cases ("here's the tape that triggers the
bug") in issues.

If picking three, add **`asTool(agent)`**. Hierarchical agents in 20 lines.
The pitch writes itself.

These are all "obvious in retrospect" because of the architecture already
built — but no other framework can ship them this cheaply because their
architecture won't allow it.
