// Ergonomic <-> wasm bridge for the error-classification brick, over the
// synchronous wasm path. This is what errors.ts's `classifyError` will
// delegate to once the differential test proves equivalence.
//
// The error CLASSES (AuthError, RateLimitError, ...) are host objects and
// STAY in TS — only the classification DECISION (status + body +
// Retry-After + now → kind/retryAfterMs) moves to wasm. This file encodes
// the ABI, calls `luv_classify_error`, decodes the result, and constructs
// the SAME TS error subclass the port would.
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.
//
// Wasm export `luv_classify_error` ABI (verified against
// core/src/wasm_abi/exports.zig + core/src/morphisms/luv/error_classify.zig):
//   IN:  u32 status; u32 body_len; body(utf8); u8 ra_present;
//        [u32 ra_len; ra(utf8)]; i64 now_ms            (little-endian)
//   OUT: u8 kind; u16 status; u8 retry_present; [u64 retry_after_ms]
//   kind enum (0..5): auth, rate_limit, context_window_exceeded,
//                     content_filter, service_unavailable, http

import { callWasm } from "./sync.ts";
import {
  AuthError,
  RateLimitError,
  ContextWindowExceededError,
  ContentFilterError,
  ServiceUnavailableError,
  HttpError,
} from "../errors.ts";

const te = new TextEncoder();

/** Decoded result of the wasm classification decision. Mirrors the Zig
 *  `Classification` struct (kind/status/retry_after_ms). */
interface ClassificationResult {
  kind: number;
  status: number;
  retryAfterMs?: number;
}

/** Encode (status, body, Retry-After header, now_ms) into the
 *  `luv_classify_error` IN buffer. */
function encode(
  status: number,
  body: string,
  retryAfterHeader: string | null,
  nowMs: number,
): Uint8Array {
  const bodyBytes = te.encode(body);
  const raBytes =
    retryAfterHeader !== null ? te.encode(retryAfterHeader) : null;

  const total =
    4 + // u32 status
    4 + // u32 body_len
    bodyBytes.length + // body
    1 + // u8 ra_present
    (raBytes !== null ? 4 + raBytes.length : 0) + // [u32 ra_len; ra]
    8; // i64 now_ms

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let pos = 0;

  dv.setUint32(pos, status >>> 0, true);
  pos += 4;
  dv.setUint32(pos, bodyBytes.length, true);
  pos += 4;
  buf.set(bodyBytes, pos);
  pos += bodyBytes.length;
  buf[pos] = raBytes !== null ? 1 : 0;
  pos += 1;
  if (raBytes !== null) {
    dv.setUint32(pos, raBytes.length, true);
    pos += 4;
    buf.set(raBytes, pos);
    pos += raBytes.length;
  }
  dv.setBigInt64(pos, BigInt(nowMs), true);
  pos += 8;

  return buf;
}

/** Decode the `luv_classify_error` OUT buffer. */
function decode(out: Uint8Array): ClassificationResult {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const kind = dv.getUint8(0);
  const status = dv.getUint16(1, true);
  const retryPresent = dv.getUint8(3);
  if (retryPresent !== 0) {
    const retryAfterMs = Number(dv.getBigUint64(4, true));
    return { kind, status, retryAfterMs };
  }
  return { kind, status };
}

/** Map the wasm kind discriminant to the matching host error subclass.
 *  Order is fixed by the Zig `ErrorKind` enum (see error_classify.zig). */
function construct(
  kind: number,
  status: number,
  body: string,
  retryAfterMs: number | undefined,
): HttpError {
  switch (kind) {
    case 0:
      return new AuthError(status, body);
    case 1:
      return new RateLimitError(status, body, retryAfterMs);
    case 2:
      return new ContextWindowExceededError(status, body);
    case 3:
      return new ContentFilterError(status, body);
    case 4:
      return new ServiceUnavailableError(status, body);
    case 5:
    default:
      return new HttpError(status, body);
  }
}

/** Single-sourced replacement for the TS `classifyError`: the decision is
 *  made in wasm; the returned object is the identical host error class the
 *  port produced. Signature matches `classifyError` in ../errors.ts. */
export function classifyErrorViaWasm(
  status: number,
  body: string,
  retryAfterHeader: string | null,
): HttpError {
  const out = callWasm(
    "luv_classify_error",
    encode(status, body, retryAfterHeader, Date.now()),
  );
  const r = decode(out);
  return construct(r.kind, r.status, body, r.retryAfterMs);
}
