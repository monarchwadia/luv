// Structured HTTP errors for upstream-LLM responses. `classifyError` maps an
// HTTP status + response body + Retry-After header to the most specific
// subclass. Callers can `instanceof` these to handle each cleanly.

/** Base class for any upstream HTTP failure from a provider.
 *
 * The `message` is truncated for display; the full response body is on
 * `.body`. Subclasses (`AuthError`, `RateLimitError`,
 * `ContextWindowExceededError`, `ContentFilterError`,
 * `ServiceUnavailableError`) discriminate the common failure modes. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  /** Human/LLM-actionable recovery suggestion. Subclasses override with specifics. */
  readonly hint: string =
    "Check the response body for provider-specific details.";
  constructor(status: number, body: string, message?: string) {
    super(message ?? `luv-js: HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.status = status;
    this.body = body;
    this.name = "HttpError";
  }
}

/** Thrown for HTTP 401/403 — the API key is missing, malformed, or unauthorized. */
export class AuthError extends HttpError {
  override readonly hint = "Check your API key and try again.";
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (auth): ${truncate(body)}`);
    this.name = "AuthError";
  }
}

/** Thrown for HTTP 429 — rate-limited. `retryAfterMs` is parsed from the
 *  `Retry-After` header (integer seconds or HTTP-date) when present. */
export class RateLimitError extends HttpError {
  /** Milliseconds the caller should wait before retrying, if known. */
  readonly retryAfterMs: number | undefined;
  override readonly hint =
    "Wait `retryAfterMs` and retry, or back off exponentially if no retry-after header was sent.";
  constructor(status: number, body: string, retryAfterMs?: number) {
    super(
      status,
      body,
      `luv-js: HTTP ${status} (rate limited${retryAfterMs ? `, retry after ${retryAfterMs}ms` : ""}): ${truncate(body)}`,
    );
    this.retryAfterMs = retryAfterMs;
    this.name = "RateLimitError";
  }
}

/** Thrown for HTTP 400 with `code: "context_length_exceeded"` — the
 *  conversation + reply would exceed the model's context window. */
export class ContextWindowExceededError extends HttpError {
  override readonly hint =
    "Trim or summarize the conversation before retrying.";
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (context window exceeded): ${truncate(body)}`);
    this.name = "ContextWindowExceededError";
  }
}

/** Thrown for HTTP 400 with `type: "content_filter_error"` — the request
 *  was rejected by the provider's safety filters. */
export class ContentFilterError extends HttpError {
  override readonly hint =
    "The content was rejected by the provider's safety filters; modify the prompt or contact provider support.";
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (content filter): ${truncate(body)}`);
    this.name = "ContentFilterError";
  }
}

/** Thrown for HTTP 5xx — the provider is unhealthy. Safe to retry with
 *  exponential backoff. */
export class ServiceUnavailableError extends HttpError {
  override readonly hint =
    "Provider temporarily unavailable; retry with exponential backoff.";
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (service unavailable): ${truncate(body)}`);
    this.name = "ServiceUnavailableError";
  }
}

function truncate(s: string, n = 200): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

interface ErrorBodyShape {
  error?: { message?: string; type?: string; code?: string };
}

/** Map an HTTP failure (status + body + retry-after header) into the most
 *  specific {@link HttpError} subclass. Used internally by `send` /
 *  `sendStream`; exposed so consumers can call it from custom transport code.
 *
 *  - 401, 403         → `AuthError`
 *  - 429              → `RateLimitError` (with `retryAfterMs` parsed)
 *  - 400 + context_length_exceeded → `ContextWindowExceededError`
 *  - 400 + content_filter_error    → `ContentFilterError`
 *  - 5xx              → `ServiceUnavailableError`
 *  - anything else    → `HttpError`
 */
export function classifyError(
  status: number,
  body: string,
  retryAfterHeader: string | null,
): HttpError {
  let parsed: ErrorBodyShape | undefined;
  if (body) {
    try {
      parsed = JSON.parse(body) as ErrorBodyShape;
    } catch {
      // body wasn't JSON; fall through with parsed=undefined
    }
  }

  const code = parsed?.error?.code;
  const type = parsed?.error?.type;

  if (status === 401 || status === 403) {
    return new AuthError(status, body);
  }
  if (status === 429) {
    return new RateLimitError(status, body, parseRetryAfter(retryAfterHeader));
  }
  if (status === 400 && code === "context_length_exceeded") {
    return new ContextWindowExceededError(status, body);
  }
  if (status === 400 && (type === "content_filter_error" || code === "content_filter")) {
    return new ContentFilterError(status, body);
  }
  if (status >= 500 && status < 600) {
    return new ServiceUnavailableError(status, body);
  }
  return new HttpError(status, body);
}

/** Parse a Retry-After header into milliseconds. Supports numeric seconds and HTTP-date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
