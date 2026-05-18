// Ergonomic <-> codec bridge for the tool_args brick, over the synchronous
// wasm path. This is what tool_args.ts's parseArguments will delegate to once
// the differential test proves equivalence with the TS port.
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.
//
// Wasm export: `luv_validate_tool_args`.
//   IN:  u32 args_len; args(JSON utf8); u8 schema_present;
//        [u32 schema_len; schema(JSON utf8)]   (little-endian)
//   OUT: u8 status (0=ok, 1=invalid, 2=bad-input);
//        if status != 0: u32 msg_len; msg(utf8)
//
// On status 0 the args value is returned unchanged (identity — same contract
// as the TS port). On status 1 a `ToolArgsError` is thrown reconstructed from
// the wasm's fully-formatted message so `.path` / `.message` / `.name` match
// the existing class contract exactly. Status 2 (bad input) throws a plain
// Error — the TS port never produced this (it parses no JSON), so it only
// arises on a genuine encode bug and must surface loudly.

import { callWasm } from "./sync.ts";
import { ToolArgsError } from "../tool_args.ts";

const te = new TextEncoder();
const td = new TextDecoder();

// Mirror of the Zig `fail` formatter:
//   "luv-js: parseArguments failed at ${path || "<root>"}: ${message}"
// We split it back into (path, message) so `new ToolArgsError(path, message)`
// regenerates the byte-identical string and preserves `.path` / `.message`.
const FULL_PREFIX = "luv-js: parseArguments failed at ";

function toolArgsErrorFromFull(full: string): ToolArgsError {
  if (full.startsWith(FULL_PREFIX)) {
    const rest = full.slice(FULL_PREFIX.length);
    const sep = rest.indexOf(": ");
    if (sep !== -1) {
      const shownPath = rest.slice(0, sep);
      const message = rest.slice(sep + 2);
      const path = shownPath === "<root>" ? "" : shownPath;
      return new ToolArgsError(path, message);
    }
  }
  // Defensive: unrecognized shape — preserve the message verbatim at <root>.
  return new ToolArgsError("", full);
}

function encode(args: unknown, schema: unknown | undefined): Uint8Array {
  const argsBytes = te.encode(JSON.stringify(args));
  const hasSchema = schema !== undefined && schema !== null;
  const schemaBytes = hasSchema
    ? te.encode(JSON.stringify(schema))
    : new Uint8Array(0);

  const total =
    4 + argsBytes.length + 1 + (hasSchema ? 4 + schemaBytes.length : 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  let pos = 0;
  dv.setUint32(pos, argsBytes.length, true);
  pos += 4;
  buf.set(argsBytes, pos);
  pos += argsBytes.length;
  buf[pos] = hasSchema ? 1 : 0;
  pos += 1;
  if (hasSchema) {
    dv.setUint32(pos, schemaBytes.length, true);
    pos += 4;
    buf.set(schemaBytes, pos);
    pos += schemaBytes.length;
  }
  return buf;
}

/** Synchronous: validate `args` against `schema` via wasm.
 *
 * Returns `args` unchanged on success (identity, matching the TS port).
 * Throws `ToolArgsError` on schema-validation failure (status 1), and a plain
 * `Error` on a bad-input wire failure (status 2). When `schema` is undefined
 * the wire sets `schema_present = 0` and the wasm returns ok unconditionally.
 */
export function validateToolArgs<T>(args: T, schema: unknown | undefined): T {
  const out = callWasm("luv_validate_tool_args", encode(args, schema));
  const status = out[0];
  if (status === 0) return args;

  // status != 0 → u32 msg_len; msg(utf8)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const msgLen = dv.getUint32(1, true);
  const msg = td.decode(out.subarray(5, 5 + msgLen));

  if (status === 1) throw toolArgsErrorFromFull(msg);
  throw new Error(`luv_validate_tool_args bad input: ${msg}`);
}
