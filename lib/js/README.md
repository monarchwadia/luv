# luv-js

A small, isomorphic JavaScript/TypeScript library for talking to OpenAI-shaped
chat APIs and building agent loops on top. Runs unchanged in Bun, Node 20+,
Deno, and modern browsers (via any bundler). Zero runtime dependencies.

The whole package is built around one idea: **the conversation is a plain
array of plain objects**. You can inspect it, mutate it, save it as JSON,
restore it, swap providers mid-conversation. Every operation in luv — `send`,
`sendStream`, `runAgent` — is a pure function from arrays to arrays.

This README covers installation, the four building-block APIs, and the
common patterns. For the architectural pitch and what's coming next, see
`IDEA.md` and `TODO.md` at the repo root.

## Install

```bash
bun add luv-js
# or
npm install luv-js
```

Bring your own OpenAI API key. Set `OPENAI_API_KEY` in your environment, or
pass `apiKey` directly. See "configuration" below.

## At a glance

```typescript
import { createClient, tool } from "luv-js";

const luv = createClient({ apiKey: process.env.OPENAI_API_KEY! });

// 1. One-shot chat
const reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "say hi in three words" }],
});
console.log(reply.message.role === "assistant" && reply.message.text);

// 2. Streaming
for await (const text of luv.sendStream({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "count to five" }],
}).text()) {
  process.stdout.write(text);
}

// 3. Agent loop with a tool
const result = await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "what's 17 * 23?" }],
  tools: [
    tool({
      name: "calc",
      description: "Evaluates an arithmetic expression",
      inputSchema: {
        type: "object",
        properties: { expr: { type: "string" } },
        required: ["expr"],
      },
      handler: async ({ expr }) => ({ ok: true, content: String(eval(expr)) }),
    }),
  ],
});
```

## The four building blocks

### `Conversation` is just `Message[]`

```typescript
type Message =
  | { role: "system";    text: string }
  | { role: "user";      text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool";      callId: string; result: ToolResult };

let conv: Message[] = [
  { role: "system", text: "be terse" },
  { role: "user",   text: "hello" },
];
```

The discriminated union narrows on `role`. TypeScript will tell you exactly
what fields you can access in each branch. There is no `Conversation` class
to construct, no methods to learn — it's just an array.

### `send(opts)` — one round-trip

```typescript
const reply: Reply = await luv.send({
  model: "gpt-4o-mini",
  conversation: conv,
  // optional:
  // maxTokens, temperature, tools, signal
});

reply.message;     // the assistant's reply, ready to push to conv
reply.stopReason;  // "end_turn" | "max_tokens" | "content_filter" | "tool_use" | …
reply.usage?.totalTokens;  // when the provider reports it
```

### `sendStream(opts)` — incremental streaming

Returns an object that can be consumed three ways:

```typescript
const stream = luv.sendStream({ model, conversation: conv });

// (a) Iterate text deltas only — most common
for await (const text of stream.text()) process.stdout.write(text);

// (b) Iterate every event (start, text, stop) — for fine control
for await (const event of stream) {
  if (event.type === "text") /* … */;
}

// (c) Just await the assembled final Reply
const reply = await stream.done;

// Cancel any time:
stream.cancel();   // or pass a signal: AbortSignal in opts
```

### `runAgent(opts)` — multi-turn loop with tool calling

```typescript
const result = await luv.runAgent({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "research X for me" }],
  tools: [searchTool, readUrlTool],
  maxIterations: 10,
  // optional lifecycle hooks:
  onTurnStart:  (i) => console.log("turn", i),
  onToolCall:   (c) => console.log("→", c.name),
  onToolResult: (c, r) => console.log("←", r.ok ? "ok" : r.error),
});

result.conversation;  // Message[] including every assistant + tool message
result.reason;        // "end_turn" | "max_iterations" | "aborted" | "error"
result.iterations;    // how many round-trips happened
```

## Patterns

### Manual conversation building

```typescript
let conv: Message[] = [];
conv.push({ role: "user", text: "hi" });
const r = await luv.send({ model: "gpt-4o-mini", conversation: conv });
conv.push(r.message);

conv.push({ role: "user", text: "follow up" });
// …continue, persist, branch, whatever you like
```

`Conversation` being a plain array means you can serialize it with
`JSON.stringify`, store it in a database, restore it, fork it, splice it.
No framework state to worry about.

### Defining a tool with type-safe arguments

