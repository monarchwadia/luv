# AWS Bedrock Converse — Implementation Plan

## Summary

Add a `bedrock_converse` morphism targeting the unified AWS Bedrock
Converse API. One morphism covers all chat models on Bedrock (Claude,
Llama, Mistral, Nova, DeepSeek, Qwen, Cohere, etc.) because the
Converse API is model-agnostic — the same request/response format
regardless of underlying model.

## What we ship

1. **Morphism spec** — `spec/morphisms/bedrock_converse/bedrock_converse.md`
   (contract-grade). Pure data transforms, field mappings, enum
   mappings, homomorphism exceptions, laws satisfied.

2. **Bench cases** — `spec/morphisms/bedrock_converse/cases/<arrow>/`
   with `input.json` + `expected.json` per case.

3. **TS reference impl** — morphism module
   (`impl/typescript/src/morphisms/bedrock_converse.ts`) plus a client
   (`impl/typescript/src/transport/bedrock_converse.ts`) that handles
   SigV4 signing and event-stream decoding internally.

## What we do NOT ship

- No transport spec. Bedrock's transport complexity (SigV4, binary
  event-stream framing, CRC32) is the implementation's problem, not
  the spec's. Transport specs are reference-grade, not contract-grade,
  and Bedrock doesn't need one.
- No middleware formalization in the spec. The concept is useful but
  not load-bearing for conformance.
- No new dependencies (zero-dependency rule holds).

## Morphism arrows

Three pure, auth-free data transforms:

```
luv_conversation_to_bedrock_request : (Conversation, Opts) → Bedrock.Request
bedrock_response_to_luv_reply       : (Bedrock.Response, model_id) → Reply
bedrock_stream_to_luv_stream        : (Bedrock.Stream, model_id) → Stream<Reply>
```

The morphism arrows have no knowledge of signing, HTTP, or binary
framing. They take and produce JSON.

`model_id` is passed explicitly to the response/stream arrows because
Bedrock does not echo the model in the response body (it's only in the
URL path). This differs from OpenAI/Anthropic where model is in the
response.

## Opts shape

Flat, consistent with other morphisms:

```
BedrockRequestOptions := {
  model_id: string,
  max_tokens?: number,
  temperature?: number,
  top_p?: number,
  stop_sequences?: string[],
  tools?: unknown[],
  tool_choice?: unknown
}
```

The arrow nests `max_tokens`, `temperature`, `top_p`, `stop_sequences`
into Bedrock's `inferenceConfig` object internally. The caller doesn't
need to know about Bedrock's nesting.

## Wire type mappings

### Content blocks

| Bedrock Converse | luv |
|---|---|
| `{text: "..."}` | `{kind: "text", text: "..."}` |
| `{toolUse: {toolUseId, name, input}}` | `{kind: "tool_call", id, name, args: JSON.stringify(input)}` |
| `{toolResult: {toolUseId, content: [{text: "..."}]}}` | `{kind: "tool_result", call_id, text}` |

### System messages

luv system-role messages concatenate into Bedrock's top-level `system`
array (array of `{text: "..."}` blocks). Each luv system message
becomes one entry.

### Roles

| luv Role | Bedrock role |
|---|---|
| `system` | not a message role; goes to top-level `system` array |
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

### Usage

```
Usage := {
  provider: "bedrock_converse",
  model: <model_id passed by caller>,
  raw: <Bedrock usage object verbatim: {inputTokens, outputTokens, totalTokens, ...}>
}
```

## Streaming

### Input shape for bench

The bench input for `bedrock_stream_to_luv_stream` is a JSON array of
raw Bedrock event objects as the provider emits them:

```json
[
  {"messageStart": {"role": "assistant"}},
  {"contentBlockStart": {"contentBlockIndex": 0, "start": {"text": ""}}},
  {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hello"}}},
  {"contentBlockStop": {"contentBlockIndex": 0}},
  {"messageStop": {"stopReason": "end_turn"}},
  {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}
]
```

### Event mapping

