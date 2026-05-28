# anthropic_messages morphism

This morphism specifies the transformation between luv canonical types
and the Anthropic Messages API (`POST /v1/messages`).

The core spec is `spec/SPEC.md`. This morphism does not redefine
principles, canonical types, laws, or glossary terms; it references
them by name.

## Objects

luv side (defined in core spec, Section 2):
- `Conversation`
- `Reply`
- `Stream<Reply>` (Section 2.6)

Anthropic side (defined below in field-mapping tables):
- `Anthropic.Request` — JSON body of the request
- `Anthropic.Response` — JSON body of the non-streaming response
- `Anthropic.Stream` — finite sequence of typed SSE event objects

## Arrows

This morphism declares three arrows:

- `luv_conversation_to_anthropic_request : Conversation → Anthropic.Request`
- `anthropic_response_to_luv_reply : Anthropic.Response → Reply`
- `anthropic_stream_to_luv_stream : Anthropic.Stream → Stream<Reply>`

Each arrow's field mappings, enum mappings, and exceptions are
specified below.

## Endpoint, auth, transport

- URL: `https://api.anthropic.com/v1/messages`
- Method: `POST`
- Required headers:
  - `x-api-key: ${ANTHROPIC_API_KEY}` (note: NOT `Authorization: Bearer …`)
  - `anthropic-version: 2023-06-01`
  - `content-type: application/json`
- For streaming, the request body must include `"stream": true`. The
  response is `text/event-stream` with typed events
  (`message_start`, `content_block_start`, `content_block_delta`,
  `content_block_stop`, `message_delta`, `message_stop`).

These are transport concerns and not part of any arrow's domain or
codomain (per P8). Implementations layer transport over the canonical
arrows.

## Anthropic side wire types

### Anthropic.Request

A JSON object with the following fields (only those used by this
morphism are described):

| Field | Type | Required | Source |
|---|---|---|---|
| `model` | string | yes | per-call parameter |
| `max_tokens` | number | **yes** | per-call parameter; Anthropic requires it (unlike OpenAI) |
| `messages` | array of `Anthropic.Message` | yes | derived from luv `Conversation` (non-system nodes) |
| `system` | string | no | derived from luv `Conversation` system-role messages (concatenated) |
| `stream` | boolean | no | per-call parameter |
| `tools` | array | no | per-call parameter; tool definitions are not canonical luv state |
| `tool_choice` | object | no | per-call parameter |
| `temperature` | number | no | per-call parameter |
| `stop_sequences` | array of strings | no | per-call parameter |

Canonical key order in this morphism's output: `model`, `max_tokens`,
`messages`, `system` (if present), `stream` (if present), `tools` (if
present), `tool_choice` (if present), `temperature` (if present),
`stop_sequences` (if present). `model`, `max_tokens`, and `messages`
are always emitted; the others are emitted only if the caller provides
them.

### Anthropic.Message

```
Anthropic.Message :=
  | { role: "user",      content: string | [Anthropic.ContentBlock, ...] }
  | { role: "assistant", content: string | [Anthropic.ContentBlock, ...] }
```

Anthropic does not have a `tool` or `system` role in `messages`. System
content is in the top-level `system` field. Tool results are content
blocks inside user messages.

Anthropic requires that messages alternate user/assistant (consecutive
same-role messages are rejected). The morphism merges consecutive
same-role luv messages by concatenating their content blocks before
emission. Field-mapping table specifies this.

### Anthropic.ContentBlock

```
Anthropic.ContentBlock :=
  | { type: "text",        text: string }
  | { type: "tool_use",    id: string, name: string, input: object }
  | { type: "tool_result", tool_use_id: string, content: string }
```

Note: Anthropic's `tool_use.input` is a JSON object (structured value),
not a string. The luv `tool_call.args` field is canonical-JSON-as-string;
the morphism parses the string to an object when sending to Anthropic,
and stringifies the object when receiving from Anthropic.

### Anthropic.Response

```
Anthropic.Response := {
  id: string,
  type: "message",
  role: "assistant",
  content: [Anthropic.ContentBlock, ...],
  model: string,
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null,
  stop_sequence: string | null,
  usage: { input_tokens: number, output_tokens: number }
}
```

`content` blocks are `text` or `tool_use` (never `tool_result` in
responses).

### Anthropic.Stream

A finite, ordered sequence of typed SSE event objects parsed from the
streaming response. Each event has a `type` field that determines its
shape:

