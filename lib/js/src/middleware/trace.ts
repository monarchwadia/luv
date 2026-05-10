// trace — observe each Provider call. Emits a Span with timing + status
// (or error) regardless of success/failure.

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface Span {
  readonly kind: "send" | "sendStream";
  readonly model: string;
  readonly conversationLength: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: Error;
}

export interface TraceOptions {
  readonly onSpan: (span: Span) => void;
}

/** Wrap a Provider to emit a `Span` after every send / sendStream call. */
export function trace(provider: Provider, opts: TraceOptions): Provider {
  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      const start = performance.now();
      try {
        const reply = await provider.send(req);
        opts.onSpan({
          kind: "send",
          model: req.model,
          conversationLength: req.conversation.length,
          durationMs: performance.now() - start,
          ok: true,
        });
        return reply;
      } catch (err) {
        opts.onSpan({
          kind: "send",
          model: req.model,
          conversationLength: req.conversation.length,
          durationMs: performance.now() - start,
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        throw err;
      }
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      const start = performance.now();
      const stream = provider.sendStream(req);
      stream.done.then(
        () => {
          opts.onSpan({
            kind: "sendStream",
            model: req.model,
            conversationLength: req.conversation.length,
            durationMs: performance.now() - start,
            ok: true,
          });
        },
        (err: unknown) => {
          opts.onSpan({
            kind: "sendStream",
            model: req.model,
            conversationLength: req.conversation.length,
            durationMs: performance.now() - start,
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        },
      );
      return stream;
    },
  };
}
