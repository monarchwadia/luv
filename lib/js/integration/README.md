# Consumer integration matrix

Verifies the **published** `luv-js` (packed tarball, honoring `files` + `exports`)
imports and resolves across runtimes and the headline bundlers — with **zero
helper plugins**, since each bundler must consume the package the way a real
user would.

```bash
bun integration/run.ts            # quick: node, bun, esbuild
bun integration/run.ts --all      # + vite, webpack + Playwright browsers
bun integration/run.ts --only=bun,esbuild
bun integration/run.ts --browser  # force browser consumers on
```

## What it does

1. `bun run build` (esbuild bundles + tsc emits `.d.ts`).
2. `bun pm pack` → `.pack/luv-js-0.1.0.tgz`.
3. Each `consumers/<x>/` installs that tarball via `file:` dep, builds, and
   asserts every public export of `luv-js`, `luv-js/middleware` (and
   `luv-js/mcp` for node/bun) resolves.
4. Browser consumers are served over HTTP and loaded in Chromium / Firefox /
   WebKit via Playwright.

## Notes / dependency policy

- **No convenience plugins.** Vite, webpack, esbuild resolve `node_modules`
  natively. Standalone Rollup is intentionally omitted — vanilla Rollup can't
  resolve bare specifiers without a resolver plugin, and Vite's production
  build already exercises Rollup. Parcel is omitted — it crashes under Bun's
  runtime (native modules) and isn't worth a Node-only carve-out.
- **Node consumer** is skipped automatically on a Node-less host (this dev box
  is Bun-only); it runs wherever `node` is on PATH.
- **Playwright is optional.** Browser builds still run and are validated; the
  in-browser assertion is skipped unless Playwright is present:
  `bun add -d playwright && bunx playwright install`. It is not installed by
  default to respect the project's minimal-dependency stance.
- `consumers/*/node_modules`, `dist`, and `.pack/` are build artifacts — git-ignore them.
