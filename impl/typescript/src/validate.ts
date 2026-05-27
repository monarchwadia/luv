import type { ValidationError, ValidationResult } from "./types.ts";

// Validators take *alleged* canonical values and return a ValidationResult.
// Errors are emitted in depth-first, left-to-right traversal order.

export function validate_luv_block(
  input: unknown,
  basePath = "/",
): ValidationResult {
  const errors: ValidationError[] = [];
  validateBlockInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validate_luv_message(
  input: unknown,
  basePath = "/",
): ValidationResult {
  const errors: ValidationError[] = [];
  validateMessageInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validate_luv_reply(
  input: unknown,
  basePath = "/",
): ValidationResult {
  const errors: ValidationError[] = [];
  validateReplyInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validate_luv_stream_reply(
  input: unknown,
  basePath = "/",
): ValidationResult {
  const errors: ValidationError[] = [];
  validateStreamReplyInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

const SUPPORTED_SPEC_VERSION = "1.0";

export function validate_luv_conversation(
  input: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: "/",
      rule: "shape.conversation.is_object",
      message: "Conversation must be a JSON object",
    });
    return { valid: false, errors };
  }

  const c = input as Record<string, unknown>;

  // spec_version checks
  if (typeof c.spec_version !== "string") {
    errors.push({
      path: "/spec_version",
      rule: "shape.conversation.fields",
      message: "Conversation.spec_version must be a string",
    });
  } else if (c.spec_version !== SUPPORTED_SPEC_VERSION) {
    errors.push({
      path: "/spec_version",
      rule: "shape.conversation.spec_version",
      message: `Unknown spec_version '${c.spec_version}'; this implementation supports '${SUPPORTED_SPEC_VERSION}'`,
    });
  }

  // nodes check
  if (!Array.isArray(c.nodes)) {
    errors.push({
      path: "/nodes",
      rule: "shape.conversation.fields",
      message: "Conversation.nodes must be an array",
    });
    return { valid: false, errors };
  }

  const nodes = c.nodes;

  // Single-pass walk of nodes. The id map is populated as we go, so
  // any parent_id referencing a yet-unseen node fails either
  // parent_reference (if the id never appears) or topological_order
  // (if the id appears later).
  const idIndex = new Map<string, number>();
  const rootIndices: number[] = [];

  // Walk first to gather shape errors, ids, and root positions.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown> | null;
    const nodePath = `/nodes/${i}`;

    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errors.push({
        path: nodePath,
        rule: "shape.node.fields",
        message: "Node must be a JSON object",
      });
      continue;
    }

    // Shape: id
    if (typeof node.id !== "string") {
      errors.push({
        path: `${nodePath}/id`,
        rule: "shape.node.fields",
        message: "Node.id must be a string",
      });
    } else {
      // unique_ids
      if (idIndex.has(node.id)) {
        errors.push({
          path: `${nodePath}/id`,
          rule: "invariant.unique_ids",
          message: `id '${node.id}' already appears at /nodes/${idIndex.get(node.id)}/id`,
        });
      } else {
        idIndex.set(node.id, i);
      }
    }

    // Shape: parent_id
    if (node.parent_id !== null && typeof node.parent_id !== "string") {
      errors.push({
        path: `${nodePath}/parent_id`,
        rule: "shape.node.fields",
        message: "Node.parent_id must be a string or null",
      });
    } else if (node.parent_id === null) {
      rootIndices.push(i);
    }

    // Shape + content: message
    if (
      node.message === null ||
      typeof node.message !== "object" ||
      Array.isArray(node.message)
    ) {
      errors.push({
        path: `${nodePath}/message`,
        rule: "shape.node.fields",
        message: "Node.message must be a JSON object",
      });
    } else {
      validateMessageInto(node.message, `${nodePath}/message`, errors);
    }
  }

  // Cross-element invariants (parent_reference, topological_order, single_root)
  // emitted after the per-node pass, but inserted in path order via a sort below.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown> | null;
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const pid = node.parent_id;
    if (typeof pid !== "string") continue;
    const idx = idIndex.get(pid);
    if (idx === undefined) {
      errors.push({
        path: `/nodes/${i}/parent_id`,
        rule: "invariant.parent_reference",
        message: `parent_id '${pid}' does not resolve to any node in the conversation`,
      });
    } else if (idx >= i) {
      errors.push({
        path: `/nodes/${i}/parent_id`,
        rule: "invariant.topological_order",
        message: `parent appears at index ${idx}; must appear before the node at index ${i}`,
      });
    }
  }

  if (nodes.length > 0 && rootIndices.length === 0) {
    errors.push({
      path: "/nodes",
      rule: "invariant.single_root",
      message: "No root node found (no node has parent_id: null)",
    });
  } else if (rootIndices.length > 1) {
    for (let i = 1; i < rootIndices.length; i++) {
      errors.push({
        path: `/nodes/${rootIndices[i]}`,
        rule: "invariant.single_root",
        message: `Second root node; first root is at /nodes/${rootIndices[0]}`,
      });
    }
  }

  // tool_result_ancestry: for each tool_result block in the conversation,
  // walk its node's parent chain looking for a matching tool_call.id.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown> | null;
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const msg = node.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let j = 0; j < content.length; j++) {
      const b = content[j] as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || b.kind !== "tool_result") continue;
      const callId = b.call_id;
      if (typeof callId !== "string") continue;
      if (!ancestryHasToolCall(nodes, i, callId)) {
        errors.push({
          path: `/nodes/${i}/message/content/${j}/call_id`,
          rule: "invariant.tool_result_ancestry",
          message: `call_id '${callId}' is not present as a tool_call.id on any ancestor node`,
        });
      }
    }
  }

  // Sort errors by JSON Pointer path to match the depth-first traversal
  // order the spec requires for byte-equal ValidationResult comparison.
  errors.sort(comparePaths);

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function ancestryHasToolCall(
  nodes: unknown[],
  startIndex: number,
  callId: string,
): boolean {
  // Walk up parent_id chain from nodes[startIndex] to root.
  const idIndex = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Record<string, unknown> | null;
    if (n && typeof n === "object" && typeof n.id === "string") {
      idIndex.set(n.id, i);
    }
  }

  let cursor: number | undefined = startIndex;
  const visited = new Set<number>();
  while (cursor !== undefined) {
    if (visited.has(cursor)) return false; // cycle safeguard
    visited.add(cursor);
    const n = nodes[cursor] as Record<string, unknown> | null;
    if (!n) break;
    const parent = n.parent_id;
    cursor = typeof parent === "string" ? idIndex.get(parent) : undefined;
    if (cursor === undefined) break;
    const parentNode = nodes[cursor] as Record<string, unknown> | null;
    if (!parentNode) break;
    const msg = parentNode.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as Record<string, unknown> | null;
      if (block && block.kind === "tool_call" && block.id === callId) {
        return true;
      }
    }
  }
  return false;
}

