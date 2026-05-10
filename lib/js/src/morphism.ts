// Pure-TS port of core/src/morphisms/openai/openai.zig.
// Same shape contract; same fixture-validated semantics.
//
// Loss table (luv ↔ openai):
//
// luv → openai (toOpenAI):
//   - Roles map to lowercase strings: "system"|"user"|"assistant"|"tool".
//   - Conversation order preserved verbatim; consecutive same-role accepted.
//   - Optional fields are emitted only when set (no JSON null literals).
//   - Tools: luv Tool[] → OpenAI's [{type:"function", function:{name, description, parameters}}].
//     The tool's `handler` is dropped (not part of wire). `inputSchema` becomes `parameters`.
//   - Assistant.toolCalls: each ToolCall becomes a {id, type:"function",
//     function:{name, arguments:<stringified JSON>}} entry. content becomes
//     null when present-but-empty AND tool_calls non-empty (OpenAI convention).
//   - Tool messages: {role:"tool", tool_call_id, content}. ok results pass content
//     through; err results prefix with "Error: ".
//
// openai → luv (fromOpenAI):
//   - First choice only is taken (n>1 is out of scope).
//   - choice.message.role coerced to "assistant" unconditionally.
//   - choice.message.content used; if null, choice.message.refusal substituted (lossy).
//   - choice.message.tool_calls: each entry parsed back to luv ToolCall, with
//     `arguments` parsed from the wire string into a structured value.
//   - finish_reason mapping:
//       "stop"          → end_turn
//       "length"        → max_tokens
//       "content_filter" → content_filter
//       "tool_calls" | "function_call" → tool_use
//       anything else   → other
//   - Dropped: id, object, created, model, system_fingerprint, service_tier,
//     usage (and all subfields), choice.index, choice.logprobs,
//     message.annotations, message.audio.

import type {
  Conversation,
  JSONSchema,
  Reply,
  StopReason,
  Tool,
  ToolCall,
  Usage,
} from "./types.ts";

export interface ToOpenAIOptions {
  readonly conversation: Conversation;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly tools?: readonly Tool[];
}

interface OpenAIWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIWireToolCall[];
  tool_call_id?: string;
}

interface OpenAIWireToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface OpenAIWireRequest {
  model: string;
  messages: OpenAIWireMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: OpenAIWireToolDef[];
}

interface OpenAIWireResponseToolCall {
  readonly id: string;
  readonly type?: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAIWireUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

export interface OpenAIWireResponse {
  readonly id?: string;
  readonly object?: string;
  readonly created?: number;
  readonly model?: string;
  readonly choices: ReadonlyArray<{
    readonly index?: number;
    readonly message: {
      readonly role: string;
      readonly content?: string | null;
      readonly refusal?: string | null;
      readonly tool_calls?: readonly OpenAIWireResponseToolCall[];
    };
    readonly finish_reason: string;
  }>;
  readonly usage?: OpenAIWireUsage;
}

export class MorphismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorphismError";
  }
}

export function toOpenAI(opts: ToOpenAIOptions): OpenAIWireRequest {
  const messages: OpenAIWireMessage[] = [];
  for (const m of opts.conversation) {
    if (m.role === "tool") {
      const content = m.result.ok ? m.result.content : `Error: ${m.result.error}`;
      messages.push({ role: "tool", tool_call_id: m.callId, content });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const wireCalls: OpenAIWireToolCall[] = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
      const wireMsg: OpenAIWireMessage = {
        role: "assistant",
        tool_calls: wireCalls,
      };
      // Only include `content` when there's actual text. OpenAI accepts the
      // field being either absent or null when an assistant message has only
      // tool_calls; we omit it for cleaner cross-implementation parity.
      if (m.text !== "") wireMsg.content = m.text;
      messages.push(wireMsg);
      continue;
    }
    messages.push({ role: m.role, content: m.text });
  }

  const out: OpenAIWireRequest = {
    model: opts.model,
    messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    out.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }
  if (opts.maxTokens !== undefined) out.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.stream) out.stream = true;
  return out;
}

export function fromOpenAI(wire: OpenAIWireResponse): Reply {
  if (!wire.choices || wire.choices.length === 0) {
    throw new MorphismError("fromOpenAI: response has no choices");
  }
  const choice = wire.choices[0]!;
  const text = choice.message.content ?? choice.message.refusal ?? "";
  const stopReason = stopReasonFromFinishReason(choice.finish_reason);
  const usage = mapUsage(wire.usage);

  const wireCalls = choice.message.tool_calls;
  if (wireCalls && wireCalls.length > 0) {
    const toolCalls: ToolCall[] = wireCalls.map((c) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(c.function.arguments);
      } catch {
        throw new MorphismError(
          `fromOpenAI: tool_call.function.arguments is not valid JSON: ${c.function.arguments.slice(0, 80)}`,
        );
      }
      return { id: c.id, name: c.function.name, arguments: parsed };
    });
    return {
      message: { role: "assistant", text, toolCalls },
      stopReason,
      ...(usage && { usage }),
    };
  }

  return {
    message: { role: "assistant", text },
    stopReason,
    ...(usage && { usage }),
  };
}

function mapUsage(u: OpenAIWireUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  // OpenAI always sends all three when usage is present, but defensively coerce.
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

function stopReasonFromFinishReason(s: string): StopReason {
  switch (s) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}
