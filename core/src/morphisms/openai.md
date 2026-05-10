# OpenAI morphism — research notes

## API choice

OpenAI ships two chat-shaped APIs:

| API | Path | Status |
|---|---|---|
| **Chat Completions** | `POST /v1/chat/completions` | Stable; de facto industry standard. Mirrored by Mistral, Together, Groq, Anyscale, vLLM, OpenRouter, Azure OpenAI, etc. |
| Responses API | `POST /v1/responses` | Newer, OpenAI-pushed. Different shape (input/output items, server-managed conversations). |

**Picking Chat Completions** for this morphism. Rationale:
- Wider ecosystem fan-out: implementing this morphism unlocks ~10 OpenAI-compatible providers with near-zero adapter changes.
- Stable schema with years of fixture data available.
- Smaller mapping surface for a text-only slice.

A separate morphism (e.g. `openai_responses.zig`) can ship later if Responses-specific features matter. They'd not share the same Request/Response struct shape.

## Endpoint and auth

- URL: `https://api.openai.com/v1/chat/completions`
- Method: `POST`
- Required headers:
  - `Authorization: Bearer ${OPENAI_API_KEY}`
  - `Content-Type: application/json`
- Optional headers:
  - `OpenAI-Organization: org_…` (multi-org accounts)
  - `OpenAI-Project: proj_…` (project-scoped keys)

E2E env var: `OPENAI_API_KEY` (required), `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` (optional).

## Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | `[]Message` | yes | Conversation, ordered. |
| `model` | string | yes | e.g. `"gpt-4o"`, `"gpt-4o-mini"`, `"gpt-4-turbo"`, `"gpt-3.5-turbo"`, `"o1"`, `"o3"`. |
| `max_tokens` | int | no | Older. Caps response tokens. |
| `max_completion_tokens` | int | no | Replaces `max_tokens` for o1/o3+ models. **For older models the field is `max_tokens`; sending the wrong one is an `invalid_request_error`.** |
| `temperature` | number 0–2 | no | Default 1. |
| `top_p` | number 0–1 | no | |
| `n` | int | no | Default 1. We always send 1; n>1 is out of scope. |
| `stream` | bool | no | Default false. |
| `stream_options` | object | no | `{"include_usage": true}` — final chunk in stream carries token usage. |
| `stop` | string \| []string | no | Up to 4 stop sequences. |
| `seed` | int | no | Reproducibility hint, not a guarantee. |

Out-of-scope for the text-only morphism: `tools`, `tool_choice`, `response_format`, `parallel_tool_calls`, `logprobs`, `top_logprobs`, `audio`, `modalities`, `prediction`, `metadata`, `store`, `service_tier`, `user`.

## Message object

```jsonc
{
  "role": "system" | "user" | "assistant" | "tool" | "developer",
  "content": "<string>" | [<content_part>, ...],
  "name": "<optional string>"
}
```

Roles in the text-only slice: `system`, `user`, `assistant`. (`tool` is tool-use territory; `developer` is the o1+ replacement for `system` — see below.)

Content shapes:
- **String** (the text-only path) — what we'll always emit.
- **Array of content parts** — `{"type":"text","text":"..."}`, plus image/audio/file variants. Out of scope.

`name` is a per-message optional speaker-name field. Not a luv concept; we don't emit it.

Assistant messages may carry:
- `refusal: string` — set when the model refuses; `content` is then null. We surface this as message text with role=assistant in luv (lossy; flagged in loss table).
- `tool_calls` — out of scope.
- `audio` — out of scope.

### System prompt mechanism

System content is a regular message in the `messages` array, role `"system"`. **No top-level field.** This differs from Anthropic (which has top-level `system`). Multiple `system` messages are accepted; OpenAI concatenates them in practice. luv → OpenAI emits each `Role.system` message as one `system`-role array entry, in order.

### `developer` vs `system`

For o1+ models, `developer` is the preferred role; `system` still works on older models. We emit `system` by default; `developer` is selectable via `Options.system_role` when targeting o1/o3.

## Response (non-streaming)

```jsonc
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1717000000,
  "model": "gpt-4o-2024-08-06",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<string or null>",
        "refusal": "<string or null>"
      },
      "finish_reason": "stop" | "length" | "content_filter" | "tool_calls" | "function_call",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  },
  "system_fingerprint": "fp_…"
}
```

`finish_reason` vocabulary (exact strings):
- `"stop"` — natural stop or stop-sequence hit. Maps to luv `end_turn`.
- `"length"` — `max_(completion_)?tokens` reached. Maps to luv `max_tokens`.
- `"content_filter"` — safety policy. Maps to luv `content_filter`.
- `"tool_calls"` — out of scope; surface as luv `tool_use` for forward-compat or error.
- `"function_call"` — deprecated. Treat as `tool_calls`.

## Streaming format

Server-sent events. Each event is `data: <json>\n\n`. Terminator is the literal line `data: [DONE]\n\n`.

Chunk shape:
```jsonc
{
  "id": "chatcmpl-…",
  "object": "chat.completion.chunk",
  "created": 1717000000,
  "model": "gpt-4o-2024-08-06",
  "system_fingerprint": "fp_…",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",      // first chunk only
        "content": "<incremental string>",
        "refusal": "<string>"     // mutually exclusive with content
      },
      "logprobs": null,
      "finish_reason": null | "stop" | "length" | …
    }
  ]
}
```

