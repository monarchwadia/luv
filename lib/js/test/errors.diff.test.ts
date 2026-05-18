// Differential gate for the error-classification brick swap.
// Compares the TS port (errors.ts `classifyError`) against the wasm path
// (errors_bridge `classifyErrorViaWasm`) over a representative equivalence
// set. Its JOB is to enumerate divergences BEFORE the wrapper flips —
// nothing is swapped/deleted until this is green. Additive; no existing
// test touched.
import { test, expect } from "bun:test";
import {
  classifyError,
  AuthError,
  RateLimitError,
  ContextWindowExceededError,
  ContentFilterError,
  ServiceUnavailableError,
  HttpError,
  type HttpError as HttpErrorT,
} from "../src/errors.ts";
import { classifyErrorViaWasm } from "../src/wasm/errors_bridge.ts";

// The subclass each error maps to, used for class-identity comparison
// independent of construction-time fields that differ by call instant
// (e.g. HTTP-date retryAfterMs depends on Date.now()).
function tag(e: HttpErrorT): string {
  if (e instanceof AuthError) return "AuthError";
  if (e instanceof RateLimitError) return "RateLimitError";
  if (e instanceof ContextWindowExceededError)
    return "ContextWindowExceededError";
  if (e instanceof ContentFilterError) return "ContentFilterError";
  if (e instanceof ServiceUnavailableError) return "ServiceUnavailableError";
  if (e instanceof HttpError) return "HttpError";
  return "unknown";
}

const cases: {
  name: string;
  status: number;
  body: string;
  ra: string | null;
}[] = [
  { name: "401 → auth", status: 401, body: "", ra: null },
  { name: "403 → auth", status: 403, body: "", ra: null },
  {
    name: "401 with non-JSON body",
    status: 401,
    body: "<html>error</html>",
    ra: null,
  },
  {
    name: "429 numeric Retry-After",
    status: 429,
    body: '{"error":{"message":"rate limited"}}',
    ra: "30",
  },
  {
    name: "429 numeric Retry-After with whitespace",
    status: 429,
    body: "",
    ra: "  12  ",
  },
  { name: "429 no Retry-After", status: 429, body: "", ra: null },
  {
    name: "429 garbage Retry-After",
    status: 429,
    body: "",
    ra: "garbage",
  },
  {
    name: "429 malformed-JSON body",
    status: 429,
    body: "definitely not json",
    ra: null,
  },
  {
    name: "400 context_length_exceeded",
    status: 400,
    body: JSON.stringify({
      error: { message: "too long", code: "context_length_exceeded" },
    }),
    ra: null,
  },
  {
    name: "400 content_filter_error (type)",
    status: 400,
    body: JSON.stringify({
      error: { message: "filtered", type: "content_filter_error" },
    }),
    ra: null,
  },
  {
    name: "400 content_filter (alt code spelling)",
    status: 400,
    body: JSON.stringify({ error: { code: "content_filter" } }),
    ra: null,
  },
  {
    name: "400 unrelated error code → http",
    status: 400,
    body: JSON.stringify({ error: { code: "invalid_request" } }),
    ra: null,
  },
  {
    name: "400 non-JSON body → http",
    status: 400,
    body: "bad request",
    ra: null,
  },
  { name: "500 no body", status: 500, body: "", ra: null },
  {
    name: "503 with text body",
    status: 503,
    body: "Service Unavailable",
    ra: null,
  },
  { name: "599 non-standard 5xx", status: 599, body: "", ra: null },
  { name: "418 unknown 4xx → http", status: 418, body: "", ra: null },
  {
    name: "500 + context code (status wins)",
    status: 500,
    body: JSON.stringify({ error: { code: "context_length_exceeded" } }),
    ra: null,
  },
];

for (const c of cases) {
  test(`classifyError parity: ${c.name}`, () => {
    const port = classifyError(c.status, c.body, c.ra);
    const wasm = classifyErrorViaWasm(c.status, c.body, c.ra);

    expect(tag(wasm)).toBe(tag(port));
    expect(wasm.status).toBe(port.status);
    expect(wasm.body).toBe(port.body);
    expect(wasm.message).toBe(port.message);

    if (port instanceof RateLimitError && wasm instanceof RateLimitError) {
      expect(wasm.retryAfterMs).toBe(port.retryAfterMs);
    }
  });
}

// HTTP-date Retry-After: both implementations resolve `date - now`. The TS
// port and the bridge each call Date.now() at slightly different instants,
// so retryAfterMs may differ by a few ms — class/status must match exactly
// and retryAfterMs must agree within a tolerance window.
test("classifyError parity: 429 future HTTP-date Retry-After", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const port = classifyError(429, "", future);
  const wasm = classifyErrorViaWasm(429, "", future);

  expect(tag(wasm)).toBe("RateLimitError");
  expect(tag(port)).toBe("RateLimitError");
  if (!(port instanceof RateLimitError) || !(wasm instanceof RateLimitError))
    throw new Error("expected RateLimitError");
  expect(port.retryAfterMs).toBeGreaterThan(50_000);
  expect(wasm.retryAfterMs).toBeGreaterThan(50_000);
  // Within a generous instant-skew window of each other.
  expect(Math.abs((wasm.retryAfterMs ?? 0) - (port.retryAfterMs ?? 0))).toBeLessThan(
    2_000,
  );
});

test("classifyError parity: 429 past HTTP-date Retry-After clamps to 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const port = classifyError(429, "", past);
  const wasm = classifyErrorViaWasm(429, "", past);

  expect(tag(wasm)).toBe("RateLimitError");
  if (!(port instanceof RateLimitError) || !(wasm instanceof RateLimitError))
    throw new Error("expected RateLimitError");
  expect(port.retryAfterMs).toBe(0);
  expect(wasm.retryAfterMs).toBe(0);
});
