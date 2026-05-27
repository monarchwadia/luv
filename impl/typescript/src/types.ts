export type Role = "system" | "user" | "assistant";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: string }
  | { kind: "tool_result"; call_id: string; text: string };

export interface Message {
  role: Role;
  content: Block[];
}

export interface Node {
  id: string;
  parent_id: string | null;
  message: Message;
}

export type Conversation = Node[];

export type FinishReason = "end_turn" | "max_tokens" | "content_filter";

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
