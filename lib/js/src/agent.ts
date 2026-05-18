// runAgent: the default agent loop. Pure function on the conversation array
// — never owns state, never returns anything other than a luv-shaped result.
//
// agentStep: single iteration of the same loop, returning the messages just
// added plus a `done` flag. Lets callers drive the loop themselves for
// pause/resume/approval flows.

import type {
  AgentFinishReason,
  AgentOptions,
  AgentResult,
  Conversation,
  Decision,
  Message,
  Provider,
  Stage,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from "./types.ts";
import {
  encodeSendRequest,
  encodeReply,
  decodeConversation,
  decodeToolCalls,
  type CodecMessage,
  type CodecToolCall,
} from "./codec.ts";
import {
  agentStart,
  agentPoll,
  agentFeedReply,
  agentFeedTools,
  agentAbort,
  agentDestroy,
} from "./wasm/sync.ts";

/**
 * Weave stage descriptions into a tool description for the LLM's view.
 * Stages with no description are skipped. If nothing to weave, returns
 * the original string.
 */
export function describeWithStages(
  description: string,
  stages: readonly Stage[] | undefined,
): string {
  if (!stages) return description;
  const meaningful = stages.filter((s) => s.description && s.description.length > 0);
  if (meaningful.length === 0) return description;
  let out = description + "\n\nThis tool runs through the following stages before execution:";
  for (const s of meaningful) out += `\n- ${s.kind}: ${s.description}`;
  return out;
}

/** Project tools to their wire-side view: handler + stages dropped,
 *  description enriched with stage metadata. */
function projectTools(tools: readonly Tool[]): readonly Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: describeWithStages(t.description, t.stages),
    inputSchema: t.inputSchema,
    handler: t.handler, // kept for type compatibility; provider doesn't read it
  }));
}

export interface AgentStepOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly conversation: Conversation;
  readonly tools?: readonly Tool[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Fires once before the provider.send call, with the iteration count
   *  (always 1 for a single step — provided for parity with `runAgent`). */
  readonly onTurnStart?: (iteration: number) => void;
  /** Fires once per tool call requested by the model. */
  readonly onToolCall?: (call: ToolCall) => void;
  /** Fires after each tool's handler returns. */
  readonly onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /** Fires once when the step terminates, with the same `reason` as the result. */
  readonly onFinish?: (reason: AgentStepReason) => void;
}

export type AgentStepReason = "continue" | "end_turn" | "aborted" | "error";

export interface AgentStepResult {
  /** Messages this step added to the conversation (assistant + any tool results). */
  readonly newMessages: readonly Message[];
  /** True when the loop should stop (no further send is needed). */
  readonly done: boolean;
  /** Why this step ended the way it did. */
  readonly reason: AgentStepReason;
  /** Set when the step ended because of a thrown error (reason === "error"). */
  readonly error?: Error;
}

/** Run a single iteration of the agent loop.
 *
 * On a normal turn returns the assistant reply plus any tool-result messages
 * that were produced by executing the model's tool calls. The caller appends
 * `newMessages` to their own conversation array, optionally inspects/modifies
 * it, then calls `agentStep` again until `done` is true.
 */
