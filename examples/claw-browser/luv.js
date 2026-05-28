// src/types.ts
var ERROR_CATEGORIES = [
  "auth",
  "rate_limit",
  "bad_request",
  "content_filter",
  "server_error",
  "network",
  "tool_execution",
  "local_validation",
  "unknown"
];
var LUV_SPEC_VERSION = "1.0";

class LuvError extends Error {
  data;
  constructor(data) {
    super(data.message);
    this.name = "LuvError";
    this.data = data;
  }
}
// src/encode.ts
function encodeBlock(b) {
  switch (b.kind) {
    case "text":
      return { kind: b.kind, text: b.text };
    case "tool_call":
      return { kind: b.kind, id: b.id, name: b.name, args: b.args };
    case "tool_result":
      return { kind: b.kind, call_id: b.call_id, text: b.text };
    case "error":
      return {
        kind: b.kind,
        category: b.category,
        message: b.message,
        details: b.details
      };
  }
}
function encodeMessage(m) {
  return { role: m.role, content: m.content.map(encodeBlock) };
}
function encodeNode(n) {
  return { id: n.id, parent_id: n.parent_id, message: encodeMessage(n.message) };
}
function encodeConversation(c) {
  return {
    spec_version: c.spec_version,
    nodes: c.nodes.map(encodeNode)
  };
}
function encodeReply(r) {
  return { message: encodeMessage(r.message), finish_reason: r.finish_reason };
}
function encodeStreamEventReply(e) {
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
function encodeStreamReply(s) {
  return s.map(encodeStreamEventReply);
}
function encodeValidationError(e) {
  return { path: e.path, rule: e.rule, message: e.message };
}
function encodeValidationResult(v) {
  if (v.valid)
    return { valid: true };
  return { valid: false, errors: v.errors.map(encodeValidationError) };
}
function stringify(v) {
  checkStrings(v);
  return JSON.stringify(v);
}
function checkStrings(v) {
  if (typeof v === "string") {
    for (let i = 0;i < v.length; i++) {
      const code = v.charCodeAt(i);
      if (code >= 55296 && code <= 56319) {
        if (i + 1 >= v.length) {
          throw new Error(`Lone high surrogate at position ${i}`);
        }
        const next = v.charCodeAt(i + 1);
        if (next < 56320 || next > 57343) {
          throw new Error(`Lone high surrogate at position ${i}`);
        }
        i++;
      } else if (code >= 56320 && code <= 57343) {
        throw new Error(`Lone low surrogate at position ${i}`);
      }
    }
  } else if (Array.isArray(v)) {
    for (const item of v)
      checkStrings(item);
  } else if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      checkStrings(v[k]);
    }
  }
}
// src/stream.ts
function consume_luv_stream_reply(stream) {
  let finishReason = "end_turn";
  const blocks = [];
  let current = null;
  for (const evt of stream) {
    switch (evt.kind) {
      case "message_start":
        break;
      case "block_start": {
        const b = evt.block;
        if (b.kind === "text") {
          current = { kind: "text", text: b.text };
        } else if (b.kind === "tool_call") {
          current = { kind: "tool_call", id: b.id, name: b.name, args: b.args };
        } else if (b.kind === "tool_result") {
          current = { kind: "tool_result", call_id: b.call_id, text: b.text };
        } else {
          current = {
            kind: "error",
            category: b.category,
            message: b.message,
            details: b.details
          };
        }
        blocks.push(current);
        break;
      }
      case "text_delta":
        if (current && current.kind === "text") {
          current.text += evt.text;
        }
        break;
      case "args_delta":
        if (current && current.kind === "tool_call") {
          current.args += evt.args;
        }
        break;
      case "block_end":
        current = null;
        break;
      case "message_end":
        finishReason = evt.finish_reason;
        break;
    }
  }
  return {
    message: { role: "assistant", content: blocks },
    finish_reason: finishReason
  };
}
function produce_luv_stream_reply(reply) {
  const events = [];
  events.push({ kind: "message_start" });
  for (const block of reply.message.content) {
    if (block.kind === "text") {
      events.push({
        kind: "block_start",
        block: { kind: "text", text: "" }
      });
      events.push({ kind: "text_delta", text: block.text });
      events.push({ kind: "block_end" });
    } else if (block.kind === "tool_call") {
      events.push({
        kind: "block_start",
        block: {
          kind: "tool_call",
          id: block.id,
          name: block.name,
          args: ""
        }
      });
      events.push({ kind: "args_delta", args: block.args });
      events.push({ kind: "block_end" });
    } else if (block.kind === "error") {
      events.push({ kind: "block_start", block });
      events.push({ kind: "block_end" });
    }
  }
  events.push({ kind: "message_end", finish_reason: reply.finish_reason });
  return events;
}
// src/validate.ts
function validate_luv_block(input, basePath = "/") {
  const errors = [];
  validateBlockInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
function validate_luv_message(input, basePath = "/") {
  const errors = [];
  validateMessageInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
function validate_luv_reply(input, basePath = "/") {
  const errors = [];
  validateReplyInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
function validate_luv_stream_reply(input, basePath = "/") {
  const errors = [];
  validateStreamReplyInto(input, basePath, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
var SUPPORTED_SPEC_VERSION = "1.0";
function validate_luv_conversation(input) {
  const errors = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: "/",
      rule: "shape.conversation.is_object",
      message: "Conversation must be a JSON object"
    });
    return { valid: false, errors };
  }
  const c = input;
  if (typeof c.spec_version !== "string") {
    errors.push({
      path: "/spec_version",
      rule: "shape.conversation.fields",
      message: "Conversation.spec_version must be a string"
    });
  } else if (c.spec_version !== SUPPORTED_SPEC_VERSION) {
    errors.push({
      path: "/spec_version",
      rule: "shape.conversation.spec_version",
      message: `Unknown spec_version '${c.spec_version}'; this implementation supports '${SUPPORTED_SPEC_VERSION}'`
    });
  }
  if (!Array.isArray(c.nodes)) {
    errors.push({
      path: "/nodes",
      rule: "shape.conversation.fields",
      message: "Conversation.nodes must be an array"
    });
    return { valid: false, errors };
  }
  const nodes = c.nodes;
  const idIndex = new Map;
  const rootIndices = [];
  for (let i = 0;i < nodes.length; i++) {
    const node = nodes[i];
    const nodePath = `/nodes/${i}`;
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errors.push({
        path: nodePath,
        rule: "shape.node.fields",
        message: "Node must be a JSON object"
      });
      continue;
    }
    if (typeof node.id !== "string") {
      errors.push({
        path: `${nodePath}/id`,
        rule: "shape.node.fields",
        message: "Node.id must be a string"
      });
    } else {
      if (idIndex.has(node.id)) {
        errors.push({
          path: `${nodePath}/id`,
          rule: "invariant.unique_ids",
          message: `id '${node.id}' already appears at /nodes/${idIndex.get(node.id)}/id`
        });
      } else {
        idIndex.set(node.id, i);
      }
    }
    if (node.parent_id !== null && typeof node.parent_id !== "string") {
      errors.push({
        path: `${nodePath}/parent_id`,
        rule: "shape.node.fields",
        message: "Node.parent_id must be a string or null"
      });
    } else if (node.parent_id === null) {
      rootIndices.push(i);
    }
    if (node.message === null || typeof node.message !== "object" || Array.isArray(node.message)) {
      errors.push({
        path: `${nodePath}/message`,
        rule: "shape.node.fields",
        message: "Node.message must be a JSON object"
      });
    } else {
      validateMessageInto(node.message, `${nodePath}/message`, errors);
    }
  }
  for (let i = 0;i < nodes.length; i++) {
    const node = nodes[i];
    if (node === null || typeof node !== "object" || Array.isArray(node))
      continue;
    const pid = node.parent_id;
    if (typeof pid !== "string")
      continue;
    const idx = idIndex.get(pid);
    if (idx === undefined) {
      errors.push({
        path: `/nodes/${i}/parent_id`,
        rule: "invariant.parent_reference",
        message: `parent_id '${pid}' does not resolve to any node in the conversation`
      });
    } else if (idx >= i) {
      errors.push({
        path: `/nodes/${i}/parent_id`,
        rule: "invariant.topological_order",
        message: `parent appears at index ${idx}; must appear before the node at index ${i}`
      });
    }
  }
  if (nodes.length > 0 && rootIndices.length === 0) {
    errors.push({
      path: "/nodes",
      rule: "invariant.single_root",
      message: "No root node found (no node has parent_id: null)"
    });
  } else if (rootIndices.length > 1) {
    for (let i = 1;i < rootIndices.length; i++) {
      errors.push({
        path: `/nodes/${rootIndices[i]}`,
        rule: "invariant.single_root",
        message: `Second root node; first root is at /nodes/${rootIndices[0]}`
      });
    }
  }
  for (let i = 0;i < nodes.length; i++) {
    const node = nodes[i];
    if (node === null || typeof node !== "object" || Array.isArray(node))
      continue;
    const msg = node.message;
    if (!msg || typeof msg !== "object")
      continue;
    const content = msg.content;
    if (!Array.isArray(content))
      continue;
    for (let j = 0;j < content.length; j++) {
      const b = content[j];
      if (!b || typeof b !== "object" || b.kind !== "tool_result")
        continue;
      const callId = b.call_id;
      if (typeof callId !== "string")
        continue;
      if (!ancestryHasToolCall(nodes, i, callId)) {
        errors.push({
          path: `/nodes/${i}/message/content/${j}/call_id`,
          rule: "invariant.tool_result_ancestry",
          message: `call_id '${callId}' is not present as a tool_call.id on any ancestor node`
        });
      }
    }
  }
  errors.sort(comparePaths);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
function ancestryHasToolCall(nodes, startIndex, callId) {
  const idIndex = new Map;
  for (let i = 0;i < nodes.length; i++) {
    const n = nodes[i];
    if (n && typeof n === "object" && typeof n.id === "string") {
      idIndex.set(n.id, i);
    }
  }
  let cursor = startIndex;
  const visited = new Set;
  while (cursor !== undefined) {
    if (visited.has(cursor))
      return false;
    visited.add(cursor);
    const n = nodes[cursor];
    if (!n)
      break;
    const parent = n.parent_id;
    cursor = typeof parent === "string" ? idIndex.get(parent) : undefined;
    if (cursor === undefined)
      break;
    const parentNode = nodes[cursor];
    if (!parentNode)
      break;
    const msg = parentNode.message;
    if (!msg)
      continue;
    const content = msg.content;
    if (!Array.isArray(content))
      continue;
    for (const b of content) {
      const block = b;
      if (block && block.kind === "tool_call" && block.id === callId) {
        return true;
      }
    }
  }
  return false;
}
function validateMessageInto(input, basePath, errors) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.message.fields",
      message: "Message must be a JSON object"
    });
    return;
  }
  const m = input;
  if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") {
    errors.push({
      path: `${basePath}/role`,
      rule: "shape.role",
      message: "Role must be 'system', 'user', or 'assistant'"
    });
  }
  if (!Array.isArray(m.content)) {
    errors.push({
      path: `${basePath}/content`,
      rule: "shape.message.fields",
      message: "Message.content must be an array"
    });
  } else {
    if (m.content.length === 0) {
      errors.push({
        path: `${basePath}/content`,
        rule: "shape.message.content_nonempty",
        message: "Message.content must contain at least one Block"
      });
    }
    for (let i = 0;i < m.content.length; i++) {
      validateBlockInto(m.content[i], `${basePath}/content/${i}`, errors);
      const block = m.content[i];
      if (block && typeof block === "object") {
        if (block.kind === "tool_call" && m.role !== "assistant") {
          errors.push({
            path: `${basePath}/content/${i}`,
            rule: "convention.tool_call_block_role",
            message: "tool_call blocks may only appear in assistant messages"
          });
        }
        if (block.kind === "tool_result" && m.role !== "user") {
          errors.push({
            path: `${basePath}/content/${i}`,
            rule: "convention.tool_result_block_role",
            message: "tool_result blocks may only appear in user messages"
          });
        }
      }
    }
  }
}
function validateBlockInto(input, basePath, errors) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.block.kind",
      message: "Block must be a JSON object"
    });
    return;
  }
  const b = input;
  if (b.kind === "text") {
    if (typeof b.text !== "string") {
      errors.push({
        path: `${basePath}/text`,
        rule: "shape.block.text",
        message: "text block requires text: string"
      });
    }
  } else if (b.kind === "tool_call") {
    if (typeof b.id !== "string") {
      errors.push({
        path: `${basePath}/id`,
        rule: "shape.block.tool_call",
        message: "tool_call requires id: string"
      });
    }
    if (typeof b.name !== "string") {
      errors.push({
        path: `${basePath}/name`,
        rule: "shape.block.tool_call",
        message: "tool_call requires name: string"
      });
    }
    if (typeof b.args !== "string") {
      errors.push({
        path: `${basePath}/args`,
        rule: "shape.block.tool_call",
        message: "tool_call requires args: string"
      });
    }
  } else if (b.kind === "tool_result") {
    if (typeof b.call_id !== "string") {
      errors.push({
        path: `${basePath}/call_id`,
        rule: "shape.block.tool_result",
        message: "tool_result requires call_id: string"
      });
    }
    if (typeof b.text !== "string") {
      errors.push({
        path: `${basePath}/text`,
        rule: "shape.block.tool_result",
        message: "tool_result requires text: string"
      });
    }
  } else if (b.kind === "error") {
    if (b.category !== "auth" && b.category !== "rate_limit" && b.category !== "bad_request" && b.category !== "content_filter" && b.category !== "server_error" && b.category !== "network" && b.category !== "tool_execution" && b.category !== "local_validation" && b.category !== "unknown") {
      errors.push({
        path: `${basePath}/category`,
        rule: "shape.block.error",
        message: "error block requires a known ErrorCategory value"
      });
    }
    if (typeof b.message !== "string") {
      errors.push({
        path: `${basePath}/message`,
        rule: "shape.block.error",
        message: "error block requires message: string"
      });
    }
    if (typeof b.details !== "string") {
      errors.push({
        path: `${basePath}/details`,
        rule: "shape.block.error",
        message: "error block requires details: string"
      });
    }
  } else {
    errors.push({
      path: `${basePath}/kind`,
      rule: "shape.block.kind",
      message: "Block.kind must be 'text', 'tool_call', 'tool_result', or 'error'"
    });
  }
}
function validateReplyInto(input, basePath, errors) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.reply.fields",
      message: "Reply must be a JSON object"
    });
    return;
  }
  const r = input;
  if (r.message === null || typeof r.message !== "object" || Array.isArray(r.message)) {
    errors.push({
      path: `${basePath}/message`,
      rule: "shape.reply.fields",
      message: "Reply.message must be an object"
    });
  } else {
    const mm = r.message;
    if (mm.role !== "assistant") {
      errors.push({
        path: `${basePath}/message/role`,
        rule: "shape.reply.assistant_role",
        message: "Reply.message.role must be 'assistant'"
      });
    }
    validateMessageInto(r.message, `${basePath}/message`, errors);
    if (Array.isArray(mm.content)) {
      for (let i = 0;i < mm.content.length; i++) {
        const block = mm.content[i];
        if (block && block.kind === "tool_result") {
          errors.push({
            path: `${basePath}/message/content/${i}`,
            rule: "shape.reply.content_restriction",
            message: "Reply.message.content may not contain tool_result blocks"
          });
        }
      }
    }
  }
  if (r.finish_reason !== "end_turn" && r.finish_reason !== "max_tokens" && r.finish_reason !== "content_filter" && r.finish_reason !== "error") {
    errors.push({
      path: `${basePath}/finish_reason`,
      rule: "shape.finish_reason",
      message: "FinishReason must be 'end_turn', 'max_tokens', 'content_filter', or 'error'"
    });
  }
}
function validateStreamReplyInto(input, basePath, errors) {
  if (!Array.isArray(input)) {
    errors.push({
      path: basePath,
      rule: "shape.stream_event.kind",
      message: "Stream<Reply> must be a JSON array"
    });
    return;
  }
  let starts = 0;
  let ends = 0;
  let blockOpen = null;
  for (let i = 0;i < input.length; i++) {
    const e = input[i];
    if (!e || typeof e !== "object") {
      errors.push({
        path: `${basePath}/${i}`,
        rule: "shape.stream_event.kind",
        message: "Stream event must be an object"
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
            message: "message_start must be the first event"
          });
        }
        break;
      case "message_end":
        ends++;
        if (i !== input.length - 1) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.message_end_unique",
            message: "message_end must be the last event"
          });
        }
        break;
      case "block_start": {
        if (blockOpen !== null) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.block_balance",
            message: "block_start while a block is already open"
          });
        }
        const b = e.block;
        if (!b || typeof b !== "object") {
          errors.push({
            path: `${basePath}/${i}/block`,
            rule: "shape.stream_event.variant_fields",
            message: "block_start requires a block object"
          });
        } else if (b.kind === "text") {
          blockOpen = "text";
        } else if (b.kind === "tool_call") {
          blockOpen = "tool_call";
        } else if (b.kind === "tool_result") {
          errors.push({
            path: `${basePath}/${i}/block`,
            rule: "stream.no_tool_result_blocks",
            message: "tool_result blocks may not appear in Stream<Reply> (assistant-only)"
          });
          blockOpen = "text";
        }
        break;
      }
      case "block_end":
        if (blockOpen === null) {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.block_balance",
            message: "block_end with no block open"
          });
        }
        blockOpen = null;
        break;
      case "text_delta":
        if (blockOpen !== "text") {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.text_delta_in_text_block",
            message: "text_delta outside a text block"
          });
        }
        break;
      case "args_delta":
        if (blockOpen !== "tool_call") {
          errors.push({
            path: `${basePath}/${i}`,
            rule: "stream.args_delta_in_tool_call_block",
            message: "args_delta outside a tool_call block"
          });
        }
        break;
      default:
        errors.push({
          path: `${basePath}/${i}/kind`,
          rule: "shape.stream_event.kind",
          message: "Unknown StreamEvent kind"
        });
    }
  }
  if (starts !== 1) {
    errors.push({
      path: basePath,
      rule: "stream.message_start_unique",
      message: `expected exactly one message_start; got ${starts}`
    });
  }
  if (ends !== 1) {
    errors.push({
      path: basePath,
      rule: "stream.message_end_unique",
      message: `expected exactly one message_end; got ${ends}`
    });
  }
}
function comparePaths(a, b) {
  const as = a.path.split("/").slice(1);
  const bs = b.path.split("/").slice(1);
  const n = Math.min(as.length, bs.length);
  for (let i = 0;i < n; i++) {
    const c = compareSegment(as[i], bs[i]);
    if (c !== 0)
      return c;
  }
  return as.length - bs.length;
}
function compareSegment(a, b) {
  const an = /^\d+$/.test(a) ? Number(a) : NaN;
  const bn = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(an) && !Number.isNaN(bn))
    return an - bn;
  return a < b ? -1 : a > b ? 1 : 0;
}
// src/morphisms/openai_chat.ts
function luv_conversation_to_openai_request(conv, opts) {
  const messages = [];
  for (const node of conv.nodes) {
    const m = node.message;
    if (m.role === "system") {
      const text = concatTextBlocks(m.content);
      messages.push({ role: "system", content: text });
    } else if (m.role === "user") {
      const onlyToolResults = m.content.every((b) => b.kind === "tool_result");
      const onlyText = m.content.every((b) => b.kind === "text");
      if (onlyText) {
        messages.push({ role: "user", content: concatTextBlocks(m.content) });
      } else if (onlyToolResults) {
        for (const b of m.content) {
          if (b.kind === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: b.call_id,
              content: b.text
            });
          }
        }
      } else {
        for (const b of m.content) {
          if (b.kind === "text") {
            messages.push({ role: "user", content: b.text });
          } else if (b.kind === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: b.call_id,
              content: b.text
            });
          }
        }
      }
    } else if (m.role === "assistant") {
      const textPieces = [];
      const toolCalls = [];
      for (const b of m.content) {
        if (b.kind === "text")
          textPieces.push(b.text);
        else if (b.kind === "tool_call") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: b.args }
          });
        }
      }
      const out = {
        role: "assistant",
        content: textPieces.length > 0 ? textPieces.join("") : toolCalls.length > 0 ? null : ""
      };
      if (toolCalls.length > 0)
        out.tool_calls = toolCalls;
      messages.push(out);
    }
  }
  const req = {
    model: opts.model,
    messages
  };
  if (opts.stream !== undefined)
    req.stream = opts.stream;
  if (opts.tools !== undefined)
    req.tools = opts.tools;
  return req;
}
function concatTextBlocks(content) {
  return content.filter((b) => b.kind === "text").map((b) => b.text).join("");
}
function openai_response_to_luv_reply(resp) {
  const r = resp;
  const choice = r.choices[0];
  const msg = choice.message;
  const blocks = [];
  if (typeof msg.content === "string") {
    blocks.push({ kind: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        kind: "tool_call",
        id: tc.id,
        name: tc.function.name,
        args: tc.function.arguments
      });
    }
  }
  return {
    message: { role: "assistant", content: blocks },
    finish_reason: mapFinishReason(choice.finish_reason)
  };
}
function mapFinishReason(r) {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "end_turn";
    default:
      return "end_turn";
  }
}
function openai_stream_to_luv_stream(chunks) {
  const events = [];
  let blockOpen = null;
  let messageStartEmitted = false;
  for (const chunk of chunks) {
    const c = chunk;
    const choice = c.choices[0];
    const delta = choice.delta;
    const finishReason = choice.finish_reason;
    if (delta.role === "assistant" && !messageStartEmitted) {
      events.push({ kind: "message_start" });
      messageStartEmitted = true;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls) {
        if (tcDelta.id !== undefined) {
          if (blockOpen === "text") {
            events.push({ kind: "block_end" });
            blockOpen = null;
          }
          events.push({
            kind: "block_start",
            block: {
              kind: "tool_call",
              id: tcDelta.id,
              name: tcDelta.function?.name ?? "",
              args: ""
            }
          });
          blockOpen = "tool_call";
          const initialArgs = tcDelta.function?.arguments;
          if (typeof initialArgs === "string" && initialArgs.length > 0) {
            events.push({ kind: "args_delta", args: initialArgs });
          }
        } else if (tcDelta.function?.arguments !== undefined && tcDelta.function.arguments !== "") {
          events.push({ kind: "args_delta", args: tcDelta.function.arguments });
        }
      }
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (blockOpen !== "text") {
        if (blockOpen === "tool_call") {
          events.push({ kind: "block_end" });
        }
        events.push({
          kind: "block_start",
          block: { kind: "text", text: "" }
        });
        blockOpen = "text";
      }
      events.push({ kind: "text_delta", text: delta.content });
    }
    if (finishReason !== null && finishReason !== undefined) {
      if (blockOpen !== null) {
        events.push({ kind: "block_end" });
        blockOpen = null;
      }
      events.push({
        kind: "message_end",
        finish_reason: mapFinishReason(finishReason)
      });
    }
  }
  return events;
}