| Bedrock event | luv event(s) |
|---|---|
| `messageStart` | `message_start` |
| `contentBlockStart` (text) | `block_start` with `{kind: "text", text: ""}` |
| `contentBlockStart` (toolUse) | `block_start` with `{kind: "tool_call", id, name, args: ""}` |
| `contentBlockDelta` (text delta) | `text_delta` |
| `contentBlockDelta` (toolUse input delta) | `args_delta` |
| `contentBlockStop` | `block_end` |
| `messageStop` | stores `stopReason`; does NOT emit yet |
| `metadata` | emits `message_end` with stored finish_reason + usage envelope |

### Graceful degradation

If the stream ends without a `metadata` event (connection closed after
`messageStop`), emit `message_end` with `usage: null` and the stored
`stopReason`. The developer gets their completion; they just don't get
token counts.

Network-level timeouts (hung connections) are handled by the client's
`timeout_ms` config, same as other providers.

## TS client (impl-level, not spec)

### Config

```ts
interface BedrockClientConfig {
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  endpoint_url?: string;       // override for VPC endpoints, localstack
  timeout_ms?: number;
  on_error?: ErrorPolicyMap;
}
```

Static credentials only. No credential-provider callback in v1. Users
with refreshable credentials refresh externally and pass fresh values.

### Auth

SigV4 signing implemented using Web Crypto (`crypto.subtle`):
- SHA-256 hashing via `crypto.subtle.digest`
- HMAC-SHA256 via `crypto.subtle.importKey` + `crypto.subtle.sign`
- ~100 lines, zero dependencies

### Streaming transport

AWS event-stream binary frame decoding:
- `DataView` + `Uint8Array` (Web standard)
- Frame structure: 4-byte total length, 4-byte headers length,
  4-byte prelude CRC, headers, JSON payload, 4-byte message CRC
- CRC32 validation is optional hardening (recommended, not required
  for morphism conformance)
- ~110 lines, zero dependencies

### Methods

Both from day one:
- `send(conv, opts)` → calls `/model/{modelId}/converse`
- `stream(conv, opts)` → calls `/model/{modelId}/converse-stream`

### Error handling

| Bedrock HTTP status | luv ErrorCategory |
|---|---|
| 400 (ValidationException) | `bad_request` |
| 403 (AccessDeniedException, ExpiredTokenException) | `auth` |
| 404 (ResourceNotFoundException) | `bad_request` |
| 408 (ModelTimeoutException) | `network` |
| 424 (ModelErrorException) | `server_error` |
| 429 (ThrottlingException, ModelNotReadyException) | `rate_limit` |
| 500 (InternalServerException) | `server_error` |
| 503 (ServiceUnavailableException) | `server_error` |

Expired credentials surface as `category: "auth"` with the provider's
error message preserved in `details`. The developer knows to refresh
creds — that's above luv.

## Out of scope

- Credential provider chains (IMDS, ECS task role, SSO)
- Retries, backoff
- Guardrail configuration pass-through
- Multimodal inputs (images, documents) — luv doesn't have those block
  types yet
- `additionalModelRequestFields` / `additionalModelResponseFieldPaths`
- Middleware formalization in the spec

## File tree (new files)

```
spec/morphisms/bedrock_converse/
  bedrock_converse.md
  cases/
    luv_conversation_to_bedrock_request/
      001_single_user_message/
      002_system_plus_user/
      003_assistant_with_tool_call/
      004_assistant_with_only_error_block/
    bedrock_response_to_luv_reply/
      001_simple_text/
      002_with_tool_call/
    bedrock_stream_to_luv_stream/
      001_simple_text_stream/
      002_with_tool_call_stream/

impl/typescript/src/
  morphisms/bedrock_converse.ts
  transport/bedrock_converse.ts
```

## Verification

1. `bun test` — existing 27 cases stay green + new Bedrock cases pass.
2. `bun run smoke` with valid AWS credentials — end-to-end live test.
3. All `expected.json` reviewed before commit.