function validateMessageInto(
  input: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.message.fields",
      message: "Message must be a JSON object",
    });
    return;
  }
  const m = input as Record<string, unknown>;

  if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") {
    errors.push({
      path: `${basePath}/role`,
      rule: "shape.role",
      message: "Role must be 'system', 'user', or 'assistant'",
    });
  }

  if (!Array.isArray(m.content)) {
    errors.push({
      path: `${basePath}/content`,
      rule: "shape.message.fields",
      message: "Message.content must be an array",
    });
  } else {
    if (m.content.length === 0) {
      errors.push({
        path: `${basePath}/content`,
        rule: "shape.message.content_nonempty",
        message: "Message.content must contain at least one Block",
      });
    }
    for (let i = 0; i < m.content.length; i++) {
      validateBlockInto(m.content[i], `${basePath}/content/${i}`, errors);
      const block = m.content[i] as Record<string, unknown> | null;
      if (block && typeof block === "object") {
        // Block role conventions.
        if (block.kind === "tool_call" && m.role !== "assistant") {
          errors.push({
            path: `${basePath}/content/${i}`,
            rule: "convention.tool_call_block_role",
            message: "tool_call blocks may only appear in assistant messages",
          });
        }
        if (block.kind === "tool_result" && m.role !== "user") {
          errors.push({
            path: `${basePath}/content/${i}`,
            rule: "convention.tool_result_block_role",
            message: "tool_result blocks may only appear in user messages",
          });
        }
      }
    }
  }
}

function validateBlockInto(
  input: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.block.kind",
      message: "Block must be a JSON object",
    });
    return;
  }
  const b = input as Record<string, unknown>;
  if (b.kind === "text") {
    if (typeof b.text !== "string") {
      errors.push({
        path: `${basePath}/text`,
        rule: "shape.block.text",
        message: "text block requires text: string",
      });
    }
  } else if (b.kind === "tool_call") {
    if (typeof b.id !== "string") {
      errors.push({
        path: `${basePath}/id`,
        rule: "shape.block.tool_call",
        message: "tool_call requires id: string",
      });
    }
    if (typeof b.name !== "string") {
      errors.push({
        path: `${basePath}/name`,
        rule: "shape.block.tool_call",
        message: "tool_call requires name: string",
      });
    }
    if (typeof b.args !== "string") {
      errors.push({
        path: `${basePath}/args`,
        rule: "shape.block.tool_call",
        message: "tool_call requires args: string",
      });
    }
  } else if (b.kind === "tool_result") {
    if (typeof b.call_id !== "string") {
      errors.push({
        path: `${basePath}/call_id`,
        rule: "shape.block.tool_result",
        message: "tool_result requires call_id: string",
      });
    }
    if (typeof b.text !== "string") {
      errors.push({
        path: `${basePath}/text`,
        rule: "shape.block.tool_result",
        message: "tool_result requires text: string",
      });
    }
  } else {
    errors.push({
      path: `${basePath}/kind`,
      rule: "shape.block.kind",
      message: "Block.kind must be 'text', 'tool_call', or 'tool_result'",
    });
  }
}