```typescript
import { tool } from "luv-js";

const lookupWeather = tool({
  name: "lookup_weather",
  description: "Returns current weather for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string", enum: ["c", "f"] },
    },
    required: ["city"],
  },
  handler: async ({ city, units }) => {
    // city: string  (required)
    // units: "c" | "f" | undefined  (optional, narrowed to literal union)
    const data = await fetch(`https://wttr.in/${city}?format=j1`).then((r) => r.json());
    return { ok: true, content: JSON.stringify(data) };
  },
});
```

The handler's argument types are inferred from the JSON Schema literal. No
zod, no separate type declaration, no runtime validation library.

### Driving the agent loop manually (`agentStep`)

When you want pause/resume, approval gates, or per-step inspection:

```typescript
import { agentStep } from "luv-js";

let conv: Message[] = [{ role: "user", text: "do the thing" }];
while (true) {
  const step = await agentStep({
    provider: luv.provider,
    model: "gpt-4o-mini",
    conversation: conv,
    tools: [doThingTool],
  });
  conv.push(...step.newMessages);

  // Inspect what just happened. Maybe ask the user before continuing.
  const last = step.newMessages[step.newMessages.length - 1];
  if (last?.role === "tool" && /* something risky */) {
    if (!await confirm("continue?")) break;
  }
  if (step.done) break;
}
```

### Switching providers mid-conversation

The luv canonical type works as-is across providers (when more morphisms ship
in `luv-js/openai`, `luv-js/anthropic`, `luv-js/gemini`):

```typescript
import { openaiProvider } from "luv-js";
// (future) import { anthropicProvider } from "luv-js/anthropic";

const conv: Message[] = [{ role: "user", text: "analyze this" }];

const openai    = openaiProvider({ apiKey: OAI_KEY });
// const anthropic = anthropicProvider({ apiKey: ANT_KEY });

const r1 = await openai.send({ model: "gpt-4o", conversation: conv });
conv.push(r1.message);
// …continue with anthropic when its morphism lands.
```

### Handling errors

Errors come back as typed subclasses of `HttpError`. `instanceof` to discriminate:

```typescript
import {
  HttpError, AuthError, RateLimitError,
  ContextWindowExceededError, ContentFilterError, ServiceUnavailableError,
} from "luv-js";

try {
  await luv.send({ model, conversation });
} catch (err) {
  if (err instanceof RateLimitError) {
    await sleep(err.retryAfterMs ?? 1000);
    // retry
  } else if (err instanceof ContextWindowExceededError) {
    // trim the conversation and try again
  } else if (err instanceof AuthError) {
    // bad / missing key
  } else if (err instanceof ContentFilterError) {
    // surface to user
  } else {
    throw err;
  }
}
```

### Cancellation

Every long-running call accepts a standard `AbortSignal`:

```typescript
const ctl = new AbortController();
button.onclick = () => ctl.abort();
const result = await luv.runAgent({
  model, conversation, tools, signal: ctl.signal,
});
// result.reason === "aborted" if cancelled
```

## Configuration

`createClient` takes:

```typescript
createClient({
  apiKey: string,
  baseUrl?: string,   // default: "https://api.openai.com" — override for proxies
})
```

For one-off calls without a client wrapper, `send`, `sendStream`, and
`runAgent` (with `openaiProvider`) are exported directly:

```typescript
import { send, sendStream, runAgent, openaiProvider } from "luv-js";

await send({ apiKey, model, conversation });
const provider = openaiProvider({ apiKey });
await runAgent({ provider, model, conversation, tools });
```

## What's not in this package (yet)

This is an early release. Not yet shipped but on the roadmap (see
`TODO.md`):

- Anthropic + Gemini provider morphisms
- MCP client adapter (consumes MCP tool servers, exposes them as luv tools)
- Provider middleware (caching, retry, rate limit, recording, tracing)
- Conversation transforms (truncate, summarize, redact, branch, splice)
- `asTool(agent)` for hierarchical agents
- Token / cost estimation

The architecture is designed so these all add cheaply on top of what's here
— the canonical `Message[]` shape and the `Provider` vtable are stable
foundations.

## Compatibility

- **Bun** 1.0+
- **Node** 20+ (uses native `fetch`, `WebAssembly`, `TextEncoder`, `AbortController` — all standard since Node 18, but `tsc` types target 20+)
- **Deno** — works via the same standards
- **Browsers** — bundles cleanly with Bun, esbuild, Vite, Webpack, Rollup. Note: the browser cannot reach `api.openai.com` directly due to CORS; use a server-side proxy and point `baseUrl` at it.

## License

MIT.
