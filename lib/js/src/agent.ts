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
  Message,
  Provider,
  Tool,
  ToolCall,
  ToolResult,
} from "./types.ts";

export interface AgentStepOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly conversation: Conversation;
  readonly tools?: readonly Tool[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type AgentStepReason = "continue" | "end_turn" | "aborted" | "error";

export interface AgentStepResult {
  /** Messages this step added to the conversation (assistant + any tool results). */
  readonly newMessages: readonly Message[];
  /** True when the loop should stop (no further send is needed). */
  readonly done: boolean;
  /** Why this step ended the way it did. */
  readonly reason: AgentStepReason;
}

/** Run a single iteration of the agent loop.
 *
 * On a normal turn returns the assistant reply plus any tool-result messages
 * that were produced by executing the model's tool calls. The caller appends
 * `newMessages` to their own conversation array, optionally inspects/modifies
 * it, then calls `agentStep` again until `done` is true.
 */
export async function agentStep(opts: AgentStepOptions): Promise<AgentStepResult> {
  if (opts.signal?.aborted) {
    return { newMessages: [], done: true, reason: "aborted" };
  }

  const tools = opts.tools ?? [];
  const newMessages: Message[] = [];

  let reply;
  try {
    reply = await opts.provider.send({
      model: opts.model,
      conversation: opts.conversation,
      tools,
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.signal && { signal: opts.signal }),
    });
  } catch {
    return { newMessages: [], done: true, reason: "error" };
  }

  if (opts.signal?.aborted) {
    return { newMessages: [], done: true, reason: "aborted" };
  }

  newMessages.push(reply.message);

  const callsRequested =
    reply.message.role === "assistant" ? (reply.message.toolCalls ?? []) : [];

  if (callsRequested.length === 0) {
    return { newMessages, done: true, reason: "end_turn" };
  }

  const results = await executeToolCalls(callsRequested, tools, opts.signal);
  for (const { call, result } of results) {
    newMessages.push({ role: "tool", callId: call.id, result });
  }
  return { newMessages, done: false, reason: "continue" };
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
        try {
          result = await tool.handler(call.arguments, {
            ...(signal && { signal }),
          });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { call, result };
    }),
  );
}

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
        tools,
        ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.signal && { signal: opts.signal }),
      });
    } catch (_err) {
      return done("error");
    }

    if (opts.signal?.aborted) return done("aborted");

    conversation = [...conversation, reply.message];

    const callsRequested =
      reply.message.role === "assistant" ? reply.message.toolCalls ?? [] : [];

    if (callsRequested.length === 0) {
      return done("end_turn");
    }

    // Execute all tool calls in parallel, with hooks.
    const hookedTools = tools;
    for (const c of callsRequested) opts.onToolCall?.(c);
    const results = await executeToolCalls(callsRequested, hookedTools, opts.signal);
    for (const { call, result } of results) opts.onToolResult?.(call, result);

    conversation = [
      ...conversation,
      ...results.map(({ call, result }): Message => ({
        role: "tool",
        callId: call.id,
        result,
      })),
    ];
  }

  function done(reason: AgentFinishReason): AgentResult {
    opts.onFinish?.(reason);
    return { conversation, reason, iterations };
  }
}