function validateReplyInto(
  input: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.reply.fields",
      message: "Reply must be a JSON object",
    });
    return;
  }
  const r = input as Record<string, unknown>;
  if (
    r.message === null ||
    typeof r.message !== "object" ||
    Array.isArray(r.message)
  ) {
    errors.push({
      path: `${basePath}/message`,
      rule: "shape.reply.fields",
      message: "Reply.message must be an object",
    });
  } else {
    const mm = r.message as Record<string, unknown>;
    if (mm.role !== "assistant") {
      errors.push({
        path: `${basePath}/message/role`,
        rule: "shape.reply.assistant_role",
        message: "Reply.message.role must be 'assistant'",
      });
    }
    validateMessageInto(r.message, `${basePath}/message`, errors);
    // content_restriction: only text and tool_call
    if (Array.isArray(mm.content)) {
      for (let i = 0; i < mm.content.length; i++) {
        const block = mm.content[i] as Record<string, unknown> | null;
        if (block && block.kind === "tool_result") {
          errors.push({
            path: `${basePath}/message/content/${i}`,
            rule: "shape.reply.content_restriction",
            message: "Reply.message.content may not contain tool_result blocks",
          });
        }
      }
    }
  }

  if (
    r.finish_reason !== "end_turn" &&
    r.finish_reason !== "max_tokens" &&
    r.finish_reason !== "content_filter"
  ) {
    errors.push({
      path: `${basePath}/finish_reason`,
      rule: "shape.finish_reason",
      message:
        "FinishReason must be 'end_turn', 'max_tokens', or 'content_filter'",
    });
  }
}

function validateStreamReplyInto(
  input: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.stream_event.kind",
      message: "Stream<Reply> must be a JSON array",
    });
    return;
  }
  // grammar walk
  let starts = 0;
  let ends = 0;
  let blockOpen: "text" | "tool_call" | null = null;
  for (let i = 0; i < input.length; i++) {
    const e = input[i] as Record<string, unknown> | null;
    if (!e || typeof e !== "object") {
      errors.push({
        path: `${basePath}/${i}`,
        rule: "shape.stream_event.kind",
        message: "Stream event must be an object",
      });
      continue;
    }
    switch (e.kind) {
      case "message_start":
        starts++;
        if (i !== 0) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.message_start_unique",
            message: "message_start must be the first event",
          });
        }
        break;
      case "message_end":
        ends++;
        if (i !== input.length - 1) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.message_end_unique",
            message: "message_end must be the last event",
          });
        }
        break;
      case "block_start": {
        if (blockOpen !== null) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.block_balance",
            message: "block_start while a block is already open",
          });
        }
        const b = e.block as Record<string, unknown> | null;
        if (!b || typeof b !== "object") {
          errors.push({
            path: `${basePath}/${i}/block`,
            rule: "shape.stream_event.variant_fields",
            message: "block_start requires a block object",
          });
        } else if (b.kind === "text") {
          blockOpen = "text";
        } else if (b.kind === "tool_call") {
          blockOpen = "tool_call";
        } else if (b.kind === "tool_result") {
          errors.push({
            path: `${basePath}/${i}/block`,
            rule: "stream.no_tool_result_blocks",
            message:
              "tool_result blocks may not appear in Stream<Reply> (assistant-only)",
          });
          blockOpen = "text"; // tolerate for the rest of the walk
        }
        break;
      }
      case "block_end":
        if (blockOpen === null) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.block_balance",
            message: "block_end with no block open",
          });
        }
        blockOpen = null;
        break;
      case "text_delta":
        if (blockOpen !== "text") {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.text_delta_in_text_block",
            message: "text_delta outside a text block",
          });
        }
        break;
      case "args_delta":
        if (blockOpen !== "tool_call") {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.args_delta_in_tool_call_block",
            message: "args_delta outside a tool_call block",
          });
        }
        break;
      default:
        errors.push({
          path: `${basePath}/${i}/kind`,
          rule: "shape.stream_event.kind",
          message: "Unknown StreamEvent kind",
        });
    }
  }
  if (starts !== 1) {
    errors.push({
      path: basePath,
      rule: "stream.message_start_unique",
      message: `expected exactly one message_start; got ${starts}`,
    });
  }
  if (ends !== 1) {
    errors.push({
      path: basePath,
      rule: "stream.message_end_unique",
      message: `expected exactly one message_end; got ${ends}`,
    });
  }
}

// Comparator for JSON Pointer paths in depth-first, left-to-right order.
// Splits on "/" and compares segment-by-segment; numeric segments compare
// numerically; string segments compare lexicographically.
function comparePaths(a: ValidationError, b: ValidationError): number {
  const as = a.path.split("/").slice(1);
  const bs = b.path.split("/").slice(1);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const c = compareSegment(as[i], bs[i]);
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

function compareSegment(a: string, b: string): number {
  const an = /^\d+$/.test(a) ? Number(a) : NaN;
  const bn = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return a < b ? -1 : a > b ? 1 : 0;
}
