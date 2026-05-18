// Stream C3 — the async driver template.
//
// Generated-reference: this is the canonical host driver the per-language
// generator must reproduce (the async/await concurrency-family template).
// It is intentionally transport-agnostic — it speaks a MachinePort, not wasm
// directly, so the same logic is proven here against a fake machine and later
// against the real wasm machine via an adapter.
//
// Contract (batched, sans-IO): poll() yields either an effect BATCH or done.
// The host performs every effect in the batch (concurrently), then feeds back
// exactly one result per effect, in order. wasm never suspends — every await
// happens here, between synchronous poll/feed.

export interface Effect {
  readonly kind: number;
  readonly payload: Uint8Array;
}

export type Poll =
  | { readonly kind: "effects"; readonly effects: readonly Effect[] }
  | { readonly kind: "done"; readonly output: Uint8Array };

export interface MachinePort {
  poll(): Poll | Promise<Poll>;
  feed(results: readonly Uint8Array[]): void | Promise<void>;
}

/** Performs one effect, resolving to its codec-encoded result. */
export type Interpreter = (effect: Effect) => Promise<Uint8Array>;

export async function drive(
  machine: MachinePort,
  interpret: Interpreter,
): Promise<Uint8Array> {
  let frame = await machine.poll();
  while (frame.kind === "effects") {
    // Whole batch performed concurrently — this is where async lives.
    const results = await Promise.all(frame.effects.map((e) => interpret(e)));
    await machine.feed(results);
    frame = await machine.poll();
  }
  return frame.output;
}
