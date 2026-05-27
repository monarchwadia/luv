export type Role = "system" | "user" | "assistant";

export type ErrorCategory =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "content_filter"
  | "server_error"
  | "network"
  | "tool_execution"
  | "local_validation"
  | "unknown";

export const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  "auth",
  "rate_limit",
  "bad_request",
  "content_filter",
  "server_error",
  "network",
  "tool_execution",
  "local_validation",
  "unknown",
];

export type Block =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: string }
  | { kind: "tool_result"; call_id: string; text: string }
  | {
      kind: "error";
      category: ErrorCategory;
      message: string;
      details: string;
    };

export interface Message {
  role: Role;
  content: Block[];
}

export interface Node {
  id: string;
  parent_id: string | null;
  message: Message;
}

export interface Conversation {
  spec_version: string;
  nodes: Node[];
}

export const LUV_SPEC_VERSION = "1.0";

export type FinishReason =
  | "end_turn"
  | "max_tokens"
  | "content_filter"
  | "error";

/**
 * Single throwable class paired with the canonical error Block shape.
 * Switching from "throw" to "as_block" is conversion between this
 * exception form and a Block with kind: "error".
 */
export class LuvError extends Error {
  readonly data: {
    category: ErrorCategory;
    message: string;
    details: string;
  };

  constructor(data: { category: ErrorCategory; message: string; details: string }) {
    super(data.message);
    this.name = "LuvError";
    this.data = data;
  }
}

export interface Reply {
  message: Message;
  finish_reason: FinishReason;
}

export type StreamEventReply =
  | { kind: "message_start" }
  | { kind: "block_start"; block: Block }
  | { kind: "text_delta"; text: string }
  | { kind: "args_delta"; args: string }
  | { kind: "block_end" }
  | { kind: "message_end"; finish_reason: FinishReason };

export type StreamReply = StreamEventReply[];

export interface ValidationError {
  path: string;
  rule: string;
  message: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };
