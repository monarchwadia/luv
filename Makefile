.PHONY: snapshot fmt test build e2e js js-test

BUN ?= $(shell command -v bun 2>/dev/null || echo $$HOME/.bun/bin/bun)

ZIG ?= zig

# Record all live snapshots into tmp/, then publish to fixtures.
# Loads .env and verifies required env vars before invoking the recorder.
snapshot:
	@set -e; \
	test -f .env || { echo "error: .env not found at repo root"; exit 1; }; \
	set -a; . ./.env; set +a; \
	test -n "$$OPENAI_API_KEY" || { echo "error: OPENAI_API_KEY missing from .env"; exit 1; }; \
	for dir in core/fixtures/openai/*/; do \
	  test -f $$dir/request.json || continue; \
	  slug=$$(basename $$dir); \
	  staging=test-tools/.tmp/snapshots/openai/$$slug; \
	  mkdir -p $$staging; \
	  echo "==> $$slug"; \
	  $(ZIG) run test-tools/record_openai.zig -- $$dir/request.json $$staging; \
	  cp $$staging/response.* $$dir/; \
	done

fmt:
	$(ZIG) fmt --check core/src core/build.zig test-tools/build.zig test-tools/e2e test-tools/record_openai.zig

test:
	cd core && $(ZIG) build test

build:
	cd core && $(ZIG) build wasm

# Build the publishable JS package: wasm → embed as base64 → bundle → emit .d.ts.
# Output: lib/js/dist/{index.js, index.d.ts, ...}.
js:
	cd lib/js && $(BUN) run build

# Run the JS package's hermetic Bun tests. Auto-rebuilds wasm + embed first.
js-test:
	cd lib/js && $(BUN) run build:wasm && $(BUN) run build:embed && $(BUN) test

# Live-API integration tests. Requires OPENAI_API_KEY in .env.
e2e:
	@set -e; \
	test -f .env || { echo "error: .env not found at repo root"; exit 1; }; \
	set -a; . ./.env; set +a; \
	test -n "$$OPENAI_API_KEY" || { echo "error: OPENAI_API_KEY missing from .env"; exit 1; }; \
	cd test-tools && $(ZIG) build e2e
