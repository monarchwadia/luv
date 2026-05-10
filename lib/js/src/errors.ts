// Structured HTTP errors for upstream-LLM responses. `classifyError` maps an
// HTTP status + response body + Retry-After header to the most specific
// subclass. Callers can `instanceof` these to handle each cleanly.

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `luv-js: HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.status = status;
    this.body = body;
    this.name = "HttpError";
  }
}

export class AuthError extends HttpError {
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (auth): ${truncate(body)}`);
    this.name = "AuthError";
  }
}

export class RateLimitError extends HttpError {
  /** Milliseconds the caller should wait before retrying, if known. */
  readonly retryAfterMs: number | undefined;
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

export class ContextWindowExceededError extends HttpError {
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (context window exceeded): ${truncate(body)}`);
    this.name = "ContextWindowExceededError";
  }
}

export class ContentFilterError extends HttpError {
  constructor(status: number, body: string) {
    super(status, body, `luv-js: HTTP ${status} (content filter): ${truncate(body)}`);
    this.name = "ContentFilterError";
  }
}

export class ServiceUnavailableError extends HttpError {
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

/** Map an HTTP response into a typed error subclass. */
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
