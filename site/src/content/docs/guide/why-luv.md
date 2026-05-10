---
title: Why luv (vs Vercel AI SDK)
description: When to pick luv-js, when to pick the alternative.
---

Honest comparison. luv-js is a young project with a small surface; Vercel
AI SDK is mature, broad, and standard in the JS ecosystem. Pick the right
tool for your situation.

## Pick luv-js when…

- **Bundle size matters.** 14 KB minified vs Vercel's 610 KB
  ([benchmarks](https://github.com/monarchwadia/luv/tree/main/benchmarks)).
  Edge functions, Cloudflare Workers, embedded apps, browser bundles where
  every KB shows up in cold-start time.
- **You want zero runtime dependencies.** Easier auditing, smaller install,
  no transitive surprises.
- **You want composable Provider middleware.** `retry(rateLimit(cache(meter(provider))))`
  is one line. No equivalent in Vercel AI SDK.
- **You want recording + replay for tests.** Capture a real conversation
  to a tape, replay it deterministically in CI without needing API keys.
- **You want to swap providers mid-conversation.** Same `Message[]` array
  flows through OpenAI on turn 1, Anthropic on turn 2. The luv canonical
  type is a forgetful quotient — the conversation belongs to *you*, not to
  the provider.
- **You like the data-first design.** Conversation is a plain array.
  Inspect, fork, splice, persist — no framework objects in the way.

## Pick Vercel AI SDK when…

- **You need broad provider coverage.** 20+ providers including AWS Bedrock,
  Vertex, Mistral, Groq, Together. luv-js has OpenAI + Anthropic +
  OpenAI-compatible endpoints.
- **You need image generation, audio, embeddings, multi-modal inputs.**
  luv-js is text + tools only.
- **You're building with React.** Vercel ships `useChat`, `useCompletion`,
  `useObject` hooks. luv-js doesn't (yet).
- **You want a large ecosystem.** Stack Overflow answers, blog posts,
  tutorials, integrations — luv-js is months old.
- **You need the Vercel ecosystem.** Next.js, Vercel hosting, AI Gateway —
  Vercel AI SDK is the natural fit.

## Pick neither, use the OpenAI SDK directly when…

- You only ever talk to OpenAI.
- You want the maximum surface area of OpenAI's API surfaced.
- You don't need an agent loop or conversation persistence.

## What luv-js is NOT trying to be

- A general-purpose AI framework with image generation, embeddings,
  fine-tuning, etc. luv is focused on chat + tools + agents.
- A 1.0-stable product yet. The architecture is settled; the surface API is
  stable enough to use, but expect ~modest evolution.
- A drop-in replacement for Vercel AI SDK feature-by-feature. luv has fewer
  features and different design choices (data-first vs object-first).

If after reading this you still aren't sure: **start with Vercel AI SDK**.
luv-js is the right pick when one of the "pick luv" reasons above is
actually load-bearing for your app.
