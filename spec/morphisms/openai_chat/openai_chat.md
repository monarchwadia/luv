# openai_chat morphism

This morphism specifies the transformation between luv canonical types
and the OpenAI Chat Completions API (`POST /v1/chat/completions`).

It applies to OpenAI's Chat Completions endpoint and any OpenAI-compatible
service that mirrors the same wire format (Mistral, Together, Groq,
OpenRouter, Anyscale, vLLM, Azure OpenAI, etc.). The newer OpenAI
Responses API is *not* covered; a separate morphism would be needed.

The core spec is `spec/SPEC.md`. This morphism does not redefine
principles, canonical types, laws, or glossary terms; it references them
by name.

## Objects

luv side (defined in core spec, Section 2):
- `Conversation`
- `Reply`
- `Stream<Reply>` (Section 2.6)

OpenAI side (defined below in field-mapping tables):
- `OpenAI.Request` — JSON body of the request
- `OpenAI.Response` — JSON body of the non-streaming response
- `OpenAI.Stream` — finite sequence of SSE chunk objects, one per
  `data:` line excluding the terminator `data: [DONE]`

## Arrows

This morphism declares three arrows:

- `luv_conversation_to_openai_request : Conversation → OpenAI.Request`
- `openai_response_to_luv_reply : OpenAI.Response → Reply`
- `openai_stream_to_luv_stream : OpenAI.Stream → Stream<Reply>`

Each arrow's field mappings, enum mappings, and exceptions are
specified below.

## Endpoint, auth, transport

- URL: `https://api.openai.com/v1/chat/completions`
- Method: `POST`
- Required headers:
  - `Authorization: Bearer ${OPENAI_API_KEY}`
  - `Content-Type: application/json`
- For streaming, the request body must include `"stream": true`. The
  response is `text/event-stream` with one event per chunk:
  `data: <json>\n\n`, terminated by `data: [DONE]\n\n`.

These are transport concerns and not part of any arrow's domain or
codomain (per P8). Implementations layer transport over the canonical
arrows.

## OpenAI side wire types

### OpenAI.Request

A JSON object with the following fields (only those used by this
morphism are described; unused fields may exist and are not emitted by
the `luv_conversation_to_openai_request` arrow):

| Field | Type | Required | Source |
|---|---|---|---|
| `model` | string | yes | per-call parameter, not from canonical Conversation |
| `messages` | array of `OpenAI.Message` | yes | derived from luv `Conversation` |
| `stream` | boolean | no | per-call parameter (false for the value-level arrow) |
| `tools` | array | no | per-call parameter; tool definitions are not canonical luv state |

The `model`, `stream`, and `tools` fields are supplied by the caller of
the morphism, not by the canonical `Conversation`. The arrow defines
the `messages` field; the other fields are passed through.

### OpenAI.Message

A JSON object whose shape depends on its `role`:

```
OpenAI.Message :=
  | { role: "system",    content: string }
  | { role: "user",      content: string }
  | { role: "assistant", content: string | null, tool_calls: [OpenAI.ToolCall, ...]? }
  | { role: "tool",      tool_call_id: string, content: string }
```

`OpenAI.ToolCall`:
```
OpenAI.ToolCall := {
  id: string,
  type: "function",
  function: { name: string, arguments: string }
}
```

