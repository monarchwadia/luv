---
title: Streaming
description: Three ways to consume a streaming chat completion.
---

`sendStream` returns a `LuvStream` — an object that supports three
consumption patterns simultaneously:

```ts
const stream = luv.sendStream({
  model: "gpt-4o-mini",
  conversation: [{ role: "user", text: "Count to five." }],
});

// (1) Just text — the common case.
for await (const text of stream.text()) {
  process.stdout.write(text);
}

// (2) Every event — start, text deltas, stop.
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
  if (event.type === "stop") console.log("done:", event.stopReason);
}

// (3) Just await the assembled final Reply.
const reply = await stream.done;
```

You can mix patterns — for example, iterate events for UI updates while
also awaiting `.done` for the final assembled text.

## Cancellation

`stream.cancel()` aborts the underlying fetch and frees the SSE decoder.
Idempotent.

```ts
const stream = luv.sendStream({...});
setTimeout(() => stream.cancel(), 5000);

const reply = await stream.done;  // resolves with whatever was assembled
```

You can also pass an external `AbortSignal`:

```ts
const ctl = new AbortController();
const stream = luv.sendStream({ ..., signal: ctl.signal });
ctl.abort();
```

## Lifecycle hooks

If you don't want to iterate but still want to observe events, use hooks:

```ts
const stream = luv.sendStream({
  ...,
  onStart: (role) => console.log("started:", role),
  onDelta: (delta) => process.stdout.write(delta),
  onStop:  (reason) => console.log("\ndone:", reason),
  onError: (err) => console.error("stream error:", err.message),
});
await stream.done;
```

Hooks fire alongside any iteration you do — they observe the same event
stream.

## When NOT to stream

Streaming adds API surface and code complexity. If you don't need
incremental rendering (e.g., you're just waiting for a final answer), use
`send()` instead — same shape, less plumbing.
