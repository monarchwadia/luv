// DX-6 red tests: structured error subclasses + classifyError.

import { test, expect } from "bun:test";
import {
  AuthError,
  ContentFilterError,
  ContextWindowExceededError,
  HttpError,
  RateLimitError,
  ServiceUnavailableError,
  classifyError,
} from "../src/errors.ts";

test("classifyError: 401 → AuthError", () => {
  const err = classifyError(401, "", null);
  expect(err).toBeInstanceOf(AuthError);
  expect(err).toBeInstanceOf(HttpError);
  expect(err.status).toBe(401);
});

test("classifyError: 429 → RateLimitError, exposes retryAfterMs from header value (numeric seconds)", () => {
  const err = classifyError(429, '{"error":{"message":"rate limited"}}', "30");
  expect(err).toBeInstanceOf(RateLimitError);
  expect(err.status).toBe(429);
  if (err instanceof RateLimitError) expect(err.retryAfterMs).toBe(30_000);
});

test("classifyError: 429 with HTTP-date Retry-After is parsed", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const err = classifyError(429, "", future);
  if (!(err instanceof RateLimitError)) throw new Error("expected RateLimitError");
  // Within 5s window of expected
  expect(err.retryAfterMs).toBeGreaterThan(50_000);
  expect(err.retryAfterMs).toBeLessThan(70_000);
});

test("classifyError: 400 with code=context_length_exceeded → ContextWindowExceededError", () => {
  const body = JSON.stringify({
    error: { message: "too long", code: "context_length_exceeded" },
  });
  const err = classifyError(400, body, null);
  expect(err).toBeInstanceOf(ContextWindowExceededError);
});

test("classifyError: 400 with type=content_filter → ContentFilterError", () => {
  const body = JSON.stringify({
    error: { message: "filtered", type: "content_filter_error" },
  });
  const err = classifyError(400, body, null);
  expect(err).toBeInstanceOf(ContentFilterError);
});

test("classifyError: 5xx → ServiceUnavailableError", () => {
  expect(classifyError(500, "", null)).toBeInstanceOf(ServiceUnavailableError);
  expect(classifyError(503, "", null)).toBeInstanceOf(ServiceUnavailableError);
});

test("classifyError: unknown 4xx falls back to plain HttpError", () => {
  const err = classifyError(418, "", null);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(AuthError);
  expect(err).not.toBeInstanceOf(RateLimitError);
  expect(err).not.toBeInstanceOf(ContextWindowExceededError);
});

test("HttpError carries status + body", () => {
  const err = new HttpError(500, "boom");
  expect(err.status).toBe(500);
  expect(err.body).toBe("boom");
  expect(err.message).toContain("500");
  expect(err.message).toContain("boom");
});

test("HttpError.hint is a generic non-empty string", () => {
  const err = new HttpError(500, "");
  expect(typeof err.hint).toBe("string");
  expect(err.hint.length).toBeGreaterThan(0);
});

test("AuthError.hint mentions the API key", () => {
  const err = new AuthError(401, "");
  expect(err.hint).toContain("API key");
});

test("RateLimitError.hint mentions retryAfterMs / backoff", () => {
  const err = new RateLimitError(429, "", 1000);
  expect(err.hint).toMatch(/retryAfterMs|backoff/i);
});

test("ContextWindowExceededError.hint mentions trimming/summarizing", () => {
  const err = new ContextWindowExceededError(400, "");
  expect(err.hint).toMatch(/trim|summariz/i);
});

test("ContentFilterError.hint mentions safety filters / modifying the prompt", () => {
  const err = new ContentFilterError(400, "");
  expect(err.hint).toMatch(/safety|filter|modify/i);
});

test("ServiceUnavailableError.hint mentions retry with backoff", () => {
  const err = new ServiceUnavailableError(503, "");
  expect(err.hint).toMatch(/retry|backoff/i);
});

test("classifyError: 403 also maps to AuthError (not just 401)", () => {
  expect(classifyError(403, "", null)).toBeInstanceOf(AuthError);
});

test("classifyError: RateLimitError without retry-after has retryAfterMs undefined", () => {
  const err = classifyError(429, "", null);
  if (!(err instanceof RateLimitError)) throw new Error("expected RateLimitError");
  expect(err.retryAfterMs).toBeUndefined();
});

test("classifyError: malformed JSON body still classifies by status alone", () => {
  // body isn't JSON; should still get the right subclass for the status.
  expect(classifyError(429, "definitely not json", null)).toBeInstanceOf(RateLimitError);
  expect(classifyError(401, "<html>error</html>", null)).toBeInstanceOf(AuthError);
  expect(classifyError(503, "Service Unavailable", null)).toBeInstanceOf(ServiceUnavailableError);
});

test("classifyError: 400 with content_filter (alternate spelling 'content_filter') is detected via code", () => {
  const body = JSON.stringify({ error: { code: "content_filter" } });
  expect(classifyError(400, body, null)).toBeInstanceOf(ContentFilterError);
});

test("classifyError: 599 (non-standard 5xx) still maps to ServiceUnavailableError", () => {
  expect(classifyError(599, "", null)).toBeInstanceOf(ServiceUnavailableError);
});

test("classifyError: 500 status with no body maps to ServiceUnavailableError", () => {
  const err = classifyError(500, "", null);
  expect(err).toBeInstanceOf(ServiceUnavailableError);
  expect(err.status).toBe(500);
});

test("classifyError: invalid retry-after value falls back to undefined retryAfterMs", () => {
  const err = classifyError(429, "", "garbage");
  if (!(err instanceof RateLimitError)) throw new Error("expected RateLimitError");
  expect(err.retryAfterMs).toBeUndefined();
});

test("classifyError: HTTP-date in the past clamps retryAfterMs to 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const err = classifyError(429, "", past);
  if (!(err instanceof RateLimitError)) throw new Error();
  expect(err.retryAfterMs).toBe(0);
});

test("HttpError.body holds the FULL body (not truncated like .message)", () => {
  const long = "x".repeat(500);
  const err = new HttpError(500, long);
  expect(err.body.length).toBe(500);
  // .message is truncated to <= 250 chars (200 body + prefix)
  expect(err.message.length).toBeLessThan(300);
});