```
Anthropic.StreamEvent :=
  | { type: "message_start", message: { id, role, content, model, ... } }
  | { type: "content_block_start", index: number, content_block: Anthropic.ContentBlock }
  | { type: "content_block_delta", index: number, delta: Anthropic.Delta }
  | { type: "content_block_stop", index: number }
  | { type: "message_delta", delta: { stop_reason, stop_sequence }, usage: {...} }
  | { type: "message_stop" }
  | { type: "ping" }

Anthropic.Delta :=
  | { type: "text_delta", text: string }
  | { type: "input_json_delta", partial_json: string }
```

`ping` events are heartbeats and ignored by the morphism.

The canonical encoding of an `Anthropic.Stream` value for bench
purposes is a JSON array of the event objects in order.

## Field mappings

### Arrow: `luv_conversation_to_anthropic_request`

Builds the `messages` array and the optional `system` field from a luv
`Conversation`. The Conversation is walked along a single branch (the
caller designates the head node; this morphism walks `head` to root
and reverses).

luv `Message` → Anthropic emission:

| luv message shape | Effect |
|---|---|
| `role: "system"`, text content | Contributes its concatenated text to the top-level `system` field. Stripped from the `messages` array. |
| `role: "user"`, content blocks | Emits an Anthropic `user` message. See content-form rule below. |
| `role: "assistant"`, content blocks | Emits an Anthropic `assistant` message. See content-form rule below. |

**Content form rule.** An emitted Anthropic message's `content` field
is either:

- **A string**, if every luv block in the message is a `text` block.
  The string is the concatenation of all `text` block texts in order.
  This is the cleaner wire form for typical text-only conversation
  turns.
- **A block array**, if any non-text block is present (`tool_call` on
  assistant, `tool_result` on user). Each luv block becomes the
  corresponding Anthropic content block: `text` → text, `tool_call`
  → tool_use (parsing `args` from string to object), `tool_result`
  → tool_result.

After the per-node walk, consecutive same-role messages are merged by
concatenating their content (string concat if both are strings; block
concatenation if either is an array, promoting strings to single text
blocks as needed). The resulting `messages` array alternates
user/assistant.

luv `system` blocks → Anthropic `system` field:

If the conversation contains multiple system-role messages, their
text contents are concatenated with `"\n\n"` separators in
conversation order. If zero system messages exist, the `system` field
is omitted from the request.

luv `tool_call` Block → Anthropic `tool_use` block:

| luv field | Anthropic field |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `args` (canonical-JSON string) | `input` (parsed JSON object) |

luv `tool_result` Block → Anthropic `tool_result` block:

| luv field | Anthropic field |
|---|---|
| `call_id` | `tool_use_id` |
| `text` | `content` |

### Arrow: `anthropic_response_to_luv_reply`

Reads `content` and `stop_reason` from the response.

| Anthropic source | luv target |
|---|---|
| Each `content[i]` with `type: "text"` | One luv `text` block with the same text |
| Each `content[i]` with `type: "tool_use"` | One luv `tool_call` block with `id`, `name`, and `args` set to canonical-JSON stringification of `input` |
| `stop_reason` | luv `Reply.finish_reason` (see enum mapping) |

The resulting Reply has `message.role: "assistant"` and content blocks
in the same order as the Anthropic response.

### Arrow: `anthropic_stream_to_luv_stream`

Walks Anthropic stream events in order, emitting luv StreamEvents.
State: tracks the open block kind to associate deltas correctly. The
stop_reason arrives in a `message_delta` event before `message_stop`;
the morphism stores it and emits `message_end` with the mapped
FinishReason when `message_stop` arrives.

| Anthropic event | luv event(s) emitted |
|---|---|
| `message_start` | one `message_start` |
| `content_block_start` with `text` content_block | one `block_start` with `{kind: "text", text: ""}` |
| `content_block_start` with `tool_use` content_block | one `block_start` with `{kind: "tool_call", id, name, args: ""}` |
| `content_block_delta` with `text_delta` | one `text_delta` with the delta text |
| `content_block_delta` with `input_json_delta` | one `args_delta` with the partial_json |
| `content_block_stop` | one `block_end` |
| `message_delta` | none (stop_reason stored for `message_stop`) |
| `message_stop` | one `message_end` with the mapped FinishReason from the stored stop_reason |
| `ping` | none |

## Enum mappings

### Role (luv → Anthropic)

| luv `Role` | Anthropic emission |
|---|---|
| `system` | not a message role; concatenated into top-level `system` field |
| `user` | `user` |
| `assistant` | `assistant` |

### Role (Anthropic → luv)

