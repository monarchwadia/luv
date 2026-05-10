# luv

A modular, WASM-first agentic framework. The core compiles to `wasm32-freestanding` so the same agent harness runs in browsers and on servers; provider integrations, transport, and orchestration are pluggable layers around a small canonical conversation type.

## Development

- `make build` — compile the WASM artifact (`core/zig-out/wasm/luv_core.wasm`).
- `make test` — run hermetic unit tests against captured fixtures. No network, no env vars.
- `make fmt` — check formatting across `core/src`, `core/build.zig`, and `test-tools`.
- `make snapshot` — re-record live-API fixtures. Loads `.env` from repo root, requires `OPENAI_API_KEY`. Each `core/fixtures/<provider>/<NNN_slug>/request.json` is replayed against the live API; the response is staged in `test-tools/.tmp/` and then copied into the fixture directory.

Provider integrations follow the `add-morphism` workflow: research → shape matrix → fixtures → pure morphism (`luv ↔ provider`) → loss table → tests. See `core/src/morphisms/` for in-progress provider notes.
