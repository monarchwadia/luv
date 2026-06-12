# bedrock_converse morphism

This morphism specifies the transformation between luv canonical types
and the AWS Bedrock Converse API (`POST /model/{modelId}/converse`).

The Converse API is model-agnostic — one wire format covers all chat
models on Bedrock (Anthropic Claude, Meta Llama, Mistral, Amazon Nova,
DeepSeek, Qwen, Cohere, etc.). This morphism targets that unified
interface.

The core spec is `spec/SPEC.md`. This morphism does not redefine
principles, canonical types, laws, or glossary terms; it references
them by name.

## Objects

luv side (defined in core spec, Section 2):
- `Conversation`
- `Reply`
- `Stream<Reply>` (Section 2.6)

Bedrock side (defined below in field-mapping tables):
- `Bedrock.Request` — JSON body of the request
- `Bedrock.Response` — JSON body of the non-streaming response
- `Bedrock.Stream` — finite sequence of typed event objects

## Arrows

This morphism declares three arrows:

- `luv_conversation_to_bedrock_request : (Conversation, Opts) → Bedrock.Request`
- `bedrock_response_to_luv_reply : (Bedrock.Response, model_id) → Reply`
- `bedrock_stream_to_luv_stream : (Bedrock.Stream, model_id) → Stream<Reply>`

The `model_id` parameter is required for the response and stream
arrows because Bedrock does not echo the model identifier in the
response body (it appears only in the request URL path). This differs
from OpenAI and Anthropic where the model is present in the response.

Each arrow's field mappings, enum mappings, and exceptions are
specified below.

## Endpoint, auth, transport

- URL: `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse`
- Streaming URL: `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse-stream`
- Method: `POST`
- Auth: AWS Signature Version 4 (service name `bedrock`)
- Streaming response format: `application/vnd.amazon.eventstream`
  (binary event-stream framing, not SSE)

These are transport concerns and not part of any arrow's domain or
codomain (per P8). The morphism arrows are pure data transforms over
JSON values.

## Bedrock side wire types

### Bedrock.Request

A JSON object. Only fields used by this morphism are described:

| Field | Type | Required | Source |
|---|---|---|---|
| `messages` | array of `Bedrock.Message` | yes | derived from luv `Conversation` (non-system nodes) |
| `system` | array of `Bedrock.SystemBlock` | no | derived from luv `Conversation` system-role messages |
| `inferenceConfig` | `Bedrock.InferenceConfig` | no | per-call parameters |
| `toolConfig` | object | no | per-call parameter; tool definitions |

Canonical key order in this morphism's output: `messages`, `system`
(if present), `inferenceConfig` (if present), `toolConfig` (if
present).

### Bedrock.InferenceConfig

```
Bedrock.InferenceConfig := {
  maxTokens?: number,
  temperature?: number,
  topP?: number,
  stopSequences?: [string, ...]
}
```

Emitted only if at least one field is provided by the caller.
Canonical key order: `maxTokens`, `temperature`, `topP`,
`stopSequences`.

### Bedrock.SystemBlock

```
Bedrock.SystemBlock := { text: string }
```

The `system` field is an array of these blocks.

### Bedrock.Message

```
Bedrock.Message := {
  role: "user" | "assistant",
  content: [Bedrock.ContentBlock, ...]
}
```

Canonical key order: `role`, `content`.

### Bedrock.ContentBlock

A union type (only one key present per object):

```
Bedrock.ContentBlock :=
  | { text: string }
  | { toolUse: { toolUseId: string, name: string, input: JSON } }
  | { toolResult: { toolUseId: string, content: [Bedrock.ToolResultContentBlock, ...] } }
```

Bedrock also supports `image`, `document`, `video`, `audio`,
`guardContent`, `cachePoint`, `reasoningContent`, `searchResult`, and
`citationsContent` blocks; these are out of scope for this morphism
(luv does not yet have canonical block types for them).

