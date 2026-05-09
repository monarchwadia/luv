---
name: add-morphism
description: Standard workflow for adding a new LLM provider morphism (luv ↔ provider) under core/src/morphisms/. Use when the user asks to add support for a chat/messages-style API (Anthropic, OpenAI, Gemini, Mistral, Cohere, etc.) to the luv project, or to "build" or "implement" a provider morphism.
---

# Adding a new provider morphism

A "morphism" in luv is a pure mapping between the canonical luv types (`core/src/morphisms/luv.zig` — `Role`, `Message`, `Conversation`) and a specific provider's wire JSON. Morphisms have **no I/O** — they take JSON-shaped data and return JSON-shaped data, plus an allocator for owned strings. Transport (HTTP, streaming, retries) lives in a separate layer (`core/src/transport/`); orchestration (`core/src/agent/`) composes morphism + transport.

The luv type is intentionally a *forgetful quotient* of all providers — the largest common subset, not the disjoint union. **Every morphism is lossy in at least one direction**, and the loss is documented per provider in a comment block at the top of the morphism file.

## Layout

```
core/
├── src/morphisms/
│   ├── luv.zig                  # canonical types — do not edit when adding a provider
│   ├── <provider>.zig           # new file: types + toProvider + fromProvider
│   ├── <provider>.md            # provider notes, doc links, shape matrix, e2e env vars
│   ├── <provider>_stream.zig    # streaming decoder (when streaming is in scope)
│   └── README.md                # provider index table
├── fixtures/<provider>/
│   └── NNN_<slug>/
│       ├── meta.json            # one-line description + tags
│       ├── request.json         # wire-format request body
│       ├── response.json        # captured non-streaming response
│       └── response.sse.txt     # raw SSE bytes (streaming variants only)
└── tools/record_<provider>.py   # one-shot fixture recorder, ~60 lines
```

## Phase 1 — Read official docs

Skim the provider's API reference for chat/messages. Capture URLs and key excerpts in `core/src/morphisms/<provider>.md`. Specifically note:

- **Endpoint URL** + auth header format
- **Request body shape** — required fields, optional fields, role-name vocabulary
- **System-prompt mechanism** — top-level field? message in the array? something else?
- **Response shape** — message structure, stop-reason vocabulary, usage/billing fields
- **Streaming format** — SSE? what events does it emit?
- **Error shape** — error JSON structure and HTTP status conventions
- **Model identifiers** — what string goes in the `model` field

Don't try to cover tool-calling, vision, or structured output. Text-only is the slice this skill handles.

## Phase 2 — Define the shape coverage matrix

Append a "Shape coverage" section to `<provider>.md` listing every text-only conversation shape you intend to support. Minimum coverage:

- Single user message
- Multi-turn (user / assistant / user)
- With system prompt (single)
- Multiple system blocks, if the provider supports them
- Empty / refusal assistant message
- Each distinct stop reason the provider documents (`end_turn`, `max_tokens`, `stop_sequence`, …)
- Unicode + JSON-escape edge cases (emoji, embedded quotes / backslashes, multi-byte sequences)
- Any quirk the docs flagged in Phase 1 (e.g. "rejects consecutive same-role" → fixture that proves the outgoing morphism produces a well-formed request)

**Pause point**: stop here and surface the matrix to the user. They may want to add or remove rows. Do not start capturing until they confirm.

## Phase 3 — Capture fixtures

Use the project's record tool:

```
python tools/record_<provider>.py core/fixtures/<provider>/<NNN>_<slug>/
```

The tool reads `<dir>/request.json`, sends to the live API using `<PROVIDER>_API_KEY` from the environment, and writes `response.json` (and `response.sse.txt` if `request.json` has `"stream": true`).

If `tools/record_<provider>.py` doesn't exist yet, write it. Reference shape:

```python
import os, sys, json, pathlib, httpx
fixture = pathlib.Path(sys.argv[1])
req = json.loads((fixture / "request.json").read_text())
url = "<from phase 1>"
headers = {"Authorization": f"Bearer {os.environ['<PROVIDER>_API_KEY']}"}
if req.get("stream"):
    with httpx.stream("POST", url, headers=headers, json=req) as r:
        (fixture / "response.sse.txt").write_bytes(b"".join(r.iter_raw()))
else:
    r = httpx.post(url, headers=headers, json=req, timeout=60)
    (fixture / "response.json").write_text(json.dumps(r.json(), indent=2) + "\n")
```

For each fixture from Phase 2:
1. Hand-author `request.json` and `meta.json` (`{"slug": "...", "shape": "...", "synthetic": false}`).
2. Run the recorder.
3. Inspect the response. Sanity-check it actually exercises the shape you wanted (e.g. for a `max_tokens` fixture, confirm `stop_reason` is `max_tokens`).
4. **Sanitize**: strip API keys from any captured headers; replace user-PII content with placeholder strings.

Some shapes can't be reliably elicited from the live API (specific error responses, deterministic empty content). Hand-write those `response.json` files and set `"synthetic": true` in `meta.json`.

**Pause point**: surface one captured fixture to the user before authoring the rest. Confirm the format and sanitization match expectations.

## Phase 4 — Implement the morphism