// src/transport/openai_chat.ts
var DEFAULT_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_ON_ERROR = {
  auth: "throw",
  rate_limit: "throw",
  bad_request: "throw",
  content_filter: "as_block",
  server_error: "throw",
  network: "throw",
  tool_execution: "throw",
  local_validation: "throw",
  unknown: "throw"
};
function policyFor(config, category) {
  return config.on_error?.[category] ?? DEFAULT_ON_ERROR[category];
}
function mapStatusToCategory(status) {
  if (status === 401 || status === 403)
    return "auth";
  if (status === 408 || status === 504)
    return "network";
  if (status === 429)
    return "rate_limit";
  if (status === 0)
    return "network";
  if (status >= 500 && status < 600)
    return "server_error";
  if (status >= 400 && status < 500)
    return "bad_request";
  return "unknown";
}
function shortMessageFor(status, category) {
  return `HTTP ${status}: ${category}`;
}
function luv_send_to_openai_http_request(conv, opts, config) {
  const baseUrl = config.base_url ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/chat/completions`;
  const headers = {};
  headers["authorization"] = `Bearer ${config.api_key}`;
  headers["content-type"] = "application/json";
  const optionals = [];
  if (config.organization) {
    optionals.push(["openai-organization", config.organization]);
  }
  if (config.project) {
    optionals.push(["openai-project", config.project]);
  }
  optionals.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const [k, v] of optionals)
    headers[k] = v;
  const body = stringify(luv_conversation_to_openai_request(conv, opts));
  return { method: "POST", url, headers, body };
}
function openai_http_response_to_luv_reply(response) {
  if (response.status >= 200 && response.status < 300) {
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return makeErrorReply("unknown", `HTTP ${response.status}: failed to parse response body as JSON`, { status: response.status, body: response.body });
    }
    return openai_response_to_luv_reply(parsed);
  }
  const category = mapStatusToCategory(response.status);
  return makeErrorReply(category, shortMessageFor(response.status, category), { status: response.status, body: response.body });
}
function makeErrorReply(category, message, detailsObj) {
  return {
    message: {
      role: "assistant",
      content: [
        {
          kind: "error",
          category,
          message,
          details: stringify(detailsObj)
        }
      ]
    },
    finish_reason: "error"
  };
}
function openai_http_stream_to_luv_stream(response) {
  if (response.status < 200 || response.status >= 300) {
    const category = mapStatusToCategory(response.status);
    return [
      { kind: "message_start" },
      {
        kind: "block_start",
        block: {
          kind: "error",
          category,
          message: shortMessageFor(response.status, category),
          details: stringify({ status: response.status, body: response.body })
        }
      },
      { kind: "block_end" },
      { kind: "message_end", finish_reason: "error" }
    ];
  }
  const chunks = parseSSE(response.body);
  return openai_stream_to_luv_stream(chunks);
}
function parseSSE(body) {
  const chunks = [];
  const events = body.split(`

`);
  for (const event of events) {
    for (const line of event.split(`
`)) {
      if (!line.startsWith("data: "))
        continue;
      const payload = line.slice(6);
      if (payload === "[DONE]")
        return chunks;
      try {
        chunks.push(JSON.parse(payload));
      } catch {}
    }
  }
  return chunks;
}
function openaiClient(config) {
  return {
    async send(conv, opts) {
      const req = luv_send_to_openai_http_request(conv, opts, config);
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body
      });
      const httpRes = {
        status: fetchRes.status,
        headers: headersToRecord(fetchRes.headers),
        body: await fetchRes.text()
      };
      const reply = openai_http_response_to_luv_reply(httpRes);
      applyErrorPolicyOrThrow(reply, config);
      return reply;
    },
    async* stream(conv, opts) {
      const req = luv_send_to_openai_http_request(conv, { ...opts, stream: true }, config);
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body
      });
      if (fetchRes.status < 200 || fetchRes.status >= 300) {
        const httpRes = {
          status: fetchRes.status,
          headers: headersToRecord(fetchRes.headers),
          body: await fetchRes.text()
        };
        const events = openai_http_stream_to_luv_stream(httpRes);
        const errBlock = findErrorBlock(events);
        if (errBlock && policyFor(config, errBlock.category) === "throw") {
          throw new LuvError({
            category: errBlock.category,
            message: errBlock.message,
            details: errBlock.details
          });
        }
        for (const e of events)
          yield e;
        return;
      }
      yield* streamSSE(fetchRes);
    }
  };
}
function headersToRecord(h) {
  const out = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}
function findErrorBlock(events) {
  for (const e of events) {
    if (e.kind === "block_start" && e.block.kind === "error") {
      return {
        category: e.block.category,
        message: e.block.message,
        details: e.block.details
      };
    }
  }
  return null;
}
function applyErrorPolicyOrThrow(reply, config) {
  for (const block of reply.message.content) {
    if (block.kind === "error") {
      const policy = policyFor(config, block.category);
      if (policy === "throw") {
        throw new LuvError({
          category: block.category,
          message: block.message,
          details: block.details
        });
      }
    }
  }
}
async function* streamSSE(res) {
  if (!res.body)
    return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const state = createStreamState();
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf(`

`)) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split(`
`)) {
        if (!line.startsWith("data: "))
          continue;
        const payload = line.slice(6);
        if (payload === "[DONE]")
          return;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const ev of processChunk(state, chunk))
          yield ev;
      }
    }
  }
}
function createStreamState() {
  return { blockOpen: null, messageStartEmitted: false };
}
function processChunk(state, chunk) {
  const out = [];
  const c = chunk;
  const choice = c.choices[0];
  const delta = choice.delta;
  const finishReason = choice.finish_reason;
  if (delta.role === "assistant" && !state.messageStartEmitted) {
    out.push({ kind: "message_start" });
    state.messageStartEmitted = true;
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tcDelta of delta.tool_calls) {
      if (tcDelta.id !== undefined) {
        if (state.blockOpen === "text") {
          out.push({ kind: "block_end" });
          state.blockOpen = null;
        }
        out.push({
          kind: "block_start",
          block: {
            kind: "tool_call",
            id: tcDelta.id,
            name: tcDelta.function?.name ?? "",
            args: ""
          }
        });
        state.blockOpen = "tool_call";
        const initialArgs = tcDelta.function?.arguments;
        if (typeof initialArgs === "string" && initialArgs.length > 0) {
          out.push({ kind: "args_delta", args: initialArgs });
        }
      } else if (tcDelta.function?.arguments !== undefined && tcDelta.function.arguments !== "") {
        out.push({ kind: "args_delta", args: tcDelta.function.arguments });
      }
    }
  }
  if (typeof delta.content === "string" && delta.content.length > 0) {
    if (state.blockOpen !== "text") {
      if (state.blockOpen === "tool_call") {
        out.push({ kind: "block_end" });
      }
      out.push({ kind: "block_start", block: { kind: "text", text: "" } });
      state.blockOpen = "text";
    }
    out.push({ kind: "text_delta", text: delta.content });
  }
  if (finishReason !== null && finishReason !== undefined) {
    if (state.blockOpen !== null) {
      out.push({ kind: "block_end" });
      state.blockOpen = null;
    }
    out.push({
      kind: "message_end",
      finish_reason: mapFinishReason2(finishReason)
    });
  }
  return out;
}
function mapFinishReason2(r) {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "end_turn";
    default:
      return "end_turn";
  }
}
// src/morphisms/anthropic_messages.ts
function luv_conversation_to_anthropic_request(conv, opts) {
  const systemTexts = [];
  const initial = [];
  for (const node of conv.nodes) {
    const m = node.message;
    if (m.role === "system") {
      const txt = m.content.filter((b) => b.kind === "text").map((b) => b.text).join("");
      systemTexts.push(txt);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant")
      continue;
    const allText = m.content.every((b) => b.kind === "text");
    let content;
    if (allText) {
      content = m.content.map((b) => b.text).join("");
    } else {
      const arr = [];
      for (const b of m.content) {
        const cb = blockToAnthropic(b);
        if (cb !== null)
          arr.push(cb);
      }
      content = arr.length > 0 ? arr : "";
    }
    initial.push({ role: m.role, content });
  }
  const merged = [];
  for (const msg of initial) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.role !== msg.role) {
      merged.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (typeof prev.content === "string" && typeof msg.content === "string") {
      prev.content = prev.content + msg.content;
    } else {
      const prevArr = typeof prev.content === "string" ? prev.content.length > 0 ? [{ type: "text", text: prev.content }] : [] : prev.content;
      const newArr = typeof msg.content === "string" ? msg.content.length > 0 ? [{ type: "text", text: msg.content }] : [] : msg.content;
      prev.content = [...prevArr, ...newArr];
    }
  }
  const req = {
    model: opts.model,
    max_tokens: opts.max_tokens,
    messages: merged
  };
  if (systemTexts.length > 0)
    req.system = systemTexts.join(`

`);
  if (opts.stream !== undefined)
    req.stream = opts.stream;
  if (opts.tools !== undefined)
    req.tools = opts.tools;
  if (opts.tool_choice !== undefined)
    req.tool_choice = opts.tool_choice;
  if (opts.temperature !== undefined)
    req.temperature = opts.temperature;
  if (opts.stop_sequences !== undefined)
    req.stop_sequences = opts.stop_sequences;
  return req;
}
function blockToAnthropic(b) {
  if (b.kind === "text") {
    return { type: "text", text: b.text };
  }
  if (b.kind === "tool_call") {
    let input = {};
    try {
      input = JSON.parse(b.args);
    } catch {}
    return { type: "tool_use", id: b.id, name: b.name, input };
  }
  if (b.kind === "tool_result") {
    return { type: "tool_result", tool_use_id: b.call_id, content: b.text };
  }
  return null;
}
function anthropic_response_to_luv_reply(resp) {
  const r = resp;
  const blocks = [];
  for (const cb of r.content) {
    if (cb.type === "text") {
      blocks.push({ kind: "text", text: cb.text });
    } else if (cb.type === "tool_use") {
      blocks.push({
        kind: "tool_call",
        id: cb.id,
        name: cb.name,
        args: JSON.stringify(cb.input)
      });
    }
  }
  return {
    message: { role: "assistant", content: blocks },
    finish_reason: mapStopReason(r.stop_reason)
  };
}
function mapStopReason(r) {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "end_turn";
    default:
      return "end_turn";
  }
}
function anthropic_stream_to_luv_stream(events) {
  const out = [];
  let storedStopReason = null;
  for (const evt of events) {
    const e = evt;
    switch (e.type) {
      case "message_start":
        out.push({ kind: "message_start" });
        break;
      case "content_block_start": {
        const cb = e.content_block;
        if (!cb)
          break;
        if (cb.type === "text") {
          out.push({
            kind: "block_start",
            block: { kind: "text", text: "" }
          });
        } else if (cb.type === "tool_use") {
          out.push({
            kind: "block_start",
            block: {
              kind: "tool_call",
              id: cb.id ?? "",
              name: cb.name ?? "",
              args: ""
            }
          });
        }
        break;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (!d)
          break;
        if (d.type === "text_delta" && typeof d.text === "string") {
          out.push({ kind: "text_delta", text: d.text });
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          out.push({ kind: "args_delta", args: d.partial_json });
        }
        break;
      }
      case "content_block_stop":
        out.push({ kind: "block_end" });
        break;
      case "message_delta":
        if (e.delta && typeof e.delta.stop_reason === "string") {
          storedStopReason = e.delta.stop_reason;
        }
        break;
      case "message_stop":
        out.push({
          kind: "message_end",
          finish_reason: mapStopReason(storedStopReason)
        });
        break;
      case "ping":
      default:
        break;
    }
  }
  return out;
}

// src/transport/anthropic_messages.ts
var DEFAULT_BASE_URL2 = "https://api.anthropic.com/v1";
var DEFAULT_VERSION = "2023-06-01";
var DEFAULT_MAX_TOKENS = 4096;
var DEFAULT_ON_ERROR2 = {
  auth: "throw",
  rate_limit: "throw",
  bad_request: "throw",
  content_filter: "as_block",
  server_error: "throw",
  network: "throw",
  tool_execution: "throw",
  local_validation: "throw",
  unknown: "throw"
};
function policyFor2(config, category) {
  return config.on_error?.[category] ?? DEFAULT_ON_ERROR2[category];
}
function mapStatusToCategory2(status) {
  if (status === 401 || status === 403)
    return "auth";
  if (status === 408 || status === 504)
    return "network";
  if (status === 429)
    return "rate_limit";
  if (status === 0)
    return "network";
  if (status >= 500 && status < 600)
    return "server_error";
  if (status >= 400 && status < 500)
    return "bad_request";
  return "unknown";
}
function shortMessageFor2(status, category) {
  return `HTTP ${status}: ${category}`;
}
function luv_send_to_anthropic_http_request(conv, opts, config) {
  const baseUrl = config.base_url ?? DEFAULT_BASE_URL2;
  const version = config.anthropic_version ?? DEFAULT_VERSION;
  const url = `${baseUrl}/messages`;
  const headers = {};
  headers["anthropic-version"] = version;
  headers["content-type"] = "application/json";
  headers["x-api-key"] = config.api_key;
  const body = stringify(luv_conversation_to_anthropic_request(conv, opts));
  return { method: "POST", url, headers, body };
}
function anthropic_http_response_to_luv_reply(response) {
  if (response.status >= 200 && response.status < 300) {
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return makeErrorReply2("unknown", `HTTP ${response.status}: failed to parse response body as JSON`, { status: response.status, body: response.body });
    }
    return anthropic_response_to_luv_reply(parsed);
  }
  const category = mapStatusToCategory2(response.status);
  return makeErrorReply2(category, shortMessageFor2(response.status, category), {
    status: response.status,
    body: response.body
  });
}
function makeErrorReply2(category, message, detailsObj) {
  return {
    message: {
      role: "assistant",
      content: [
        {
          kind: "error",
          category,
          message,
          details: stringify(detailsObj)
        }
      ]
    },
    finish_reason: "error"
  };
}
function anthropic_http_stream_to_luv_stream(response) {
  if (response.status < 200 || response.status >= 300) {
    const category = mapStatusToCategory2(response.status);
    return [
      { kind: "message_start" },
      {
        kind: "block_start",
        block: {
          kind: "error",
          category,
          message: shortMessageFor2(response.status, category),
          details: stringify({ status: response.status, body: response.body })
        }
      },
      { kind: "block_end" },
      { kind: "message_end", finish_reason: "error" }
    ];
  }
  const events = parseSSE2(response.body);
  return anthropic_stream_to_luv_stream(events);
}
function parseSSE2(body) {
  const events = [];
  for (const block of body.split(`

`)) {
    for (const line of block.split(`
`)) {
      if (!line.startsWith("data: "))
        continue;
      const payload = line.slice(6);
      try {
        events.push(JSON.parse(payload));
      } catch {}
    }
  }
  return events;
}
function anthropicClient(config) {
  return {
    async send(conv, opts) {
      const effectiveOpts = {
        ...opts,
        max_tokens: opts.max_tokens ?? config.default_max_tokens ?? DEFAULT_MAX_TOKENS
      };
      const req = luv_send_to_anthropic_http_request(conv, effectiveOpts, config);
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body
      });
      const httpRes = {
        status: fetchRes.status,
        headers: headersToRecord2(fetchRes.headers),
        body: await fetchRes.text()
      };
      const reply = anthropic_http_response_to_luv_reply(httpRes);
      applyErrorPolicyOrThrow2(reply, config);
      return reply;
    },
    async* stream(conv, opts) {
      const effectiveOpts = {
        ...opts,
        max_tokens: opts.max_tokens ?? config.default_max_tokens ?? DEFAULT_MAX_TOKENS,
        stream: true
      };
      const req = luv_send_to_anthropic_http_request(conv, effectiveOpts, config);
      const fetchRes = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body
      });
      if (fetchRes.status < 200 || fetchRes.status >= 300) {
        const httpRes = {
          status: fetchRes.status,
          headers: headersToRecord2(fetchRes.headers),
          body: await fetchRes.text()
        };
        const events = anthropic_http_stream_to_luv_stream(httpRes);
        const errBlock = findErrorBlock2(events);
        if (errBlock && policyFor2(config, errBlock.category) === "throw") {
          throw new LuvError({
            category: errBlock.category,
            message: errBlock.message,
            details: errBlock.details
          });
        }
        for (const e of events)
          yield e;
        return;
      }
      yield* streamSSE2(fetchRes);
    }
  };
}
function headersToRecord2(h) {
  const out = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}
function findErrorBlock2(events) {
  for (const e of events) {
    if (e.kind === "block_start" && e.block.kind === "error") {
      return {
        category: e.block.category,
        message: e.block.message,
        details: e.block.details
      };
    }
  }
  return null;
}
function applyErrorPolicyOrThrow2(reply, config) {
  for (const block of reply.message.content) {
    if (block.kind === "error") {
      const policy = policyFor2(config, block.category);
      if (policy === "throw") {
        throw new LuvError({
          category: block.category,
          message: block.message,
          details: block.details
        });
      }
    }
  }
}
async function* streamSSE2(res) {
  if (!res.body)
    return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const state = createStreamState2();
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf(`

`)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split(`
`)) {
        if (!line.startsWith("data: "))
          continue;
        const payload = line.slice(6);
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const ev of processEvent(state, evt))
          yield ev;
      }
    }
  }
}
function createStreamState2() {
  return { storedStopReason: null };
}
function processEvent(state, evt) {
  const out = [];
  const e = evt;
  switch (e.type) {
    case "message_start":
      out.push({ kind: "message_start" });
      break;
    case "content_block_start": {
      const cb = e.content_block;
      if (!cb)
        break;
      if (cb.type === "text") {
        out.push({
          kind: "block_start",
          block: { kind: "text", text: "" }
        });
      } else if (cb.type === "tool_use") {
        out.push({
          kind: "block_start",
          block: {
            kind: "tool_call",
            id: cb.id ?? "",
            name: cb.name ?? "",
            args: ""
          }
        });
      }
      break;
    }
    case "content_block_delta": {
      const d = e.delta;
      if (!d)
        break;
      if (d.type === "text_delta" && typeof d.text === "string") {
        out.push({ kind: "text_delta", text: d.text });
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        out.push({ kind: "args_delta", args: d.partial_json });
      }
      break;
    }
    case "content_block_stop":
      out.push({ kind: "block_end" });
      break;
    case "message_delta":
      if (e.delta && typeof e.delta.stop_reason === "string") {
        state.storedStopReason = e.delta.stop_reason;
      }
      break;
    case "message_stop":
      out.push({
        kind: "message_end",
        finish_reason: mapStopReason2(state.storedStopReason)
      });
      break;
    default:
      break;
  }
  return out;
}
function mapStopReason2(r) {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "end_turn";
    default:
      return "end_turn";
  }
}
export {
  validate_luv_stream_reply,
  validate_luv_reply,
  validate_luv_message,
  validate_luv_conversation,
  validate_luv_block,
  stringify,
  produce_luv_stream_reply,
  openai_http_stream_to_luv_stream,
  openai_http_response_to_luv_reply,
  openaiClient,
  luv_send_to_openai_http_request,
  luv_send_to_anthropic_http_request,
  encodeValidationResult,
  encodeValidationError,
  encodeStreamReply,
  encodeStreamEventReply,
  encodeReply,
  encodeNode,
  encodeMessage,
  encodeConversation,
  encodeBlock,
  consume_luv_stream_reply,
  anthropic_http_stream_to_luv_stream,
  anthropic_http_response_to_luv_reply,
  anthropicClient,
  LuvError,
  LUV_SPEC_VERSION,
  ERROR_CATEGORIES
};
