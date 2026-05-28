# anthropic_messages transport

HTTP-level behavior layered above the `anthropic_messages` morphism.
Reference-grade (not contract-grade); the bench tests conformance via
recorded fixtures.

The core spec is `spec/SPEC.md`. The morphism is
`anthropic_messages.md`. This transport spec references both by name
and follows the same shape as `spec/morphisms/openai_chat/transport.md`.

## Endpoint, method, headers

- URL: `${base_url}/messages`
  - Default `base_url`: `https://api.anthropic.com/v1`
  - Configurable for Anthropic-compatible providers (Vertex AI's
    Anthropic endpoint, AWS Bedrock's Anthropic endpoint) via
    `base_url` override, with the caveat that those services use
    different auth and may add other URL-pattern requirements.
- Method: `POST`
- Required headers (in canonical order):
  - `anthropic-version: ${anthropic_version}` (default `"2023-06-01"`)
  - `content-type: application/json`
  - `x-api-key: ${api_key}` (note: NOT `authorization: Bearer …`)

Header name case: in canonical `HTTPRequest` representations, header
names are emitted in lowercase, with this header order:
`anthropic-version`, `content-type`, `x-api-key`.

## Configuration

```
AnthropicClientConfig := {
  api_key: Text,
  base_url?: Text,
  anthropic_version?: Text,
  default_max_tokens?: Number,
  timeout_ms?: Number,
  on_error?: ErrorPolicyMap
}
```

Defaults a reference implementation should use:

- `base_url`: `"https://api.anthropic.com/v1"`
- `anthropic_version`: `"2023-06-01"`
- `default_max_tokens`: `4096` (Anthropic requires `max_tokens`; if the
  caller doesn't supply one in per-call opts, this default is used)
- `timeout_ms`: `60000`
- `on_error`: same defaults as OpenAI transport (content_filter as
  block, others throw)

## Transport-internal types

Same shapes as the openai_chat transport — `HTTPRequest` and
`HTTPResponse` — defined in `spec/morphisms/openai_chat/transport.md`.
These types are shared across HTTP-based transports.

## Transport arrows

Three pure functions, parallel to the openai_chat transport. Each is
testable as `input.json` → `expected.json` byte comparison.

### `luv_send_to_anthropic_http_request : (Conversation, Opts, Config) → HTTPRequest`

Builds the outgoing HTTP request.

- `method`: always `"POST"`.
- `url`: `${config.base_url}/messages` (default
  `"https://api.anthropic.com/v1/messages"`).
- `headers`: lowercase keys in canonical order; required pair as above.
- `body`: the canonical JSON of the Anthropic request body, identical
  to what `luv_conversation_to_anthropic_request(conv, opts)` from the
  morphism would emit, as a string.

### `anthropic_http_response_to_luv_reply : HTTPResponse → Reply`

Maps a complete HTTP response to a luv Reply. Status-code → ErrorCategory
mapping (identical table to the OpenAI transport):

| status | Action |
|---|---|
| 200–299 | Parse body as JSON → `Anthropic.Response`. Apply `anthropic_response_to_luv_reply` morphism. |
| 400 | Emit error block, `category: "bad_request"`. |
| 401, 403 | `category: "auth"`. |
| 408, 504 | `category: "network"` (timeout). |
| 429 | `category: "rate_limit"`. |
| 500–503 | `category: "server_error"`. |
| other 4xx | `category: "bad_request"`. |
| other 5xx | `category: "server_error"`. |
| 0 / unparseable | `category: "network"`. |

When emitting an error block, the returned Reply has
`message.role: "assistant"`, `message.content` containing one error
block, and `finish_reason: "error"`.

### `anthropic_http_stream_to_luv_stream : HTTPResponse → Stream<Reply>`

Maps a streaming HTTP response to a luv `Stream<Reply>`.

For a `2xx` response:

1. Parse `body` as an SSE byte stream.
   - Split events on `\n\n`.
   - Each event has an `event:` line indicating the type and a `data:`
     line carrying the JSON payload.
   - Anthropic's SSE format does NOT use a `[DONE]` terminator; the
     stream ends with a `message_stop` event followed by the connection
     closing.
   - Skip `ping` events.
2. JSON-parse each `data:` payload to an Anthropic event object.
3. Apply `anthropic_stream_to_luv_stream` morphism to the resulting
   event array.

For a non-`2xx` response, emit a single-element error stream as in the
non-streaming case — `message_start`, `block_start` (error block),
`block_end`, `message_end` with `finish_reason: "error"`.

## Anthropic-compatible providers

| Provider | `base_url` | Notes |
|---|---|---|
| Anthropic (default) | `https://api.anthropic.com/v1` | — |
| AWS Bedrock (Anthropic models) | Provider-specific URL pattern | Uses AWS Signature V4 auth, not `x-api-key`; this transport does not produce the right request. Custom transport required. |
| Vertex AI (Anthropic models) | Provider-specific URL pattern | Uses Google Cloud auth; same caveat. |

Unlike OpenAI, Anthropic does not have a wide ecosystem of
wire-compatible providers; the API surface is more tightly controlled.
The `base_url` override is mostly useful for local proxying and
testing.

## Out of scope

Same as the OpenAI transport — retries, rate-limit backoff, telemetry,
caching, request signing, connection pooling, streaming back-pressure
all belong above this layer.

## Conformance

Three case directories under `cases/`:

- `cases/luv_send_to_anthropic_http_request/<n>_<slug>/`
- `cases/anthropic_http_response_to_luv_reply/<n>_<slug>/`
- `cases/anthropic_http_stream_to_luv_stream/<n>_<slug>/`

Each case: `input.json` + `expected.json` + optional `record.json`.
Same pattern as the OpenAI cases.
