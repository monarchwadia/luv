# Benchmarks: luv-js vs alternatives

Measured on 2026-05-10. Methodology: `bun add` each package, `bun build` a
minimal "send a chat completion" script with `--minify --target=browser`,
measure resulting bundle size.

Reproduce with:

```bash
cd benchmarks
bun install
bun run all
```

(Source for each scenario in `vercel-app.ts`, `openai-sdk-app.ts`,
`luv-app.ts`. Bundle outputs in `/tmp/*.js`.)

## Bundle size (the user-facing number)

What ships in the user's browser bundle when they import the SDK and call
one chat completion. Lower is better.

| Library | Bundled minified | vs luv-js |
|---|---:|---:|
| **luv-js** | **14 KB** | 1.0× |
| `openai` (official OpenAI SDK) | 128 KB | 9.1× |
| `ai` + `@ai-sdk/openai` (Vercel AI SDK) | 610 KB | **43.6×** |

For edge functions, Cloudflare Workers, or browser bundles where every KB
counts, this is the load-bearing number. The Vercel AI SDK bundle is large
because it pulls in zod (~50KB), opentelemetry instrumentation, and the
`openai` SDK as a transitive dep.

## Install size (what npm pulls down)

What ends up in `node_modules`. Affects cold-start install time on CI and
Docker image size.

| Library | `node_modules` size | Top-level deps |
|---|---:|---:|
| **luv-js** | ~200 KB (dist only) | **0** |
| `openai` | 17 MB | 1 |
| `ai` + `@ai-sdk/openai` + `zod` + transitive `openai` | 41 MB | 4 (+ transitive @opentelemetry, @standard-schema, eventsource-parser, json-schema, @vercel) |

## Runtime memory + startup

luv-js has no expensive initialization. Loading the bundle and creating a
client is ~constant-time work over a few KB of code. Vercel AI SDK and the
official `openai` SDK both initialize provider clients with internal
configuration, retry policies, fetch shims, etc.

(Memory profiling against real workloads is workload-dependent and best
done in your own app. The relevant signal is: luv-js's dist is 14 KB
minified, with zero allocations beyond what your code does directly.)

## Pydantic AI

Different ecosystem (Python). Comparable on the architectural pitch
(typed, agent-centric) but not directly comparable on bundle size. Pydantic
AI typical install: 30-100 MB depending on which provider extras are
selected. Direct dependency on Pydantic (~10-20 MB) and a provider SDK.

## Caveat

Bundle size is an honest comparison only if you actually ship the bundle
to the browser or care about cold-start time on edge runtimes. For
server-side Node.js apps where the dependency tree downloads once at
deploy time, the install size matters but the bundle size doesn't (since
you're not bundling for browsers). Pick the comparison that matches your
deployment.

## Numbers may shift

LLM SDKs are evolving fast. These numbers were captured against:

- `ai@6.0.177`
- `@ai-sdk/openai@latest` (May 2026)
- `zod@4.4.3`
- `openai@6.37.0`
- `luv-js@0.1.0` (this repo)

Re-run the benchmark to refresh.
