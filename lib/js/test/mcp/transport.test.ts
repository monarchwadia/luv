// Audit: MCP transport framing — exercises wireUpTransport directly with
// a controllable ReadableStream so we cover the line-splitting logic
// without spawning a subprocess.

import { test, expect } from "bun:test";
import { wireUpTransport } from "../../src/mcp/transport.ts";
import type { JsonRpcMessage } from "../../src/mcp/types.ts";

interface Harness {
  pushBytes(bytes: Uint8Array): void;
  pushString(s: string): void;
  endStream(): void;
  errorStream(err: Error): void;
  written: Uint8Array[];
  closed: boolean;
}

function makeHarness(): { transport: ReturnType<typeof wireUpTransport>; harness: Harness } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  const written: Uint8Array[] = [];
  let closed = false;
  const transport = wireUpTransport(
    async (bytes) => { written.push(bytes); },
    stream,
    async () => { closed = true; },
  );
  return {
    transport,
    harness: {
      pushBytes(bytes) { controller!.enqueue(bytes); },
      pushString(s) { controller!.enqueue(new TextEncoder().encode(s)); },
      endStream() { controller!.close(); },
      errorStream(err) { controller!.error(err); },
      written,
      get closed() { return closed; },
    },
  };
}

/** Wait until N messages have arrived (or timeout). */
function waitFor<T>(getter: () => T[], n: number, timeoutMs = 200): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const items = getter();
      if (items.length >= n) return resolve(items);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${n} items, got ${items.length}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Send path

test("transport.send: writes JSON-RPC message + newline", async () => {
  const { transport, harness } = makeHarness();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  expect(harness.written.length).toBe(1);
  const text = new TextDecoder().decode(harness.written[0]);
  expect(text.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(text);
  expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
});

test("transport.send: each call is its own newline-delimited line", async () => {
  const { transport, harness } = makeHarness();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
  await transport.send({ jsonrpc: "2.0", id: 2, method: "b" });
  expect(harness.written.length).toBe(2);
  expect(new TextDecoder().decode(harness.written[0])).toBe('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
  expect(new TextDecoder().decode(harness.written[1])).toBe('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
});

// ---------------------------------------------------------------------------
// Receive path — framing across chunk boundaries

test("transport.onMessage: single complete line yields one message", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  harness.pushString('{"jsonrpc":"2.0","id":1,"result":{"x":1}}\n');
  const msgs = await waitFor(() => received, 1);
  expect(msgs[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { x: 1 } });
});

test("transport.onMessage: multiple lines in one chunk yield multiple messages", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  harness.pushString(
    '{"jsonrpc":"2.0","id":1,"result":1}\n' +
    '{"jsonrpc":"2.0","id":2,"result":2}\n' +
    '{"jsonrpc":"2.0","id":3,"result":3}\n',
  );
  const msgs = await waitFor(() => received, 3);
  expect(msgs.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
});

test("transport.onMessage: line split across chunks is buffered until newline arrives", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  harness.pushString('{"jsonrpc":"2.0","id":1,"');
  // Wait a tick — nothing should be delivered yet.
  await new Promise((r) => setTimeout(r, 20));
  expect(received.length).toBe(0);
  harness.pushString('result":42}\n');
  const msgs = await waitFor(() => received, 1);
  expect((msgs[0] as { result: number }).result).toBe(42);
});

test("transport.onMessage: blank lines between messages are ignored", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  harness.pushString(
    '\n\n' +
    '{"jsonrpc":"2.0","id":1,"result":1}\n' +
    '\n' +
    '{"jsonrpc":"2.0","id":2,"result":2}\n',
  );
  const msgs = await waitFor(() => received, 2);
  expect(msgs.length).toBe(2);
});

test("transport.onMessage: multi-byte UTF-8 character split across chunks decodes correctly", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  // The "🚀" rocket is 4 bytes in UTF-8 (0xF0 0x9F 0x9A 0x80).
  // Split it across two chunk boundaries.
  const json = '{"jsonrpc":"2.0","id":1,"result":"🚀"}\n';
  const all = new TextEncoder().encode(json);
  // Find where the rocket bytes fall and split mid-character.
  const rocketStart = all.indexOf(0xf0);
  expect(rocketStart).toBeGreaterThan(0);
  harness.pushBytes(all.slice(0, rocketStart + 2));   // first 2 bytes of rocket
  harness.pushBytes(all.slice(rocketStart + 2));      // remaining 2 bytes + rest of line
  const msgs = await waitFor(() => received, 1);
  expect((msgs[0] as { result: string }).result).toBe("🚀");
});

test("transport.onError: malformed JSON line surfaces an error, parsing continues", async () => {
  const { transport, harness } = makeHarness();
  const received: JsonRpcMessage[] = [];
  const errors: Error[] = [];
  transport.onMessage((m) => received.push(m));
  transport.onError((e) => errors.push(e));
  harness.pushString(
    'not actually json\n' +
    '{"jsonrpc":"2.0","id":1,"result":1}\n',
  );
  const msgs = await waitFor(() => received, 1);
  expect(errors.length).toBe(1);
  expect(errors[0]?.message).toContain("malformed JSON");
  expect((msgs[0] as { id: number }).id).toBe(1);
});

test("transport.onError: stream errors are delivered to onError when not closed", async () => {
  const { transport, harness } = makeHarness();
  const errors: Error[] = [];
  transport.onError((e) => errors.push(e));
  harness.errorStream(new Error("stream broke"));
  await new Promise((r) => setTimeout(r, 20));
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]?.message).toContain("stream broke");
});

// ---------------------------------------------------------------------------
// Close path

test("transport.close: invokes the underlying close fn (idempotency safe)", async () => {
  const { transport, harness } = makeHarness();
  expect(harness.closed).toBe(false);
  await transport.close();
  expect(harness.closed).toBe(true);
});

test("transport.close: stream-end errors after close don't fire onError", async () => {
  const { transport, harness } = makeHarness();
  const errors: Error[] = [];
  transport.onError((e) => errors.push(e));
  await transport.close();
  // Errors that come after close are suppressed.
  harness.errorStream(new Error("post-close"));
  await new Promise((r) => setTimeout(r, 20));
  expect(errors.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Receive path — handlers can be set after data arrives

test("transport.onMessage: handler is invoked even when registered after first chunk arrives", async () => {
  const { transport, harness } = makeHarness();
  // Push data BEFORE handler is registered. Note: with the current design,
  // messages received before onMessage is set are silently dropped (handler
  // is null). This test pins that behavior so a future "buffer until handler
  // is set" change is intentional, not accidental.
  harness.pushString('{"jsonrpc":"2.0","id":1,"result":"early"}\n');
  await new Promise((r) => setTimeout(r, 20));
  const received: JsonRpcMessage[] = [];
  transport.onMessage((m) => received.push(m));
  // After registering, push a new message — that one should arrive.
  harness.pushString('{"jsonrpc":"2.0","id":2,"result":"late"}\n');
  const msgs = await waitFor(() => received, 1);
  expect((msgs[0] as { id: number }).id).toBe(2);
  expect(received.length).toBe(1);  // confirms early one was dropped
});