export async function agentStep(opts: AgentStepOptions): Promise<AgentStepResult> {
  function finish(result: AgentStepResult): AgentStepResult {
    opts.onFinish?.(result.reason);
    return result;
  }

  if (opts.signal?.aborted) {
    return finish({ newMessages: [], done: true, reason: "aborted" });
  }

  const tools = opts.tools ?? [];
  const newMessages: Message[] = [];

  opts.onTurnStart?.(1);

  let reply;
  try {
    reply = await opts.provider.send({
      model: opts.model,
      conversation: opts.conversation,
      tools: projectTools(tools),
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.signal && { signal: opts.signal }),
    });
  } catch (err) {
    return finish({
      newMessages: [],
      done: true,
      reason: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  if (opts.signal?.aborted) {
    return finish({ newMessages: [], done: true, reason: "aborted" });
  }

  const callsRequested =
    reply.message.role === "assistant" ? (reply.message.toolCalls ?? []) : [];

  if (reply.message.role !== "assistant" || callsRequested.length === 0) {
    newMessages.push(reply.message);
    return finish({ newMessages, done: true, reason: "end_turn" });
  }

  for (const c of callsRequested) opts.onToolCall?.(c);
  const results = await executeToolCalls(callsRequested, tools, opts.signal);
  for (const { call, result } of results) opts.onToolResult?.(call, result);

  // Colocate results onto the calls themselves; emit one assistant message
  // (with resolved toolCalls), not a follow-up `.tool` message.
  const resolvedCalls: ToolCall[] = callsRequested.map((c) => {
    const r = results.find((x) => x.call.id === c.id)!;
    return { ...c, result: r.result };
  });
  newMessages.push({
    role: "assistant",
    text: reply.message.text,
    toolCalls: resolvedCalls,
  });
  return finish({ newMessages, done: false, reason: "continue" });
}

async function executeToolCalls(
  calls: readonly ToolCall[],
  tools: readonly Tool[],
  signal?: AbortSignal,
): Promise<Array<{ call: ToolCall; result: ToolResult }>> {
  return Promise.all(
    calls.map(async (call) => {
      const tool = tools.find((t) => t.name === call.name);
      let result: ToolResult;
      if (!tool) {
        result = { ok: false, error: `unknown tool: ${call.name}` };
      } else {
        const ctx: ToolContext = signal ? { signal } : {};
        let currentArgs = call.arguments;
        let shortCircuit: ToolResult | undefined;

        // Run pre-handler stages in order.
        for (const stage of tool.stages ?? []) {
          const view: ToolCall = { id: call.id, name: call.name, arguments: currentArgs };
          let decision: Decision;
          try {
            decision = await stage.fn(view, ctx);
          } catch (err) {
            shortCircuit = { ok: false, error: err instanceof Error ? err.message : String(err) };
            break;
          }
          if (decision.kind === "run") continue;
          if (decision.kind === "edit") { currentArgs = decision.args; continue; }
          if (decision.kind === "deny") { shortCircuit = { ok: false, error: decision.error }; break; }
          if (decision.kind === "synthesize") { shortCircuit = decision.result; break; }
        }

        if (shortCircuit !== undefined) {
          result = shortCircuit;
        } else {
          try {
            result = await tool.handler(currentArgs, ctx);
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }
      return { call, result };
    }),
  );
}

/**
 * Run the default agent loop until the model stops calling tools.
 *
 * On each iteration: send the conversation to the provider, append the
 * assistant reply, execute any requested tool calls in parallel, append
 * each tool's result message. Repeat until either the model returns a turn
 * with no tool calls (`reason: "end_turn"`), the iteration cap fires
 * (`reason: "max_iterations"`), the signal aborts (`reason: "aborted"`),
 * or the provider throws (`reason: "error"`, with `result.error` set).
 *
 * The returned `AgentResult.conversation` is a fresh `Message[]` containing
 * the input conversation plus every assistant + tool message added by the
 * loop — append it to your own state, persist it, fork it, whatever.
 *
 * For pause/resume / approval flows where you need to drive the loop one
 * iteration at a time, use {@link agentStep} instead.
 *
 * @example
 * const result = await runAgent({
 *   provider: openaiProvider({ apiKey }),
 *   model: "gpt-4o-mini",
 *   conversation: [{ role: "user", text: "what's 17 * 23?" }],
 *   tools: [calcTool],
 * });
 * console.log(result.reason, result.iterations);
 */
// --- ergonomic <-> codec mapping (the agent loop is single-sourced in Zig;
// agent.ts is the host driver: it performs provider.send + executeToolCalls
// effects and derives the lifecycle hooks from the effect stream). ----------

const ROLE_N: Record<"system" | "user" | "assistant", number> = {
  system: 0,
  user: 1,
  assistant: 2,
};
const STOP_N: Record<string, number> = {
  end_turn: 0,
  max_tokens: 1,
  content_filter: 2,
  stop_sequence: 3,
  tool_use: 4,
  other: 5,
};
const FINISH: readonly AgentFinishReason[] = [
  "end_turn",
  "max_iterations",
  "aborted",
  "error",
];

function toCodecMsgs(conv: readonly Message[]): CodecMessage[] {
  return conv.map((m) => ({
    role: ROLE_N[m.role],
    text: m.text,
    toolCalls:
      m.role === "assistant" && m.toolCalls
        ? m.toolCalls.map(
            (c): CodecToolCall => ({
              id: c.id,
              name: c.name,
              args: JSON.stringify(c.arguments),
              result:
                c.result === undefined
                  ? null
                  : c.result.ok
                    ? { ok: true, content: c.result.content }
                    : { ok: false, content: c.result.error },
            }),
          )
        : [],
  }));
}

function fromCodecMsgs(msgs: CodecMessage[]): Message[] {
  const NAME = ["system", "user", "assistant"] as const;
  return msgs.map((m): Message => {
    const role = NAME[m.role] ?? "user";
    if (role === "assistant") {
      if (m.toolCalls.length === 0) return { role, text: m.text };
      return {
        role,
        text: m.text,
        toolCalls: m.toolCalls.map((c) => {
          const base: ToolCall = {
            id: c.id,
            name: c.name,
            arguments: JSON.parse(c.args) as unknown,
          };
          if (c.result === null) return base;
          return {
            ...base,
            result: c.result.ok
              ? { ok: true, content: c.result.content }
              : { ok: false, error: c.result.content },
          };
        }),
      };
    }
    return { role, text: m.text };
  });
}

function withFlag(b: Uint8Array, flag: number): Uint8Array {
  const o = new Uint8Array(b.length + 1);
  o.set(b);
  o[b.length] = flag;
  return o;
}

function encodeToolResults(
  results: ReadonlyArray<{ result: ToolResult }>,
): Uint8Array {
  const enc = new TextEncoder();
  const blobs = results.map(({ result }) =>
    enc.encode(result.ok ? result.content : result.error),
  );
  let size = 4;
  for (const b of blobs) size += 1 + 4 + b.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, results.length, true);
  let pos = 4;
  for (let i = 0; i < results.length; i++) {
    out[pos] = results[i]!.result.ok ? 1 : 0;
    pos += 1;
    dv.setUint32(pos, blobs[i]!.length, true);
    pos += 4;
    out.set(blobs[i]!, pos);
    pos += blobs[i]!.length;
  }
  return out;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const tools = opts.tools ?? [];
  const wireTools = projectTools(tools);
  const maxIterations = opts.maxIterations ?? 10;

  const sr = encodeSendRequest({
    model: opts.model,
    messages: toCodecMsgs(opts.conversation),
    maxTokens: opts.maxTokens ?? null,
    temperature: opts.temperature ?? null,
    stream: false,
    tools: wireTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: JSON.stringify(t.inputSchema),
    })),
  });
  const startBuf = new Uint8Array(4 + sr.length + 4);
  const sdv = new DataView(startBuf.buffer);
  sdv.setUint32(0, sr.length, true);
  startBuf.set(sr, 4);
  sdv.setUint32(4 + sr.length, maxIterations, true);

  const handle = agentStart(startBuf);
  let iterations = 0;
  let providerError: Error | undefined;
  try {
    while (true) {
      if (opts.signal?.aborted) agentAbort(handle);
      const frame = agentPoll(handle);
      const tag = frame[0];
      const payload = frame.subarray(1);
      const pdv = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      );

      if (tag === 2) {
        const reason = FINISH[payload[0]!] ?? "error";
        const iters = pdv.getUint32(1, true);
        const conversation = fromCodecMsgs(
          decodeConversation(payload.subarray(5)),
        );
        opts.onFinish?.(reason);
        return {
          conversation,
          reason,
          iterations: iters,
          ...(reason === "error" && providerError && { error: providerError }),
        };
      }

      if (tag === 0) {
        const conversation = fromCodecMsgs(decodeConversation(payload));
        iterations++;
        opts.onTurnStart?.(iterations);
        let reply;
        try {
          reply = await opts.provider.send({
            model: opts.model,
            conversation,
            tools: wireTools,
            ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
            ...(opts.temperature !== undefined && {
              temperature: opts.temperature,
            }),
            ...(opts.signal && { signal: opts.signal }),
          });
        } catch (err) {
          providerError = err instanceof Error ? err : new Error(String(err));
          agentFeedReply(
            handle,
            withFlag(
              encodeReply({
                role: 2,
                stopReason: 0,
                text: "",
                toolCalls: [],
                usage: null,
              }),
              1,
            ),
          );
          continue;
        }
        if (opts.signal?.aborted) {
          agentAbort(handle);
          continue;
        }
        const cr = {
          role: ROLE_N[reply.message.role],
          stopReason: STOP_N[reply.stopReason] ?? 5,
          text: reply.message.text,
          toolCalls:
            reply.message.role === "assistant" && reply.message.toolCalls
              ? reply.message.toolCalls.map(
                  (c): CodecToolCall => ({
                    id: c.id,
                    name: c.name,
                    args: JSON.stringify(c.arguments),
                    result:
                      c.result === undefined
                        ? null
                        : c.result.ok
                          ? { ok: true, content: c.result.content }
                          : { ok: false, content: c.result.error },
                  }),
                )
              : [],
          usage: reply.usage
            ? {
                prompt: reply.usage.promptTokens,
                completion: reply.usage.completionTokens,
                total: reply.usage.totalTokens,
              }
            : null,
        };
        agentFeedReply(handle, withFlag(encodeReply(cr), 0));
        continue;
      }

      // tag === 1: tool_calls
      const calls: ToolCall[] = decodeToolCalls(payload).map((c) => ({
        id: c.id,
        name: c.name,
        arguments: JSON.parse(c.args) as unknown,
      }));
      for (const c of calls) opts.onToolCall?.(c);
      const results = await executeToolCalls(calls, tools, opts.signal);
      for (const { call, result } of results) opts.onToolResult?.(call, result);
      agentFeedTools(handle, encodeToolResults(results));
    }
  } finally {
    agentDestroy(handle);
  }
}
