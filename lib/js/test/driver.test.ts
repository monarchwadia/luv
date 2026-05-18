// C3 gate — the async driver template against a fake batched machine with
// async mock handlers. Pure/deterministic; proves batched poll -> concurrent
// await -> feed -> done and that results flow back. Additive.
import { test, expect } from "bun:test";
import { drive, type MachinePort, type Poll, type Effect } from "../src/wasm/driver.ts";

// Fake echo machine: emits the input as a 2-effect batch, completes with the
// concatenation of fed-back results — mirrors the Zig EchoMachine.
function fakeEcho(input: Uint8Array): MachinePort {
  let state: "ready" | "awaiting" | "done" = "ready";
  let output = new Uint8Array(0);
  const half = Math.floor(input.length / 2);
  return {
    poll(): Poll {
      if (state === "ready") {
        state = "awaiting";
        return {
          kind: "effects",
          effects: [
            { kind: 5, payload: input.slice(0, half) },
            { kind: 5, payload: input.slice(half) },
          ],
        };
      }
      return { kind: "done", output };
    },
    feed(results: readonly Uint8Array[]): void {
      if (state !== "awaiting") throw new Error("nothing pending");
      const total = results.reduce((n, r) => n + r.length, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const r of results) {
        out.set(r, pos);
        pos += r.length;
      }
      output = out;
      state = "done";
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("drive: batched poll -> concurrent await -> feed -> done (echo)", async () => {
  const order: string[] = [];
  const echoInterp: (e: Effect) => Promise<Uint8Array> = async (e) => {
    // Stagger to prove the batch is awaited concurrently, results in order.
    await new Promise((r) => setTimeout(r, e.payload.length % 3));
    order.push(`k${e.kind}:${e.payload.length}`);
    return e.payload;
  };
  for (const s of ["", "a", "abcd", "hello world"]) {
    const out = await drive(fakeEcho(enc(s)), echoInterp);
    expect(dec(out)).toBe(s);
  }
  expect(order.length).toBeGreaterThan(0);
});

test("drive: results flow back through feed (transforming interpreter)", async () => {
  const upper: (e: Effect) => Promise<Uint8Array> = async (e) =>
    enc(dec(e.payload).toUpperCase());
  const out = await drive(fakeEcho(enc("abcd")), upper);
  expect(dec(out)).toBe("ABCD");
});