Create `core/src/morphisms/<provider>.zig`:

```zig
const std = @import("std");
const luv = @import("luv.zig");

pub const Request = struct { ... };   // mirrors wire JSON exactly
pub const Response = struct { ... };  // mirrors wire JSON exactly

pub const Options = struct {
    model: []const u8,
    max_tokens: u32,
    // Only fields that map cleanly across providers belong in luv.Conversation.
    // Provider-specific knobs go here.
};

pub fn toProvider(
    conv: *const luv.Conversation,
    opts: Options,
    alloc: std.mem.Allocator,
) !Request { ... }

pub fn fromProvider(
    resp: Response,
    alloc: std.mem.Allocator,
) !luv.Message { ... }
```

Use `std.json` for parsing and stringification. `Request` / `Response` mirror the wire JSON exactly — no luv concepts leak in.

Naming: `toAnthropic`, `fromAnthropic`, `toOpenAI`, `fromOpenAI` — single capitalized identifier per provider.

Streaming (when in scope) lives in `<provider>_stream.zig`:

```zig
pub const Decoder = struct {
    state: ...,
    pub fn init(alloc: std.mem.Allocator) Decoder { ... }
    pub fn deinit(self: *Decoder) void { ... }
    /// Feed raw SSE bytes; returns 0+ deltas to emit.
    pub fn feed(self: *Decoder, bytes: []const u8) ![]const luv.Delta { ... }
};
```

## Phase 5 — Write the loss table

At the top of `<provider>.zig`, in a comment block:

```zig
// Loss table (luv ↔ <provider>):
//
// luv → <provider>:
//   - <field>: <what's filled in / defaulted / dropped>
//
// <provider> → luv:
//   - <field>: <what's dropped>
//   - <field>: <what's coerced and how>
```

If you can't write this table, you don't understand the mapping yet — go back to Phase 1.

**Pause point**: surface the loss table to the user. This is the contract; getting alignment now is cheaper than after tests are written.

## Phase 6 — Unit tests against fixtures

For each fixture, two tests in `<provider>.zig`:

```zig
test "to_<provider>: NNN_<slug>" {
    // 1. Build the equivalent luv.Conversation by hand.
    // 2. Call toProvider.
    // 3. Stringify result; parse fixture's request.json.
    // 4. Deep-compare parsed JSON, ignoring only fields named in the loss table.
}

test "from_<provider>: NNN_<slug>" {
    // 1. Load fixture's response.json.
    // 2. Parse into Response struct.
    // 3. Call fromProvider.
    // 4. Assert luv.Message shape (role, non-empty text, expected stop class).
}
```

Tests use `std.testing.allocator` and run under `zig build test`. They must be hermetic — no network, no env vars. Loading fixtures from disk in tests is fine; use `@embedFile` or `std.fs.cwd().openFile` relative to the build root.

Write or reuse a small `jsonDeepEqualIgnoring(actual, expected, ignored_paths)` helper that walks parsed `std.json.Value` trees and skips loss-table paths.

## Phase 7 — E2E tests against the live API

Add a new build step in `core/build.zig`:

```zig
const e2e_tests = b.addTest(.{ .root_module = ... });
const run_e2e = b.addRunArtifact(e2e_tests);
const e2e_step = b.step("e2e", "Run live-API integration tests");
e2e_step.dependOn(&run_e2e.step);
```

E2E tests live in `core/src/morphisms/<provider>_e2e.zig` and are **not** wired into `zig build test`. Each test:

1. Reads `<PROVIDER>_API_KEY` from env. If absent, `return error.SkipZigTest;`.
2. Builds the same luv.Conversation as a corresponding fixture.
3. Sends through the real transport.
4. Runs `fromProvider` on the response.
5. Asserts **shape only** — never compares model output bytes:
   - Response parses without error.
   - Result `luv.Message` has expected role and non-empty text.
   - Stop-reason class matches expectation.

E2E costs money and rate-limit. Document required env vars at the top of `<provider>.md`.

## Phase 8 — Update the provider index

Append a row to `core/src/morphisms/README.md`:

| Provider | Status | Streaming | Key losses |
|---|---|---|---|
| <provider> | text-only | yes/no | brief one-liner |

## Pause points (summary)

Stop and surface to the user at these checkpoints — do not barrel through:

- **After Phase 2** — shape coverage matrix.
- **After Phase 3** — first captured fixture.
- **After Phase 5** — loss table.

Each pause is a short summary of the artifact plus "ready to proceed?". Do not ask narrow yes/no questions about details — surface the artifact and let the user redirect.

## Don't

- Don't build a generic HTTP capture tool (mitmproxy, HAR, VCR). The per-provider ~60-line Python recorder is enough.
- Don't add tools, vision, structured output, or streaming-with-tools in this skill. Each is a separate pass.
- Don't make `luv.zig` lossy per-provider (e.g. adding `anthropic_cache_control` to `luv.Message`). If a feature matters enough to preserve, promote it to a luv concept deliberately and update *all* morphisms.
- Don't run E2E in CI by default. Opt-in only.
- Don't inline fixture bytes as Zig string literals. Load from disk so fixtures are reviewable in PRs.
