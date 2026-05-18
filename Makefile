.PHONY: snapshot fmt test build e2e js js-test js-matrix ci

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

# Build the publishable JS package: bundle ESM + emit .d.ts.
# Output: lib/js/dist/{index.js, index.d.ts, ...}. Pure TypeScript, no wasm.
js:
	cd lib/js && $(BUN) run build

# Run the JS package's hermetic Bun tests.
js-test:
	cd lib/js && $(BUN) test

# Full consumer integration matrix: builds + packs luv-js and verifies the
# published tarball across node, bun, and every headline bundler in real
# Chromium/Firefox/WebKit (Playwright). Installs the browsers first.
js-matrix:
	cd lib/js && $(BUN) install && $(BUN) x playwright install --with-deps && $(BUN) run test:matrix:all

# Live-API integration tests. Requires OPENAI_API_KEY in .env.
e2e:
	@set -e; \
	test -f .env || { echo "error: .env not found at repo root"; exit 1; }; \
	set -a; . ./.env; set +a; \
	test -n "$$OPENAI_API_KEY" || { echo "error: OPENAI_API_KEY missing from .env"; exit 1; }; \
	cd test-tools && $(ZIG) build e2e

# Comprehensive CI: format check, all unit tests (Zig core + JS Bun), wasm
# build, publishable JS build, and the full consumer integration matrix.
# Excludes `e2e` (needs live OPENAI_API_KEY) — run that separately.
ci: fmt test build js js-test js-matrix
	@echo "CI: all checks passed"
