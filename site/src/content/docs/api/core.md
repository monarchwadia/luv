---
title: send / sendStream / runAgent / agentStep
description: Core API reference.
---

The four entry points for talking to a provider. All accept and return
plain `Message[]` arrays.

## send

```ts
function send(opts: SendOptions, internal?: SendInternalOptions): Promise<Reply>;
```

One-shot chat completion. See [Quickstart](/guide/quickstart/) for usage.

### `SendOptions`

| Field | Type | Required | Notes |
|---|---|:-:|---|
| `apiKey` | `string` | ✓ | Provider API key |
| `model` | `string` | ✓ | Provider model identifier |
| `conversation` | `Message[]` | ✓ | The conversation array |
| `baseUrl` | `string` |   | Override default endpoint |
| `maxTokens` | `number` |   | Cap on completion tokens |
| `temperature` | `number` |   | 0..2 |
| `tools` | `Tool[]` |   | Tools available to the model |
| `signal` | `AbortSignal` |   | Cancel mid-flight |

### `Reply`

```ts
{
  message: Message,        // discriminated union; narrow on .role
  stopReason: StopReason,  // "end_turn" | "max_tokens" | "content_filter" | "stop_sequence" | "tool_use" | "other"
  usage?: Usage,           // { promptTokens, completionTokens, totalTokens } when reported
}
```

## sendStream

```ts
function sendStream(opts: SendStreamOptions): LuvStream;
```

Streaming chat completion. See [Streaming](/guide/streaming/) for usage.

`SendStreamOptions` extends `SendOptions` with optional lifecycle hooks:
`onStart`, `onDelta`, `onStop`, `onError`.

`LuvStream` exposes:
- `[Symbol.asyncIterator]` — yields `Event` values (`start | text | stop`)
- `text()` — yields just text deltas as `AsyncIterable<string>`
- `done` — `Promise<Reply>` for the assembled final reply
- `cancel()` — abort the underlying fetch
- `aborted` — `boolean`

## runAgent

```ts
function runAgent(opts: AgentOptions): Promise<AgentResult>;
```

Multi-turn agent loop with tool execution. See [Agents and tools](/guide/agents/).

### `AgentOptions`

`provider`, `model`, `conversation`, optional `tools`, `maxIterations`
(default 10), `maxTokens`, `temperature`, `signal`, lifecycle hooks
(`onTurnStart`, `onToolCall`, `onToolResult`, `onFinish`).

### `AgentResult`

```ts
{
  conversation: Message[],     // includes every assistant + tool message added
  reason: AgentFinishReason,   // "end_turn" | "max_iterations" | "aborted" | "error"
  iterations: number,
  error?: Error,               // set when reason === "error"
}
```

## agentStep

```ts
function agentStep(opts: AgentStepOptions): Promise<AgentStepResult>;
```

A single iteration of the loop. Use to drive the agent yourself — pause,
resume, approve, modify between turns.

```ts
{
  newMessages: Message[],         // messages this step added
  done: boolean,                  // true if no more turns needed
  reason: AgentStepReason,        // "continue" | "end_turn" | "aborted" | "error"
  error?: Error,
}
```

Same lifecycle hooks as `runAgent`.

## Message types

```ts
type Message =
  | { role: "system";    text: string }
  | { role: "user";      text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool";      callId: string; result: ToolResult };

type ToolCall = { id: string; name: string; arguments: unknown };

type ToolResult =
  | { ok: true;  content: string }
  | { ok: false; error: string };
```
