# openai_chat transport

This document specifies the HTTP-level behavior layered above the
`openai_chat` morphism. The transport is what actually calls the API:
it builds the outgoing HTTP request, sends it, maps the response (and
its status code) back to luv canonical values.

The core spec is `spec/SPEC.md`. The morphism is `openai_chat.md`. This
transport spec references both by name.

## What this spec is and isn't

**This spec is reference-grade**, not contract-grade like the morphism.
Live API responses vary per call (IDs, timestamps, fingerprints,
sampled completions differ each time), so outputs are not
byte-deterministic in production.

**What is byte-deterministic** is the transport behavior given a fixed
HTTP exchange — that's what the bench tests via recorded fixtures.

## Endpoint, method, headers

- URL: `${base_url}/chat/completions`
  - Default `base_url`: `https://api.openai.com/v1`
  - Configurable for OpenAI-compatible providers (see below).
- Method: `POST`
- Required headers:
  - `authorization: Bearer ${api_key}`
  - `content-type: application/json`
- Optional headers (emitted only if config provides them):
  - `openai-organization: ${organization}`
  - `openai-project: ${project}`

**Header name case.** In canonical `HTTPRequest` representations,
header names are emitted in lowercase. HTTP itself treats header names
as case-insensitive, but a canonical lowercase form makes byte
comparison meaningful.

## Configuration

The configuration shape is implementation-defined (per P8). The
recommended shape:

```
OpenAIClientConfig := {
  api_key: Text,
  base_url?: Text,
  organization?: Text,
  project?: Text,
  timeout_ms?: Number,
  on_error?: ErrorPolicyMap
}

ErrorPolicyMap := { [<ErrorCategory>]?: "throw" | "as_block" }
```

Defaults a reference implementation should use:

- `base_url`: `"https://api.openai.com/v1"`
- `timeout_ms`: `60000`
- `on_error`:
  - `content_filter`: `"as_block"` — content blocks are more naturally
    surfaced as data than as exceptions.
  - all other categories: `"throw"` — typical exception handling
    semantics.

## Transport-internal types

`HTTPRequest` and `HTTPResponse` are transport-internal canonical
shapes. They are not luv canonical types (so they live in this morphism
namespace rather than `spec/SPEC.md`). The Section 3 canonical encoding
rules apply to them with one relaxation: numeric values may appear as
JSON numbers (rather than decimal strings) because HTTP status codes
are natively numeric and no IEEE 754 ambiguity arises in their range.

### HTTPRequest

```
HTTPRequest := {
  method: Text,
  url: Text,
  headers: { [name]: Text },
  body: Text
}
```

Key order: `method`, `url`, `headers`, `body`. Header keys are
lowercase strings; values are strings. `body` is a `Text` value
containing the canonical JSON encoding of the request body (per the
morphism).

### HTTPResponse

```
HTTPResponse := {
  status: Number,
  headers: { [name]: Text },
  body: Text
}
```

Key order: `status`, `headers`, `body`. `status` is a JSON number (the
HTTP status code). `body` is the raw response body as `Text` — for
non-streaming responses, this is the JSON body; for streaming
responses, this is the raw SSE byte stream.

## Transport arrows

Three pure functions, each testable as `input.json` → `expected.json`
with byte comparison.

### `luv_send_to_openai_http_request : (Conversation, Opts, Config) → HTTPRequest`

Builds the outgoing HTTP request.

- `method`: always `"POST"`.
- `url`: `${config.base_url}/chat/completions` (default
  `"https://api.openai.com/v1/chat/completions"`).
- `headers`: lowercase keys; the required pair plus any of the optional
  pair that config provides. Order in canonical form: `authorization`,
  `content-type`, then (alphabetically) any optional headers present.
- `body`: the canonical JSON of the OpenAI request body, identical to
  what `luv_conversation_to_openai_request(conv, opts)` from the
  morphism would emit, as a string.

### `openai_http_response_to_luv_reply : HTTPResponse → Reply`

Maps a complete HTTP response to a luv Reply. Includes status-code →
`ErrorCategory` mapping.

Status code handling:

| status | Action |
|---|---|
| `200`–`299` | Parse `body` as JSON → `OpenAI.Response`. Apply `openai_response_to_luv_reply` morphism. Return that Reply unchanged. |
| `400` | Emit error block, `category: "bad_request"`. |
| `401`, `403` | `category: "auth"`. |
| `408`, `504` | `category: "network"` (timeout). |
| `429` | `category: "rate_limit"`. |
| `500`–`503` | `category: "server_error"`. |
| other `4xx` | `category: "bad_request"`. |
| other `5xx` | `category: "server_error"`. |
| `0` or unparseable | `category: "network"` (treated as connection-level failure). |

