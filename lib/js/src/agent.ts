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
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const maxIterations = opts.maxIterations ?? 10;
  const tools = opts.tools ?? [];
  let conversation: Message[] = [...opts.conversation];
  let iterations = 0;

  while (true) {
    iterations++;

    if (opts.signal?.aborted) return done("aborted");
    if (iterations > maxIterations) return done("max_iterations");

    opts.onTurnStart?.(iterations);

    let reply;
    try {
      reply = await opts.provider.send({
        model: opts.model,
        conversation,
        tools: projectTools(tools),
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.signal && { signal: opts.signal }),
      });
    } catch (err) {
      return done("error", err instanceof Error ? err : new Error(String(err)));
    }

    if (opts.signal?.aborted) return done("aborted");

    const callsRequested =
      reply.message.role === "assistant" ? reply.message.toolCalls ?? [] : [];

    if (reply.message.role !== "assistant" || callsRequested.length === 0) {
      conversation = [...conversation, reply.message];
      return done("end_turn");
    }

    // Execute all tool calls in parallel, with hooks.
    for (const c of callsRequested) opts.onToolCall?.(c);
    const results = await executeToolCalls(callsRequested, tools, opts.signal);
    for (const { call, result } of results) opts.onToolResult?.(call, result);

    // Colocate results onto the assistant message's toolCalls — no
    // separate `.tool` follow-up message.
    const resolvedCalls: ToolCall[] = callsRequested.map((c) => {
      const r = results.find((x) => x.call.id === c.id)!;
      return { ...c, result: r.result };
    });
    conversation = [
      ...conversation,
      { role: "assistant", text: reply.message.text, toolCalls: resolvedCalls },
    ];
  }

  function done(reason: AgentFinishReason, error?: Error): AgentResult {
    opts.onFinish?.(reason);
    return { conversation, reason, iterations, ...(error && { error }) };
  }
}
