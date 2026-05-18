// A2 — cross-impl codec parity. Asserts the TS codec against the SAME
// corpus the Zig conformance test asserts (core/src/wasm_abi/codec_conformance.json).
// Additive test file; touches no existing test.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  encodeSendRequest,
  decodeReply,
  decodeEvents,
  type CodecEvent,
} from "../src/codec.ts";

const corpus = JSON.parse(
  readFileSync(
    new URL("../../../core/src/wasm_abi/codec_conformance.json", import.meta.url),
    "utf8",
  ),
) as {
  encodeReply: { name: string; value: { role: number; stopReason: number; text: string }; hex: string }[];
  encodeEvents: { name: string; events: CodecEvent[]; hex: string }[];
  decodeSendRequest: {
    name: string;
    hex: string;
    value: {
      model: string;
      messages: { role: number; text: string }[];
      maxTokens: number | null;
      temperature: number | null;
      stream: boolean;
    };
  }[];
};

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("TS encodeSendRequest == Zig decode-expected bytes (corpus)", () => {
  for (const c of corpus.decodeSendRequest) {
    expect(toHex(encodeSendRequest(c.value))).toBe(c.hex);
  }
});

test("TS decodeReply matches Zig encode-output (corpus)", () => {
  for (const c of corpus.encodeReply) {
    expect(decodeReply(hexToBytes(c.hex))).toEqual(c.value);
  }
});

test("TS decodeEvents matches Zig encode-output (corpus)", () => {
  for (const c of corpus.encodeEvents) {
    expect(decodeEvents(hexToBytes(c.hex))).toEqual(c.events);
  }
});