### Bedrock.ToolResultContentBlock

A union type (only one key present per object):

```
Bedrock.ToolResultContentBlock :=
  | { text: string }
  | { json: JSON }
```

This morphism uses only the `text` variant. The `json`, `image`,
`document`, and `video` variants are out of scope.

### Bedrock.Response

```
Bedrock.Response := {
  output: {
    message: {
      role: "assistant",
      content: [Bedrock.ContentBlock, ...]
    }
  },
  stopReason: string,
  usage: Bedrock.Usage,
  metrics?: { latencyMs: number }
}
```

### Bedrock.Usage

```
Bedrock.Usage := {
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  cacheReadInputTokens?: number,
  cacheWriteInputTokens?: number,
  cacheDetails?: [{ inputTokens: number, ttl: string }, ...]
}
```

All fields are preserved verbatim in `raw` (nothing dropped or
normalized, per SPEC §2.5).

### Bedrock.Stream

A finite, ordered sequence of typed event objects. Each event is a
JSON object with exactly one top-level key indicating the event type:

```
Bedrock.StreamEvent :=
  | { messageStart: { role: "assistant" } }
  | { contentBlockStart: { contentBlockIndex: number, start: Bedrock.ContentBlockStart } }
  | { contentBlockDelta: { contentBlockIndex: number, delta: Bedrock.ContentBlockDeltaBody } }
  | { contentBlockStop: { contentBlockIndex: number } }
  | { messageStop: { stopReason: string } }
  | { metadata: { usage: Bedrock.Usage, metrics?: { latencyMs: number } } }
```

### Bedrock.ContentBlockStart

A union (one key present):

```
Bedrock.ContentBlockStart :=
  | { toolUse: { toolUseId: string, name: string } }
```

Per AWS documentation, `contentBlockStart` events are emitted **only
for tool-use blocks**. Text content blocks have no `contentBlockStart`
event — they begin implicitly with the first `contentBlockDelta`
carrying a `text` delta for that `contentBlockIndex`.

### Bedrock.ContentBlockDeltaBody

A union (one key present):

```
Bedrock.ContentBlockDeltaBody :=
  | { text: string }
  | { toolUse: { input: string } }
```

