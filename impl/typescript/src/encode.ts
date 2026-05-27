import type {
  Block,
  Message,
  Node,
  Conversation,
  Reply,
  StreamEventReply,
  StreamReply,
  ValidationError,
  ValidationResult,
} from "./types.ts";

// Each encoder produces a plain JS object whose property insertion order
// matches the canonical key order for its type (Section 3 rule 1).
// JSON.stringify preserves insertion order in ES2015+, so stringifying
// the result yields canonical bytes.

export function encodeBlock(b: Block): unknown {
  switch (b.kind) {
    case "text":
      return { kind: b.kind, text: b.text };
    case "tool_call":
      return { kind: b.kind, id: b.id, name: b.name, args: b.args };
    case "tool_result":
      return { kind: b.kind, call_id: b.call_id, text: b.text };
  }
}

export function encodeMessage(m: Message): unknown {
  return { role: m.role, content: m.content.map(encodeBlock) };
}

export function encodeNode(n: Node): unknown {
  return { id: n.id, parent_id: n.parent_id, message: encodeMessage(n.message) };
}

export function encodeConversation(c: Conversation): unknown {
  return {
    spec_version: c.spec_version,
    nodes: c.nodes.map(encodeNode),
  };
}

export function encodeReply(r: Reply): unknown {
  return { message: encodeMessage(r.message), finish_reason: r.finish_reason };
}

export function encodeStreamEventReply(e: StreamEventReply): unknown {
  switch (e.kind) {
    case "message_start":
      return { kind: e.kind };
    case "block_start":
      return { kind: e.kind, block: encodeBlock(e.block) };
    case "text_delta":
      return { kind: e.kind, text: e.text };
    case "args_delta":
      return { kind: e.kind, args: e.args };
    case "block_end":
      return { kind: e.kind };
    case "message_end":
      return { kind: e.kind, finish_reason: e.finish_reason };
  }
}

export function encodeStreamReply(s: StreamReply): unknown {
  return s.map(encodeStreamEventReply);
}

export function encodeValidationError(e: ValidationError): unknown {
  return { path: e.path, rule: e.rule, message: e.message };
}

export function encodeValidationResult(v: ValidationResult): unknown {
  if (v.valid) return { valid: true };
  return { valid: false, errors: v.errors.map(encodeValidationError) };
}

// Final canonical serialization. JSON.stringify with no replacer/spacer
// produces no insignificant whitespace and preserves the property
// insertion order set up by the encoders above.
export function stringify(v: unknown): string {
  // Reject lone surrogates anywhere in the value tree (Section 3 rule 3).
  checkStrings(v);
  return JSON.stringify(v);
}

function checkStrings(v: unknown): void {
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) {
      const code = v.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= v.length) {
          throw new Error(`Lone high surrogate at position ${i}`);
        }
        const next = v.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          throw new Error(`Lone high surrogate at position ${i}`);
        }
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error(`Lone low surrogate at position ${i}`);
      }
    }
  } else if (Array.isArray(v)) {
    for (const item of v) checkStrings(item);
  } else if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      checkStrings((v as Record<string, unknown>)[k]);
    }
  }
}