Responses contain only `assistant` messages. Streaming `message_start`
events have `role: "assistant"`. No reverse role mapping is needed for
this morphism's response and stream arrows.

### FinishReason

Anthropic → luv:

| Anthropic `stop_reason` | luv `FinishReason` |
|---|---|
| `end_turn` | `end_turn` |
| `max_tokens` | `max_tokens` |
| `stop_sequence` | `end_turn` (see exceptions: the matched stop sequence is dropped) |
| `tool_use` | `end_turn` (see exceptions: luv v1 has no dedicated `tool_use` finish reason) |
| `null` (mid-stream) | `end_turn` (placeholder; should not occur in well-formed responses) |

## `homomorphism_exceptions`

Cases in which the morphism is not strictly homomorphic — distinct
canonical inputs may collapse to the same Anthropic value, or distinct
Anthropic values may collapse to the same canonical output.

### `luv_conversation_to_anthropic_request`

| Exception | Effect |
|---|---|
| Multiple system-role messages | Concatenated with `"\n\n"` into a single top-level `system` string; individual message boundaries are lost. |
| Multiple consecutive same-role non-system messages | Merged into a single Anthropic message whose `content` is the concatenated content blocks; original message boundaries are lost. |
| Empty text blocks in a message | Contribute the empty string; indistinguishable from absent in concatenation. |
| Multiple text blocks within a single luv message | Concatenated into a single string when the message has no non-text blocks; block boundaries are lost. Distinguishable only when interleaved with non-text blocks (then the block array form is used and boundaries are preserved). |
| Forking conversations | Only the branch from the caller-designated head is encoded; sibling branches are not represented. |
| Node `id` and `parent_id` | Not carried into the Anthropic request; they exist only at the luv side. |
| `spec_version` | Not carried into the Anthropic request; it is metadata about luv version. |
| `error` blocks in conversation history | Anthropic has no canonical representation for in-conversation errors; `error` blocks are dropped when encoding history. Apps that want to surface prior errors to the model must convert them to `text` blocks themselves. |
| Assistant or user message whose content blocks are all dropped (e.g., only `error` blocks) | Emitted as `{role, content: ""}` rather than `{role, content: []}`. Anthropic rejects empty content arrays; the empty string is the safe equivalent. No information is conveyed in this case. |
| Tool args canonical JSON whitespace/ordering | `args` is JSON-parsed to an object before sending; the original canonical-JSON byte sequence is lost (only the structured value survives). The morphism re-stringifies on receive in insertion order. |

### `anthropic_response_to_luv_reply`

| Exception | Effect |
|---|---|
| `id`, `model`, `usage`, `stop_sequence` fields | Not represented in luv `Reply`. |
| `stop_reason: "stop_sequence"` | Maps to luv `end_turn`; the actual matched sequence is dropped. |
| `stop_reason: "tool_use"` vs `"end_turn"` | Both map to luv `end_turn` (luv v1 has no `tool_use` finish reason); the distinction is lost. |
| Tool use `input` key ordering | Re-stringified to canonical JSON using insertion order; bit-identical only for inputs the morphism has not seen its provider re-order. |
| Empty content array in response | luv requires `Message.content` non-empty; an empty Anthropic response is malformed for luv and produces a luv-level validation error if validated. |

### `anthropic_stream_to_luv_stream`

| Exception | Effect |
|---|---|
| Same as `anthropic_response_to_luv_reply` for finish_reason and content shape | — |
| `ping` events | Discarded silently. |
| `usage` field in `message_delta` | Not represented in the luv stream. |
| Incremental `usage` updates across deltas | Anthropic reports running usage in `message_delta` events; luv stream events do not carry usage. |

## `laws_satisfied`

| Law | Status | Notes |
|---|---|---|
| L1 (wire determinism) | satisfied | Per Section 3 canonical encoding |
| L2 (bench compliance) | satisfied | See conformance cases under `cases/` |
| L3 (homomorphism exceptions exhaustive) | satisfied | Tables above |
| L4 (stream coherence) | satisfied | `consume_luv_stream_reply ∘ anthropic_stream_to_luv_stream` agrees with `anthropic_response_to_luv_reply ∘ consume_anthropic_stream` on the in-spec subset |

## Conformance cases

Per-arrow case directories under `cases/`. Each case has `input.json`
and `expected.json`; provider→luv cases also have `record.json` that
the recorder script uses to refresh `input.json` against the live API.
See `spec/morphisms/openai_chat/openai_chat.md` for the same pattern.