Sequence per stream:
1. First chunk: `delta.role = "assistant"`, `delta.content = ""`.
2. N content chunks: `delta.content = "<piece>"`.
3. Final content chunk: `delta = {}`, `finish_reason = "stop"|…`.
4. (If `stream_options.include_usage = true`) one more chunk with `choices: []`, `usage: {...}`.
5. `data: [DONE]`.

## Error response

```jsonc
{
  "error": {
    "message": "<human-readable>",
    "type": "<machine type>",
    "param": "<field name or null>",
    "code": "<machine code or null>"
  }
}
```

Common `error.type`: `invalid_request_error`, `authentication_error`, `permission_error`, `rate_limit_error`, `server_error`, `tokens_exceeded_error`. HTTP status carries the broad category (4xx vs 5xx); the `error.type` is the machine-readable reason.

## Open design question (surface before Phase 4)

**`fromProvider` return type.** Today `luv.Message` is `{role, text}`. The OpenAI response carries `finish_reason` and `usage` that the orchestration layer needs (to decide whether to continue an agent loop, to track cost). Three options:

1. `fromProvider` returns `luv.Reply { message: Message, finish_reason: FinishReason, usage: ?Usage }` — adds a new luv type but stays pure-data.
2. `fromProvider` returns `luv.Message` and exposes a sibling `finishReasonOf(resp) FinishReason` — keeps the existing type, two function calls.
3. Drop `finish_reason` at the morphism boundary; orchestration reads provider response directly.

Recommend **(1)** — surfaces stop-reason as a first-class luv concept, since it's universal across all providers. Will pause on this at Phase 5 (loss table).

## Shape coverage matrix

Each row is one fixture under `core/fixtures/openai/NNN_<slug>/`. Models default to `gpt-4o-mini` for cost; some require an o1/o3 model and are flagged.

### Non-streaming

| # | slug | shape exercised | model | source | expected finish_reason |
|---|---|---|---|---|---|
| 001 | `single_user` | one user message | gpt-4o-mini | live | `stop` |
| 002 | `multi_turn` | user → assistant → user | gpt-4o-mini | live | `stop` |
| 003 | `with_system` | single system + user | gpt-4o-mini | live | `stop` |
| 004 | `multi_system` | two system messages + user (verify both flow into request, OpenAI concatenates) | gpt-4o-mini | live | `stop` |
| 005 | `max_tokens_hit` | low `max_tokens` (e.g. 8) on a long-answer prompt | gpt-4o-mini | live | `length` |
| 006 | `stop_sequence_hit` | `stop: ["END"]` with a prompt that produces "END" | gpt-4o-mini | live | `stop` (with stop sequence) |
| 007 | `unicode_content` | user prompt + assistant reply containing emoji, embedded quotes, backslashes, and 4-byte UTF-8 | gpt-4o-mini | live | `stop` |
| 008 | `developer_role` | role=`developer` system instruction targeting o1 vocabulary (uses `max_completion_tokens`) | o1-mini | live | `stop` |
| 009 | `refusal` | assistant `refusal` non-null, `content` null | — | **synthetic** (hand-written response.json; unreliable to elicit) | `stop` |
| 010 | `content_filter` | `finish_reason: "content_filter"` | — | **synthetic** | `content_filter` |

### Streaming

| # | slug | shape exercised | model | source |
|---|---|---|---|---|
| 011 | `stream_basic` | short streamed reply, `stream_options` omitted | gpt-4o-mini | live |
| 012 | `stream_with_usage` | same prompt as 011 but `stream_options: {"include_usage": true}` — final chunk carries `usage`, empty `choices` | gpt-4o-mini | live |
| 013 | `stream_max_tokens` | streamed reply truncated by `max_tokens=8`, finish_reason="length" arrives mid-stream | gpt-4o-mini | live |

### Explicitly out of scope (this pass)

- Tool/function calling — separate skill pass.
- Vision (image_url content parts) — separate skill pass.
- Audio modalities — separate skill pass.
- Structured-output / JSON-mode — separate skill pass.
- `n > 1` (multiple choices) — luv has no representation for parallel completions.
- Logprobs — debugging affordance, not part of the conversation contract.
- Error responses — a transport-level concern, not a morphism-level concern. Errors are surfaced by transport before `fromProvider` is called. Error parsing tested separately under `core/src/transport/`.

### Quirks already accounted for

- **Consecutive same-role**: OpenAI accepts it, unlike Anthropic. No special fixture needed; the morphism passes messages through in order.
- **`name` field**: not a luv concept; we never emit it. No fixture for it.
- **`system_fingerprint`**: dropped per loss table; no shape difference. Implicitly covered by every fixture.

### Fields observed in live responses but not in docs

Captured during fixture recording; all dropped at the morphism boundary.

- **`message.annotations: []`** — appears on non-streaming assistant messages. Empty array in text-only responses; populated for tool/citation use cases out of scope here.
- **`service_tier: "default"`** — top-level on both streaming and non-streaming. Billing tier the request was served at.
- **`usage.prompt_tokens_details`** — `{cached_tokens, audio_tokens}`. Subfields of usage we don't surface.
- **`usage.completion_tokens_details`** — `{reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens}`. Same.
- **`obfuscation: "..."`** — per-SSE-chunk random string. OpenAI anti-extraction noise. Stripped by streaming decoder.

## Sources

- [Create chat completion — OpenAI API Reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Chat Completions streaming events — OpenAI API Reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- [Streaming API responses guide — OpenAI](https://developers.openai.com/api/docs/guides/streaming-responses)
- [How to stream completions — OpenAI Cookbook](https://developers.openai.com/cookbook/examples/how_to_stream_completions)
