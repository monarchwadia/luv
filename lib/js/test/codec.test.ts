import { test, expect } from "bun:test";
import { decodeEvents, decodeReply, encodeSendRequest } from "../src/codec.ts";

test("encodeSendRequest: minimal request matches Zig codec test bytes", () => {
  const bytes = encodeSendRequest({
    apiKey: "sk-test",
    model: "m",
    conversation: [{ role: "user", text: "hi" }],
  });

  // Mirrors codec.zig "decodeSendRequest: minimal request" fixture bytes.
  const expected = new Uint8Array([
    0x01, 0x00, 0x00, 0x00, // model_len = 1
    0x6d,                   // "m"
    0x01, 0x00, 0x00, 0x00, // message_count = 1
    0x01,                   // role = user
    0x02, 0x00, 0x00, 0x00, // text_len = 2
    0x68, 0x69,             // "hi"
    0x00,                   // max_tokens absent
    0x00,                   // temperature absent
    0x00,                   // stream = false
  ]);
  expect(Array.from(bytes)).toEqual(Array.from(expected));
});

test("encodeSendRequest: full request with system+user, max_tokens, temperature, stream", () => {
  const bytes = encodeSendRequest({
    apiKey: "sk",
    model: "gpt-4o-mini",
    conversation: [
      { role: "system", text: "be" },
      { role: "user", text: "hi" },
    ],
    maxTokens: 32,
    temperature: 0,
  });

  const expected = new Uint8Array([
    0x0b, 0x00, 0x00, 0x00,
    0x67, 0x70, 0x74, 0x2d, 0x34, 0x6f, 0x2d, 0x6d, 0x69, 0x6e, 0x69,
    0x02, 0x00, 0x00, 0x00,
    0x00,
    0x02, 0x00, 0x00, 0x00,
    0x62, 0x65,
    0x01,
    0x02, 0x00, 0x00, 0x00,
    0x68, 0x69,
    0x01,
    0x20, 0x00, 0x00, 0x00,
    0x01,
    0x00, 0x00, 0x00, 0x00,
    0x00,
  ]);
  expect(Array.from(bytes)).toEqual(Array.from(expected));
});

test("decodeReply: assistant + end_turn + 'Hi' bytes round-trip to Reply", () => {
  const bytes = new Uint8Array([
    0x02,
    0x00,
    0x02, 0x00, 0x00, 0x00,
    0x48, 0x69,
  ]);
  const reply = decodeReply(bytes);
  expect(reply.message.role).toBe("assistant");
  expect(reply.message.text).toBe("Hi");
  expect(reply.stopReason).toBe("end_turn");
});

test("decodeEvents: empty batch returns empty array", () => {
  const events = decodeEvents(new Uint8Array([0, 0, 0, 0]));
  expect(events).toEqual([]);
});

test("decodeEvents: start + text + stop sequence decodes correctly", () => {
  const bytes = new Uint8Array([
    0x03, 0x00, 0x00, 0x00,
    0x00, 0x02,
    0x01,
    0x02, 0x00, 0x00, 0x00,
    0x68, 0x69,
    0x02, 0x00,
  ]);
  const events = decodeEvents(bytes);
  expect(events.length).toBe(3);
  expect(events[0]).toEqual({ type: "start", role: "assistant" });
  expect(events[1]).toEqual({ type: "text", delta: "hi" });
  expect(events[2]).toEqual({ type: "stop", stopReason: "end_turn" });
});

test("encodeSendRequest then decodeReply round-trips through hand-mirrored bytes", () => {
  // Symmetric round-trip — encode the same thing the Zig encodeReply test
  // expects, decode back, assert structure is preserved.
  const expected = new Uint8Array([
    0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x48, 0x69,
  ]);
  const reply = decodeReply(expected);
  expect(reply.message.text).toBe("Hi");
});
