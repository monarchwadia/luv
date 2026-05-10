// runAgent: the default agent loop. Pure function on the conversation array
// — never owns state, never returns anything other than a luv-shaped result.

import type {
  AgentFinishReason,
  AgentOptions,
  AgentResult,
  Message,
  ToolCall,
  ToolResult,
} from "./types.ts";

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

    // Execute all tool calls in parallel.
    const results = await Promise.all(
      callsRequested.map(async (call): Promise<{ call: ToolCall; result: ToolResult }> => {
        opts.onToolCall?.(call);
        const tool = tools.find((t) => t.name === call.name);
        let result: ToolResult;
        if (!tool) {
          result = { ok: false, error: `unknown tool: ${call.name}` };
        } else {
          try {
            result = await tool.handler(call.arguments, {
              ...(opts.signal && { signal: opts.signal }),
            });
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        opts.onToolResult?.(call, result);
        return { call, result };
      }),
    );

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
