// Canonical luv types — pure data, mirrors core/src/morphisms/luv/luv.zig.
// All public types in luv-js flow through these.

export type Role = "system" | "user" | "assistant" | "tool";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "content_filter"
  | "stop_sequence"
  | "tool_use"
  | "other";

// ---------------------------------------------------------------------------
// Tools

/** Loose JSON Schema. Provider morphisms pass it through to the wire. */
export type JSONSchema = {
  readonly type?:
    | "object"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "null";
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: boolean | JSONSchema;
};

export interface ToolContext {
  readonly signal?: AbortSignal;
}

export type ToolResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Already-parsed JSON arguments emitted by the model. */
  readonly arguments: unknown;
}

// ---------------------------------------------------------------------------
// Messages — discriminated by `role`

export type Message =
  | { readonly role: "system"; readonly text: string }
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: "tool"; readonly callId: string; readonly result: ToolResult };

export type Conversation = readonly Message[];

export interface Reply {
  readonly message: Message;
  readonly stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// Streaming events (existing — kept here for cohesion)

export type Event =
  | { readonly type: "start"; readonly role: Role }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "stop"; readonly stopReason: StopReason };

// ---------------------------------------------------------------------------
// Send options (kept compatible with existing send/sendStream)

export interface SendOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly conversation: Conversation;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly tools?: readonly Tool[];
  readonly signal?: AbortSignal;
}

export interface LuvStream extends AsyncIterable<Event> {
  cancel(): void;
  readonly aborted: boolean;
  readonly done: Promise<Reply>;
}

export interface SendStreamOptions extends SendOptions {
  readonly onStart?: (role: Role) => void;
  readonly onDelta?: (delta: string) => void;
  readonly onStop?: (stopReason: StopReason) => void;
  readonly onError?: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Provider abstraction — what the agent loop talks to

/** Per-call options the agent layer hands a Provider. Excludes auth, since
 *  Provider instances are pre-bound to credentials at construction time. */
export interface ProviderSendOptions {
  readonly model: string;
  readonly conversation: Conversation;
  readonly tools?: readonly Tool[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ProviderStreamOptions extends ProviderSendOptions {
  readonly onStart?: (role: Role) => void;
  readonly onDelta?: (delta: string) => void;
  readonly onStop?: (stopReason: StopReason) => void;
  readonly onError?: (err: Error) => void;
}

export interface Provider {
  send(opts: ProviderSendOptions): Promise<Reply>;
  sendStream(opts: ProviderStreamOptions): LuvStream;
}

// ---------------------------------------------------------------------------
// Agent layer

export type AgentFinishReason =
  | "end_turn"
  | "max_iterations"
  | "aborted"
  | "error";

export interface AgentOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly conversation: Conversation;
  readonly tools?: readonly Tool[];
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  // Lifecycle hooks — fire as the loop progresses.
  readonly onTurnStart?: (iteration: number) => void;
  readonly onToolCall?: (call: ToolCall) => void;
  readonly onToolResult?: (call: ToolCall, result: ToolResult) => void;
  readonly onFinish?: (reason: AgentFinishReason) => void;
}

export interface AgentResult {
  readonly conversation: readonly Message[];
  readonly reason: AgentFinishReason;
  readonly iterations: number;
}
