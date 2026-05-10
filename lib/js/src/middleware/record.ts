// record + replay — capture (request, reply) pairs to a tape, replay them
// later. Lets you turn a real conversation into a deterministic test fixture
// without writing scenario JSON by hand.
//
// Tape format: NDJSON, one entry per line:
//   { "request": <ProviderSendOptions>, "reply": <Reply> }

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface TapeEntry {
  readonly request: ProviderSendOptions;
  readonly reply: Reply;
}

export interface TapeWriter {
  /** Persist a single entry. May be async. */
  write(entry: TapeEntry): void | Promise<void>;
}

export interface TapeReader {
  /** Return all entries currently in the tape. */
  read(): readonly TapeEntry[];
}

export interface RecordOptions {
  /** A writer for entries. For Bun/Node, use {@link fileTapeWriter}. */
  readonly writer: TapeWriter;
}

export interface ReplayOptions {
  /** Source of recorded entries. */
  readonly reader: TapeReader;
  /** Match strategy. Default: exact-by-key (model + conversation + tools). */
  readonly match?: (req: ProviderSendOptions, candidates: readonly TapeEntry[]) => TapeEntry | undefined;
}

/** Wrap a Provider so every successful `send` call is appended to the tape. */
export function record(provider: Provider, opts: RecordOptions): Provider {
  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      const reply = await provider.send(req);
      await opts.writer.write({ request: req, reply });
      return reply;
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      // Streaming recording is more involved (need to materialise the full
      // assembled reply). Defer to the underlying provider for now and skip.
      return provider.sendStream(req);
    },
  };
}

/** A Provider that returns recorded entries instead of making real calls. */
export function replay(opts: ReplayOptions): Provider {
  const match = opts.match ?? defaultMatch;
  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      const entries = opts.reader.read();
      const hit = match(req, entries);
      if (!hit) {
        throw new Error("luv-js: replay: no tape entry matches the request");
      }
      return hit.reply;
    },
    sendStream(_req: ProviderStreamOptions): LuvStream {
      throw new Error("luv-js: replay: streaming replay is not yet supported");
    },
  };
}

function defaultMatch(
  req: ProviderSendOptions,
  candidates: readonly TapeEntry[],
): TapeEntry | undefined {
  const key = stableKey(req);
  return candidates.find((e) => stableKey(e.request) === key);
}

function stableKey(req: ProviderSendOptions): string {
  return JSON.stringify({
    model: req.model,
    conversation: req.conversation,
    tools: req.tools?.map((t) => ({ name: t.name, schema: t.inputSchema })),
  });
}

/** In-memory tape — useful for tests and short-lived recordings. */
export function memoryTape(initial: TapeEntry[] = []): TapeWriter & TapeReader {
  const entries: TapeEntry[] = [...initial];
  return {
    write(e) {
      entries.push(e);
    },
    read() {
      return entries;
    },
  };
}
