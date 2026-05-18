// Differential gate for the morphism-anthropic brick swap.
// Compares the TS port (morphism_anthropic.ts toAnthropic/fromAnthropic)
// against the wasm path (anthropic_bridge) over a representative equivalence
// set. Its JOB is to enumerate divergences BEFORE the wrapper flips — nothing
// is swapped/deleted until this is green. Additive; no existing test touched.
//
// KNOWN divergences (Zig anthropic port, documented in anthropic.zig — these
// need a Zig reconcile the orchestrator does serially; no Zig change here):
//
//   1. content-not-array: the TS port throws MorphismError(/content/). The
//      Zig path uses typed std.json.parseFromSlice(Response,...) where a
//      non-array `content` fails at parse time → status -3 → bridge throws a
//      generic Error, not the MorphismError contract. (ContentNotArray is
//      effectively unreachable under typed parsing.)
//   2. tool_use missing id/name: the TS port throws
//      MorphismError(/missing id or name/). The Zig port substitutes "" for
//      absent id/name and returns a tool call instead of throwing.
//
// Both are marked test.failing below (suite stays green) and REPORTED.
import { test, expect } from "bun:test";
import {
  toAnthropic,
  fromAnthropic,
  MorphismError,
  type ToAnthropicOptions,
  type AnthropicWireResponse,
} from "../src/morphism_anthropic.ts";
import {
  buildAnthropicRequest,
  parseAnthropicReply,
} from "../src/wasm/anthropic_bridge.ts";
import type { Conversation } from "../src/types.ts";

const requestCases: { name: string; opts: ToAnthropicOptions }[] = [
  {
    name: "single user",
    opts: {
      model: "claude-3-5-sonnet-20241022",
      conversation: [{ role: "user", text: "hi" }],
    },
  },
  {
    name: "system+user multi-turn + opts",
    opts: {
      model: "claude-3-5-sonnet-20241022",
      conversation: [
        { role: "system", text: "be terse" },
        { role: "user", text: "weather?" },
        { role: "assistant", text: "It is sunny." },
      ],
      maxTokens: 64,
      temperature: 0.2,
      stream: true,
    },
  },
  {
    name: "multiple system messages concatenated",
    opts: {
      model: "x",
      conversation: [
        { role: "system", text: "be terse" },
        { role: "system", text: "answer in english" },
        { role: "user", text: "hi" },
      ],
    },
  },
  {
    name: "assistant tool call (pending)",
    opts: {
      model: "m",
      conversation: [
        { role: "user", text: "weather in Tokyo?" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "wx", arguments: { city: "Tokyo" } }],
        },
      ] as Conversation,
    },
  },
  {
    name: "assistant tool call with text + pending",
    opts: {
      model: "m",
      conversation: [
        { role: "user", text: "weather in Tokyo?" },
        {
          role: "assistant",
          text: "let me check",
          toolCalls: [{ id: "c1", name: "wx", arguments: { city: "Tokyo" } }],
        },
      ] as Conversation,
    },
  },
  {
    name: "assistant tool call (resolved ok + err, folded)",
    opts: {
      model: "m",
      conversation: [
        {
          role: "assistant",
          text: "checking",
          toolCalls: [
            { id: "c1", name: "wx", arguments: { city: "T" }, result: { ok: true, content: '{"t":18}' } },
            { id: "c2", name: "bad", arguments: {}, result: { ok: false, error: "boom" } },
          ],
        },
      ] as Conversation,
    },
  },
  {
    name: "with tools",
    opts: {
      model: "m",
      conversation: [{ role: "user", text: "hi" }],
      tools: [
        {
          name: "calc",
          description: "adds",
          inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
          handler: async () => ({ ok: true, content: "" }),
        },
      ],
    },
  },
  {
    name: "temperature 0 emitted (not falsy-dropped)",
    opts: {
      model: "m",
      conversation: [{ role: "user", text: "hi" }],
      temperature: 0,
    },
  },
];