When an error block is emitted, the returned Reply is:

```
Reply := {
  message: {
    role: "assistant",
    content: [{
      kind: "error",
      category: <as mapped above>,
      message: <human-readable summary>,
      details: <canonical JSON containing status + raw body>
    }]
  },
  finish_reason: "error"
}
```

The `details` field carries `{"status": <n>, "body": <raw response body string>}` as canonical JSON, allowing consumers to inspect the original response.

The non-streaming arrow always returns a Reply (with error block on
failure); throwing is the call-site client's concern, governed by the
`on_error` policy.

### `openai_http_stream_to_luv_stream : HTTPResponse → Stream<Reply>`

Maps a streaming HTTP response to a luv `Stream<Reply>`.

For a `2xx` response:

1. Parse `body` as an SSE byte stream.
   - Split events on `\n\n`.
   - Within each event, lines starting with `data: ` carry payload;
     other lines (`event:`, `id:`, `retry:`, comments starting with `:`,
     blank lines) are ignored.
   - The literal payload `[DONE]` terminates the stream and is not
     emitted as a chunk.
2. JSON-parse each payload to an `OpenAI.StreamChunk`.
3. Apply `openai_stream_to_luv_stream` morphism to the resulting
   chunks array.
4. Return the resulting `Stream<Reply>`.

For a non-`2xx` response, emit a single-element stream describing the
failure:

```
[
  { kind: "message_start" },
  { kind: "block_start", block: { kind: "error", category: <mapped>, message, details } },
  { kind: "block_end" },
  { kind: "message_end", finish_reason: "error" }
]
```

The category mapping is identical to the non-streaming case.

If the stream is well-formed up to a point and then fails (network
drop, partial SSE event, parse error mid-stream), emit any complete
events received plus an error-block sequence appended before
`message_end`:

```
[ ...emitted events..., block_end (if needed), block_start error, block_end, message_end (error) ]
```

This ensures every `Stream<Reply>` produced by the transport is
well-formed per Section 2.6's grammar — block boundaries balance and
the stream ends with exactly one `message_end`.

## OpenAI-compatible providers

These providers mirror the Chat Completions wire format. This
transport works with them via `base_url` override:

| Provider | `base_url` | Notes |
|---|---|---|
| Together AI | `https://api.together.xyz/v1` | — |
| Mistral | `https://api.mistral.ai/v1` | — |
| Groq | `https://api.groq.com/openai/v1` | — |
| OpenRouter | `https://openrouter.ai/api/v1` | May require additional headers (`http-referer`, `x-title`) per OpenRouter convention. |
| Anyscale | `https://api.endpoints.anyscale.com/v1` | — |
| DeepSeek | `https://api.deepseek.com/v1` | — |
| Fireworks | `https://api.fireworks.ai/inference/v1` | — |
| Local vLLM | `http://localhost:8000/v1` | — |
| Azure OpenAI | Custom URL pattern | Uses a different URL structure (`/openai/deployments/<id>/chat/completions?api-version=...`). This transport does not produce that URL by default; Azure users may need a custom transport or URL override. |

Conformance test cases target the default OpenAI URL. Compatibility
with the providers above is users' responsibility to verify against
their target endpoint.

## Out of scope

The transport handles HTTP only. The following are *not* transport
concerns and belong elsewhere (middleware or call-site logic):

- Retries on rate limit or server error.
- Exponential backoff.
- Telemetry and observability (logging, tracing, metrics).
- Caching.
- Request signing.
- Connection pooling (handled by the host language's HTTP library).
- Streaming back-pressure (controlled by the consumer's iteration speed).

## Conformance

Three case directories under `cases/` exercise the three arrows:

- `cases/luv_send_to_openai_http_request/<n>_<slug>/`
- `cases/openai_http_response_to_luv_reply/<n>_<slug>/`
- `cases/openai_http_stream_to_luv_stream/<n>_<slug>/`

Each case has `input.json` and `expected.json`. The bench runs the
named arrow on `input.json` and byte-compares the output to
`expected.json`. The pattern is identical to morphism-level cases.

Recorded fixtures are refreshed via `bun run record` (in the TS
reference implementation), which:

- For `luv_send_to_openai_http_request`: sends each case's
  `expected.json` body to OpenAI and verifies HTTP 200.
- For `openai_http_response_to_luv_reply`: sends a paired luv
  conversation to OpenAI, captures the raw HTTP response (status,
  headers, body) as a fresh `input.json`. `expected.json` is
  hand-verified once and remains stable across refreshes.
- For `openai_http_stream_to_luv_stream`: as above, but captures the
  full SSE byte stream.
