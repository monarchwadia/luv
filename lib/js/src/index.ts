// Public surface of luv-js. Internals (wasm loader, codec, bridge) are
// intentionally kept out of consumers' reach — the wasm is inlined and loaded
// transparently on first call.

export type {
  Conversation,
  Event,
  LuvStream,
  Message,
  Reply,
  Role,
  SendOptions,
  SendStreamOptions,
  StopReason,
} from "./types.ts";

export { send } from "./send.ts";
export {
  HttpError,
  AuthError,
  RateLimitError,
  ContextWindowExceededError,
  ContentFilterError,
  ServiceUnavailableError,
  classifyError,
} from "./errors.ts";
export { sendStream } from "./send_stream.ts";
export {
  runAgent,
  agentStep,
  type AgentStepOptions,
  type AgentStepReason,
  type AgentStepResult,
} from "./agent.ts";
export { openaiProvider, type OpenAIProviderConfig } from "./provider_openai.ts";
export { tool, type ToolDef, type InferSchema } from "./tool.ts";
export {
  createClient,
  type LuvClient,
  type ClientSendOptions,
  type ClientSendStreamOptions,
  type ClientAgentOptions,
} from "./client.ts";
