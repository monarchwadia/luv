// MCP transport interface + stdio implementation for Bun / Node.
//
// Stdio MCP servers are subprocesses that read newline-delimited JSON from
// stdin and write newline-delimited JSON to stdout. Stderr is left alone
// (server logs).

import type { JsonRpcMessage } from "./types.ts";

export interface McpTransport {
  /** Send a single JSON-RPC message. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Register a handler for incoming messages. Called once per inbound message. */
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  /** Register a handler for transport-level errors. */
  onError(handler: (err: Error) => void): void;
  /** Tear down the transport. Idempotent. */
  close(): Promise<void>;
}

export interface StdioTransportOptions {
  /** Command to spawn. */
  readonly command: string;
  /** Arguments to pass to the command. */
  readonly args?: readonly string[];
  /** Extra environment vars merged into the child's env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for the spawned process. Default: parent's cwd. */
  readonly cwd?: string;
}

/** Spawn an MCP server as a subprocess and wire stdio to a transport.
 *
 * Works in Bun (uses Bun.spawn) and Node (falls back to node:child_process).
 * Browser is unsupported. */
export async function stdioTransport(opts: StdioTransportOptions): Promise<McpTransport> {
  // Detect Bun first; otherwise fall back to node:child_process.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return spawnViaBun(opts);
  }
  return spawnViaNode(opts);
}

async function spawnViaBun(opts: StdioTransportOptions): Promise<McpTransport> {
  // Cast through `unknown` so this file stays buildable on Node where Bun
  // globals don't exist; runtime guard above ensures we only get here on Bun.
  const BunGlobal = (globalThis as unknown as {
    Bun: { spawn: (...args: unknown[]) => unknown };
  }).Bun;
  const procEnv = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const proc = BunGlobal.spawn([opts.command, ...(opts.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    ...(opts.cwd && { cwd: opts.cwd }),
    ...(opts.env && { env: { ...procEnv, ...opts.env } }),
  } as unknown) as {
    stdin: { write: (data: Uint8Array) => Promise<number>; end: () => Promise<void> };
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill: () => void;
  };

  return wireUpTransport(
    async (bytes) => {
      await proc.stdin.write(bytes);
    },
    proc.stdout,
    async () => {
      try { proc.kill(); } catch { /* ignore */ }
      try { await proc.stdin.end(); } catch { /* ignore */ }
    },
  );
}

async function spawnViaNode(opts: StdioTransportOptions): Promise<McpTransport> {
  // Dynamic imports cast through `unknown` so this stays buildable on Bun-only
  // bundles where node:* modules aren't present.
  const cp = (await import("node:child_process")) as unknown as {
    spawn: (cmd: string, args: string[], opts: unknown) => {
      stdin: { write: (data: Uint8Array, cb: (err?: Error) => void) => void; end: () => void } | null;
      stdout: unknown;
      kill: () => void;
    };
  };
  const procEnv = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const child = cp.spawn(opts.command, opts.args ? [...opts.args] : [], {
    stdio: ["pipe", "pipe", "inherit"],
    ...(opts.cwd && { cwd: opts.cwd }),
    env: { ...procEnv, ...opts.env },
  });
  if (!child.stdin || !child.stdout) {
    throw new Error("luv-js mcp: failed to open subprocess stdio");
  }

  // Wrap Node's stdout (Readable) in a Web ReadableStream so our framing code
  // can stay portable. Node 18+ provides Readable.toWeb.
  const streamMod = (await import("node:stream")) as unknown as {
    Readable: { toWeb: (r: unknown) => ReadableStream<Uint8Array> };
  };
  const stdout: ReadableStream<Uint8Array> = streamMod.Readable.toWeb(child.stdout);
  const stdin = child.stdin;

  return wireUpTransport(
    async (bytes) => {
      await new Promise<void>((resolve, reject) => {
        stdin.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    },
    stdout,
    async () => {
      try { child.kill(); } catch { /* ignore */ }
      try { stdin.end(); } catch { /* ignore */ }
    },
  );
}

/** Common framing logic: take a write fn + readable stdout, expose McpTransport.
 *  Exported so tests can drive framing without a real subprocess. */
export function wireUpTransport(
  writeBytes: (bytes: Uint8Array) => Promise<void>,
  stdout: ReadableStream<Uint8Array>,
  closeFn: () => Promise<void>,
): McpTransport {
  // Boxed in object so TS doesn't narrow them to `never` inside nested
  // closures after they're reassigned via the public setters below.
  const handlers: {
    onMessage: ((msg: JsonRpcMessage) => void) | null;
    onError: ((err: Error) => void) | null;
  } = { onMessage: null, onError: null };
  let closed = false;
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });

  // Background read loop.
  (async () => {
    const reader = stdout.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(line) as JsonRpcMessage;
          } catch {
            handlers.onError?.(new Error(`mcp: malformed JSON line: ${line.slice(0, 200)}`));
            continue;
          }
          handlers.onMessage?.(msg);
        }
      }
    } catch (err) {
      if (!closed) handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })().catch((err) => {
    if (!closed) handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    async send(msg) {
      const line = JSON.stringify(msg) + "\n";
      await writeBytes(enc.encode(line));
    },
    onMessage(handler) {
      handlers.onMessage = handler;
    },
    onError(handler) {
      handlers.onError = handler;
    },
    async close() {
      closed = true;
      await closeFn();
    },
  };
}