The `function.arguments` value is a JSON document encoded as a string
(OpenAI's convention).

### OpenAI.Response

```
OpenAI.Response := {
  id: string,
  object: "chat.completion",
  created: number,
  model: string,
  choices: [OpenAI.Choice, ...],
  usage: { prompt_tokens, completion_tokens, total_tokens },
  system_fingerprint: string?
}

OpenAI.Choice := {
  index: number,
  message: OpenAI.Message,
  logprobs: any | null,
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | "function_call"
}
```

The morphism reads `choices[0]` exclusively. Multiple choices (`n > 1`)
are out of scope (see `homomorphism_exceptions`).

### OpenAI.Stream

A finite, ordered sequence of chunk objects, each parsed from one
`data:` line of the SSE response (excluding the terminator).

```
OpenAI.StreamChunk := {
  id: string,
  object: "chat.completion.chunk",
  created: number,
  model: string,
  choices: [OpenAI.StreamChoice, ...],
  ...
}

OpenAI.StreamChoice := {
  index: number,
  delta: { role?: string, content?: string, tool_calls?: [OpenAI.StreamToolCallDelta] },
  finish_reason: string | null
}
```

The canonical encoding of an `OpenAI.Stream` value for bench purposes
is a JSON array of the chunk objects in order. (The wire form is SSE;
the canonical form for testing is the array of parsed JSON chunks.)

## Field mappings

### Arrow: `luv_conversation_to_openai_request`

Builds the `messages` array of the OpenAI request from a luv
`Conversation`. The Conversation is walked along a single branch (the
caller designates the head node; this morphism walks `head` to root and
reverses).

luv `Message` → OpenAI message(s):

| luv message shape | OpenAI message(s) emitted |
|---|---|
| `role: "system"`, content is one or more text blocks | one OpenAI `system` message; `content` is the concatenation of all text-block `text` fields, in order |
| `role: "user"`, content is only text blocks | one OpenAI `user` message; `content` is the concatenation of text-block `text` fields |
| `role: "user"`, content is only tool_result blocks | one OpenAI `tool` message per tool_result block, in order; each carries `tool_call_id: <block.call_id>` and `content: <block.text>` |
| `role: "user"`, content mixes text and tool_result | OpenAI messages emitted in block order: each text block becomes one `user` message; each tool_result block becomes one `tool` message |
| `role: "assistant"`, content has only text blocks | one OpenAI `assistant` message; `content` is the concatenation of text-block `text` fields |
| `role: "assistant"`, content has only tool_call blocks | one OpenAI `assistant` message with `content: null` and `tool_calls: [...]` |
| `role: "assistant"`, content has both | one OpenAI `assistant` message; `content` is concatenated text; `tool_calls` is the list of tool_call blocks |

luv `tool_call` Block → OpenAI `ToolCall`:

| luv field | OpenAI field |
|---|---|
| `id` | `id` |
| `name` | `function.name` |
| `args` | `function.arguments` (passed through as a string) |

Constant: `type` is always `"function"`.

### Arrow: `openai_response_to_luv_reply`

Reads `choices[0]` and produces a luv `Reply`.

| OpenAI source | luv target |
|---|---|
| `choices[0].message.content` (string) | one `text` block with that string as `text` |
| `choices[0].message.content == null` | no text block |
| `choices[0].message.tool_calls[i]` | one `tool_call` block per entry, with `id`, `name = function.name`, `args = function.arguments` |
| `choices[0].finish_reason` | luv `Reply.finish_reason` (see enum mapping) |

The resulting Reply has `message.role: "assistant"`. `message.content`
is the ordered list of blocks: text first (if any), then tool_call
blocks in order.

### Arrow: `openai_stream_to_luv_stream`

Reads the sequence of `OpenAI.StreamChunk` values and emits luv
`StreamEvent<Reply>` events.

Per-chunk behavior, walking chunks in order with stateful tracking of
the currently-open block:

| OpenAI delta | luv event(s) emitted |
|---|---|
| First chunk (`delta.role: "assistant"`, no content/tool_calls yet) | `message_start` |
| `delta.content` is a non-empty string and no block is currently open | `block_start` with `block: {kind: "text", text: ""}`, then `text_delta` with the content |
| `delta.content` while a text block is open | `text_delta` with the content |
| `delta.tool_calls[i]` first appearance of index `i` | if a text block is open: `block_end`. Then `block_start` with `block: {kind: "tool_call", id: <id>, name: <function.name>, args: ""}`, then `args_delta` with `<function.arguments>` (if non-empty) |
| `delta.tool_calls[i]` subsequent appearance | `args_delta` with `<function.arguments>` (incremental JSON fragment) |
| Final chunk (`finish_reason` is non-null, `delta` is empty) | if any block is open: `block_end`. Then `message_end` with `finish_reason` per the enum mapping |

## Enum mappings

### Role (luv → OpenAI)

| luv `Role` | OpenAI `role` |
|---|---|
| `system` | `system` |
| `user` (text-only message) | `user` |
| `user` (tool_result-only message) | `tool` (per tool_result block) |
| `assistant` | `assistant` |

### Role (OpenAI → luv)

| OpenAI `role` | luv `Role` |
|---|---|
| `system` | `system` |
| `user` | `user` |
| `assistant` | `assistant` |
| `tool` | `user` (the tool message becomes a tool_result block inside a user message; see below) |
| `developer` | not produced or consumed; see exceptions |

When `openai_response_to_luv_reply` constructs a Reply, the response is
always an assistant message; OpenAI does not return system/user/tool
roles in this position.

### FinishReason

luv → OpenAI: not used in any arrow declared by this morphism (luv
Conversation does not carry finish_reason; only Reply does, and the
reply direction is OpenAI → luv).

OpenAI → luv (`openai_response_to_luv_reply` and
`openai_stream_to_luv_stream`):

| OpenAI `finish_reason` | luv `FinishReason` |
|---|---|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `content_filter` | `content_filter` |
| `tool_calls` | `end_turn` (see exceptions: luv v1 has no dedicated `tool_use` finish reason) |
| `function_call` | `end_turn` (deprecated OpenAI value; treated like `tool_calls`) |

## `homomorphism_exceptions`

Cases in which the morphism is not strictly homomorphic — distinct
canonical inputs may collapse to the same OpenAI value, or distinct
OpenAI values may collapse to the same canonical output. Per Law L3,
this list is exhaustive.

### `luv_conversation_to_openai_request`

| Exception | Effect |
|---|---|
| Multiple consecutive text blocks within a single luv message | Concatenated into a single `content` string in the resulting OpenAI message; the block boundaries are lost. |
| Empty text blocks in a message | Contribute the empty string to `content`; indistinguishable from absent. |
| Forking conversations | Only the branch from the caller-designated head is encoded; sibling branches in the canonical Conversation are not represented in the OpenAI request. |
| Node `id` and `parent_id` | Not carried into the OpenAI request; they exist only at the luv side. |
| `spec_version` | Not carried into the OpenAI request; it is metadata about which luv version the canonical value conforms to. |
| `error` blocks in conversation history | OpenAI has no canonical representation for in-conversation errors; `error` blocks are dropped when encoding history into `messages`. Apps that want to surface prior errors to the model must convert them to `text` blocks themselves before sending. |
| Assistant message whose content blocks are all dropped (e.g., only `error` blocks) and which has no `tool_call` blocks | Emitted as `{role: "assistant", content: ""}` rather than `content: null`. OpenAI rejects `content: null` unless `tool_calls` is present; the empty string is the safe equivalent. No information is conveyed in this case. |

### `openai_response_to_luv_reply`

| Exception | Effect |
|---|---|
| `choices[i]` for `i > 0` (n > 1) | Out of scope. The morphism reads only `choices[0]`; additional choices are dropped. |
| `refusal` field on assistant message | Currently surfaced as plain `text` content of the message (lossy: the "refusal" semantic is flattened to text). |
| `usage`, `system_fingerprint`, `created`, `model`, `id` | Not represented in luv `Reply`. |
| `logprobs` | Not represented. |
| `finish_reason: "tool_calls"` vs `"stop"` | Both map to `end_turn` in luv v1 (luv has no dedicated `tool_use` finish reason). |
| `developer` role in messages (o1+ models) | Not represented; would arrive only in request-side context, which luv does not currently emit. |

### `openai_stream_to_luv_stream`

| Exception | Effect |
|---|---|
| Same as `openai_response_to_luv_reply` for finish_reason and per-choice projection | — |
| `usage` chunks (when `stream_options.include_usage: true`) | Not represented in the luv stream. |
| Empty `delta.content` strings | May still emit a zero-byte `text_delta`; downstream consumers should treat these as no-ops. |

## `laws_satisfied`

| Law | Status | Notes |
|---|---|---|
| L1 (wire determinism) | satisfied | Per Section 3 canonical encoding |
| L2 (bench compliance) | satisfied | See conformance cases below |
| L3 (homomorphism exceptions exhaustive) | satisfied | Tables above |
| L4 (stream coherence) | satisfied | `consume_luv_stream_reply ∘ openai_stream_to_luv_stream` agrees with `openai_response_to_luv_reply ∘ consume_openai_stream` on the in-spec subset; see streaming cases |

## Conformance cases

Per-arrow case directories at:

```
cases/
  luv_conversation_to_openai_request/
    001_single_user_message/
    002_system_plus_user/
    003_assistant_with_tool_call/
  openai_response_to_luv_reply/
    001_simple_text/
    002_with_tool_call/
  openai_stream_to_luv_stream/
    001_simple_text_stream/
    002_with_tool_call_stream/
```

Each case directory contains `input.json` and `expected.json`. For
`luv_conversation_to_openai_request` cases, `expected.json` has been
verified by sending it to the OpenAI Chat Completions endpoint and
observing a `200 OK` (the response itself is not part of the bench;
only the request-shape acceptance is).

For `openai_response_to_luv_reply` and `openai_stream_to_luv_stream`
cases, `input.json` is a captured real API response, recorded against
`gpt-4o-mini`.
