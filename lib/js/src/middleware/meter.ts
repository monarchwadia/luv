// meter — accumulate token usage + call counts. Fires onUsage after every
// successful call with both the per-call delta and the running totals.

import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply, Usage } from "../types.ts";

export interface MeterEvent {
  readonly model: string;
  readonly kind: "send" | "sendStream";
  /** Usage from this single call (undefined if the provider didn't report it). */
  readonly usage: Usage | undefined;
  /** Running totals since the meter was created. */
  readonly totals: {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface MeterOptions {
  readonly onUsage: (event: MeterEvent) => void;
}

/** Wrap a Provider to count calls + tokens. */
export function meter(provider: Provider, opts: MeterOptions): Provider {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  function record(model: string, kind: MeterEvent["kind"], usage: Usage | undefined): void {
    calls++;
    if (usage) {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;
    }
    opts.onUsage({
      model,
      kind,
      usage,
      totals: { calls, promptTokens, completionTokens, totalTokens },
    });
  }

  return {
    async send(req: ProviderSendOptions): Promise<Reply> {
      const reply = await provider.send(req);
      record(req.model, "send", reply.usage);
      return reply;
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      const stream = provider.sendStream(req);
      stream.done.then(
        (reply) => record(req.model, "sendStream", reply.usage),
        () => {
          // skip metering for failed streams
        },
      );
      return stream;
    },
  };
}
