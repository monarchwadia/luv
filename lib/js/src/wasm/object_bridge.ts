// Ergonomic <-> wasm bridge for the PURE object-extraction path of the
// `object` brick. Only the pure step moves to wasm: parsing the model reply
// text as JSON + schema-validating it against the caller's JSON Schema.
// Network/send, request building, fetch and HTTP error handling stay in
// object.ts — this bridge is invoked from there for the pure step only.
//
// Additive / unimported by the public API until the swap — building it here
// lets the differential test compare it against the TS port with zero risk.
//
// Wasm export `luv_extract_object`:
//   IN:  u32 text_len; text(utf8); u32 schema_len; schema(JSON utf8)  (LE)
//   OUT: u8 status (0=ok, 1=non-json, 2=schema-fail, 3=bad-input);
//        if status != 0: u32 msg_len; msg(utf8)

import { callWasm } from "./sync.ts";
import { GenerateObjectError } from "../object.ts";

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Pure object extraction: validate `replyText` as JSON matching `schema`.
 *
 * The wasm core performs the JSON parse + schema validation. TS already holds
 * the text, so on success we return `JSON.parse(replyText)` (identical to the
 * value the core validated). Errors are re-thrown with the SAME error type and
 * message shape `object.ts` uses for its pure step:
 *   - status 1 (non-json)    -> GenerateObjectError "model returned non-JSON content: <slice>"
 *   - status 2 (schema-fail) -> GenerateObjectError "schema validation failed: <msg>"
 *   - status 3 (bad-input)   -> Error
 */
export function extractObject(replyText: string, schema: unknown): unknown {
  const textBytes = te.encode(replyText);
  const schemaBytes = te.encode(JSON.stringify(schema));

  const input = new Uint8Array(4 + textBytes.length + 4 + schemaBytes.length);
  const dv = new DataView(input.buffer);
  let pos = 0;
  dv.setUint32(pos, textBytes.length, true);
  pos += 4;
  input.set(textBytes, pos);
  pos += textBytes.length;
  dv.setUint32(pos, schemaBytes.length, true);
  pos += 4;
  input.set(schemaBytes, pos);

  const out = callWasm("luv_extract_object", input);
  const status = out[0];

  if (status === 0) {
    // Core validated the text; TS holds it — parse it here for the typed value.
    return JSON.parse(replyText);
  }

  const msgLen = new DataView(out.buffer, out.byteOffset).getUint32(1, true);
  const msg = td.decode(out.subarray(5, 5 + msgLen));

  if (status === 1) {
    // Mirror object.ts's non-JSON error exactly.
    throw new GenerateObjectError(
      `model returned non-JSON content: ${replyText.slice(0, 200)}`,
    );
  }
  if (status === 2) {
    // The core's msg is already `schema validation failed: <parseArguments
    // message>` (object_extract mirrors object.ts's wrapping). The
    // GenerateObjectError constructor adds the `luv-js: generateObject: `
    // prefix, yielding the exact string object.ts's TS port produced.
    throw new GenerateObjectError(msg);
  }
  // status 3 (or anything unexpected): bad input to the pure step.
  throw new Error(`luv_extract_object: bad input: ${msg}`);
}
