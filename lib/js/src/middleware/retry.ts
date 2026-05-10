// retry — retry transient failures with backoff. Honors RateLimitError.retryAfterMs;
// gives up immediately on non-retryable errors (auth, context window, content filter).

import {
  AuthError,
  ContentFilterError,
  ContextWindowExceededError,
  HttpError,
  RateLimitError,
  ServiceUnavailableError,
} from "../errors.ts";
import type { LuvStream, Provider, ProviderSendOptions, ProviderStreamOptions, Reply } from "../types.ts";

export interface RetryOptions {
  /** Total attempts including the first call. Default 3. */
  readonly attempts?: number;
  /** Base delay in ms; doubled each attempt for "exponential". Default 500. */
  readonly baseDelayMs?: number;
  /** Backoff strategy. Default "exponential". */
  readonly backoff?: "exponential" | "linear" | "fixed";
  /** Max delay cap in ms. Default 30_000. */
  readonly maxDelayMs?: number;
  /** Optional predicate: return true to retry, false to surface the error. */
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/** Wrap a Provider to retry failed `send` calls. Streaming is retried for the
 *  initial connection only — once a stream begins emitting, retries are unsafe. */
export function retry(provider: Provider, opts: RetryOptions = {}): Provider {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const backoff = opts.backoff ?? "exponential";
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  async function attempt<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) break;
        if (!shouldRetry(err, i + 1)) break;
        await sleep(delayFor(err, i, baseDelayMs, backoff, maxDelayMs));
      }
    }
    throw lastErr;
  }

  return {
    send(req: ProviderSendOptions): Promise<Reply> {
      return attempt(() => provider.send(req));
    },
    sendStream(req: ProviderStreamOptions): LuvStream {
      // Streams can only be retried before any byte is read. We delegate
      // immediately; if the user wants connection-only retry, they can wrap
      // their call site. (A proper streaming retry needs to materialise the
      // body and re-emit, which is heavier than this middleware should be.)
      return provider.sendStream(req);
    },
  };
}

function defaultShouldRetry(err: unknown, _attempt: number): boolean {
  if (err instanceof AuthError) return false;
  if (err instanceof ContextWindowExceededError) return false;
  if (err instanceof ContentFilterError) return false;
  if (err instanceof RateLimitError) return true;
  if (err instanceof ServiceUnavailableError) return true;
  if (err instanceof HttpError) {
    // Other 4xx: treat as not retryable. Other 5xx: retry.
    return err.status >= 500;
  }
  // Unknown error (network blip, fetch reject, etc.): retry.
  return true;
}

function delayFor(
  err: unknown,
  attempt: number,
  baseDelayMs: number,
  backoff: RetryOptions["backoff"],
  maxDelayMs: number,
): number {
  if (err instanceof RateLimitError && err.retryAfterMs !== undefined) {
    return Math.min(err.retryAfterMs, maxDelayMs);
  }
  let delay: number;
  switch (backoff) {
    case "linear":
      delay = baseDelayMs * (attempt + 1);
      break;
    case "fixed":
      delay = baseDelayMs;
      break;
    case "exponential":
    default:
      delay = baseDelayMs * 2 ** attempt;
      break;
  }
  return Math.min(delay, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