The `toolUse.input` delta is a string fragment of the JSON input being
streamed incrementally (analogous to Anthropic's `input_json_delta`).

The canonical encoding of a `Bedrock.Stream` value for bench purposes
is a JSON array of the event objects in order.

## Opts

The caller-provided options for `luv_conversation_to_bedrock_request`:

```
BedrockRequestOptions := {
  model_id: string,
  max_tokens?: number,
  temperature?: number,
  top_p?: number,
  stop_sequences?: [string, ...],
  tools?: unknown[],
  tool_choice?: unknown
}
```

`model_id` does not appear in the emitted request body (it is used
only for the URL path and for the usage envelope in response/stream
arrows). The remaining fields map to `inferenceConfig` and
`toolConfig`.

## Field mappings

### Arrow: `luv_conversation_to_bedrock_request`

Builds the `messages` array and the optional `system` array from a
luv `Conversation`. The Conversation is walked linearly in array order.

luv `Message` → Bedrock emission:

| luv message shape | Effect |
|---|---|
| `role: "system"`, content blocks | Each text block contributes one `{text: "..."}` entry to the top-level `system` array. Stripped from `messages`. |
| `role: "user"`, content blocks | Emits a Bedrock `user` message. |
| `role: "assistant"`, content blocks | Emits a Bedrock `assistant` message. |

**Content block mapping (luv → Bedrock):**

| luv Block | Bedrock ContentBlock |
|---|---|
| `{kind: "text", text}` | `{text}` |
| `{kind: "tool_call", id, name, args}` | `{toolUse: {toolUseId: id, name, input: JSON.parse(args)}}` |
| `{kind: "tool_result", call_id, text}` | `{toolResult: {toolUseId: call_id, content: [{text}]}}` |
| `{kind: "error", ...}` | dropped (see homomorphism_exceptions) |

**Merging consecutive same-role messages.** Bedrock requires messages
to alternate user/assistant (many underlying models enforce this via
the Converse API's model-specific prompt templates). Consecutive
same-role luv messages are merged by concatenating their content block
arrays. The resulting `messages` array alternates user/assistant.

**System array.** Each luv system-role message contributes its text
blocks as individual `{text: "..."}` entries in the `system` array
(preserving per-message granularity, unlike Anthropic which
concatenates into one string). If zero system messages exist, the
`system` field is omitted.

**InferenceConfig.** Emitted only if at least one of `max_tokens`,
`temperature`, `top_p`, or `stop_sequences` is provided in opts.
Fields within are emitted only if provided (no defaults injected by
the morphism).

**ToolConfig.** Emitted only if `tools` is provided in opts. Shape:
`{tools, toolChoice}` (`toolChoice` only if provided). The `tools`
array and `toolChoice` object are passed through verbatim from opts —
the morphism does not transform their internal structure.

### Arrow: `bedrock_response_to_luv_reply`

Reads `output.message.content` and `stopReason` from the response.

| Bedrock source | luv target |
|---|---|
| Each content block with `text` key | One luv `text` block |
| Each content block with `toolUse` key | One luv `tool_call` block: `id` = `toolUseId`, `name` = `name`, `args` = `JSON.stringify(input)` |
| `stopReason` | luv `Reply.finish_reason` (see enum mapping) |
| `usage` | luv `Reply.usage` = `{provider: "bedrock_converse", model: <model_id param>, raw: <usage object verbatim>}` |

The resulting Reply has `message.role: "assistant"` and content blocks
in the same order as the Bedrock response.

If `usage` is absent in the response, `Reply.usage` is `null`.

### Arrow: `bedrock_stream_to_luv_stream`

Walks Bedrock stream events in order, emitting luv StreamEvents.
State: tracks open block kind, stored stopReason, and usage.

| Bedrock event | luv event(s) emitted |
|---|---|
| `messageStart` | one `message_start` |
| `contentBlockStart` with `start.toolUse` | one `block_start` with `{kind: "tool_call", id: toolUseId, name, args: ""}` |
| `contentBlockDelta` with `delta.text` (first delta for a new `contentBlockIndex` with no preceding `contentBlockStart`) | one `block_start` with `{kind: "text", text: ""}`, then one `text_delta` |
| `contentBlockDelta` with `delta.text` (subsequent delta for same `contentBlockIndex`) | one `text_delta` with the text string |
| `contentBlockDelta` with `delta.toolUse` | one `args_delta` with the `input` string fragment |
| `contentBlockStop` | one `block_end` |
| `messageStop` | stores `stopReason`; does NOT emit (waits for `metadata`) |
| `metadata` | emits `message_end` with mapped finish_reason and `usage` = `{provider: "bedrock_converse", model: <model_id param>, raw: <usage>}` |

**Text block detection.** Because text content blocks have no
`contentBlockStart` event, the morphism must track which
`contentBlockIndex` values have been opened. When a
`contentBlockDelta` arrives for a `contentBlockIndex` that has not
yet been opened by a `contentBlockStart`, the morphism emits
`block_start` with `{kind: "text", text: ""}` before emitting the
`text_delta`.

**Graceful degradation.** If the event array ends without a `metadata`
event (e.g., connection closed after `messageStop`), emit
`message_end` with the stored `stopReason` mapped to `finish_reason`
and `usage: null`. The developer gets their completion; they just
don't get token counts.

## Enum mappings

### Role (luv → Bedrock)

| luv `Role` | Bedrock emission |
|---|---|
| `system` | not a message role; contributes to top-level `system` array |
| `user` | `"user"` |
| `assistant` | `"assistant"` |

### FinishReason (Bedrock → luv)

| Bedrock `stopReason` | luv `FinishReason` |
|---|---|
| `end_turn` | `end_turn` |
| `max_tokens` | `max_tokens` |
| `stop_sequence` | `end_turn` |
| `tool_use` | `end_turn` |
| `content_filtered` | `content_filter` |
| `guardrail_intervened` | `content_filter` |
| `model_context_window_exceeded` | `max_tokens` |
| `malformed_model_output` | `error` |
| `malformed_tool_use` | `error` |

## `homomorphism_exceptions`

### `luv_conversation_to_bedrock_request`

| Exception | Effect |
|---|---|
| Multiple system-role messages | Each becomes a separate `{text}` entry in the `system` array; block boundaries within a single system message are lost (multiple text blocks in one system message are concatenated per block). |
| Multiple consecutive same-role non-system messages | Merged into a single Bedrock message; original message boundaries are lost. |
| `error` blocks in conversation history | Dropped. Bedrock has no representation for in-conversation errors. |
| Assistant or user message whose content blocks are all dropped | Emitted as `{role, content: [{text: ""}]}`. Bedrock rejects empty content arrays. |
| Tool args canonical JSON whitespace/ordering | `args` is JSON-parsed to an object before sending; the original byte sequence is lost. Re-stringified on receive in insertion order. |
| Forking conversations | Only the linear array-order branch is encoded; sibling branches are not represented. |
| Node `id` and `parent_id` | Not carried into the Bedrock request. |
| `spec_version` | Not carried into the Bedrock request. |
| `model_id` | Not in the request body; used only for the URL path (transport concern). |

### `bedrock_response_to_luv_reply`

| Exception | Effect |
|---|---|
| `metrics` (latencyMs) | Not represented in luv Reply. |
| `stopReason: "stop_sequence"` | Maps to `end_turn`; the matched sequence is not preserved. |
| `stopReason: "tool_use"` vs `"end_turn"` | Both map to `end_turn`; the distinction is lost. |
| `stopReason: "guardrail_intervened"` vs `"content_filtered"` | Both map to `content_filter`; the distinction is lost. |
| `stopReason: "model_context_window_exceeded"` | Maps to `max_tokens`; the specific reason (context window vs generation limit) is lost. |
| Tool use `input` key ordering | Re-stringified to canonical JSON in insertion order. |
| Content blocks not supported by luv (image, document, video, audio, reasoningContent, citationsContent, searchResult) | Dropped silently. |
| Empty content array in response | luv requires non-empty content; produces a validation error if validated. |

### `bedrock_stream_to_luv_stream`

| Exception | Effect |
|---|---|
| Same content-block and stopReason exceptions as `bedrock_response_to_luv_reply` | — |
| `metadata.metrics` | Not surfaced as a luv event. |
| `messageStop` and `metadata` are separate events | Collapsed into one `message_end` event. If `metadata` is absent, `usage` is `null`. |

## `laws_satisfied`

| Law | Status | Notes |
|---|---|---|
| L1 (wire determinism) | satisfied | Per Section 3 canonical encoding |
| L2 (bench compliance) | satisfied | See conformance cases under `cases/` |
| L3 (homomorphism exceptions exhaustive) | satisfied | Tables above |
| L4 (stream coherence) | satisfied | `consume_luv_stream_reply ∘ bedrock_stream_to_luv_stream` agrees with `bedrock_response_to_luv_reply ∘ consume_bedrock_stream` on the in-spec subset |

## Conformance cases

Per-arrow case directories under `cases/`. Each case has `input.json`
and `expected.json`. Provider→luv cases also have `record.json` that
the recorder script uses to refresh `input.json` against the live API.

- `cases/luv_conversation_to_bedrock_request/<n>_<slug>/`
- `cases/bedrock_response_to_luv_reply/<n>_<slug>/`
- `cases/bedrock_stream_to_luv_stream/<n>_<slug>/`