for (const c of requestCases) {
  test(`toAnthropic parity: ${c.name}`, () => {
    expect(buildAnthropicRequest(c.opts)).toEqual(toAnthropic(c.opts));
  });
}

const replyCases: { name: string; wire: AnthropicWireResponse }[] = [
  {
    name: "text + usage",
    wire: {
      id: "msg_x",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    name: "text + tool_use combined",
    wire: {
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "c1", name: "wx", input: { city: "Tokyo" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 8 },
    },
  },
  {
    name: "tool_use only (no input -> {})",
    wire: {
      content: [{ type: "tool_use", id: "c1", name: "wx" }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  {
    name: "unknown block types dropped",
    wire: {
      content: [
        { type: "thinking", text: "internal" },
        { type: "text", text: "actual reply" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  {
    name: "empty content array",
    wire: {
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  { name: "stop_reason end_turn", wire: { content: [{ type: "text", text: "x" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
  { name: "stop_reason max_tokens", wire: { content: [{ type: "text", text: "x" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } } },
  { name: "stop_reason stop_sequence", wire: { content: [{ type: "text", text: "x" }], stop_reason: "stop_sequence", usage: { input_tokens: 1, output_tokens: 1 } } },
  { name: "stop_reason tool_use", wire: { content: [{ type: "text", text: "x" }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } },
  { name: "stop_reason weird -> other", wire: { content: [{ type: "text", text: "x" }], stop_reason: "weird_unknown", usage: { input_tokens: 1, output_tokens: 1 } } },
  { name: "stop_reason null -> other", wire: { content: [{ type: "text", text: "x" }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
];

for (const c of replyCases) {
  test(`fromAnthropic parity: ${c.name}`, () => {
    expect(parseAnthropicReply(c.wire)).toEqual(fromAnthropic(c.wire));
  });
}

// --- KNOWN DIVERGENCES (need a Zig reconcile; not fixed here) -------------

// Divergence #1: content-not-array. TS port throws MorphismError(/content/);
// the Zig typed parse fails (status -3) → bridge throws a generic Error.
// Reconcile would require Zig to detect non-array content pre-typed-parse and
// surface a distinguishable error the flipped wrapper can re-wrap as
// MorphismError. ContentNotArray is unreachable under typed parsing today.
test.failing(
  "fromAnthropic parity: content not array (DIVERGENT — needs Zig reconcile)",
  () => {
    const wire = {
      content: "garbage",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as AnthropicWireResponse;
    let tsErr: unknown;
    let brErr: unknown;
    try {
      fromAnthropic(wire);
    } catch (e) {
      tsErr = e;
    }
    try {
      parseAnthropicReply(wire);
    } catch (e) {
      brErr = e;
    }
    // TS throws MorphismError(/content/); bridge throws generic status -3.
    expect(tsErr).toBeInstanceOf(MorphismError);
    expect(brErr).toBeInstanceOf(MorphismError);
    expect((brErr as Error).message).toMatch(/content/);
  },
);

// Divergence #2: tool_use block missing id/name. TS port throws
// MorphismError(/missing id or name/); the Zig port substitutes "" and
// returns the call. Reconcile would require Zig fromAnthropic to error when
// a tool_use block lacks id/name instead of defaulting to "".
test.failing(
  "fromAnthropic parity: tool_use missing id/name (DIVERGENT — needs Zig reconcile)",
  () => {
    const wire = {
      content: [{ type: "tool_use", input: { a: 1 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as AnthropicWireResponse;
    let tsThrew = false;
    try {
      fromAnthropic(wire);
    } catch {
      tsThrew = true;
    }
    expect(tsThrew).toBe(true);
    // Bridge does NOT throw (Zig substitutes "" for missing id/name), so
    // requiring parity here fails until a Zig reconcile lands.
    expect(() => parseAnthropicReply(wire)).toThrow();
  },
);
