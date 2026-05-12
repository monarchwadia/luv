// Canonical luv types — pure data, mirrors core/src/morphisms/luv/luv.zig.
// All public types in luv-js flow through these.

export type Role = "system" | "user" | "assistant";

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

/** Per-call context passed to a `Tool.handler`.
 *
 * Currently exposes only an optional `AbortSignal` that fires when the
 * agent loop is cancelled. Long-running tool handlers should propagate
 * this signal to any downstream `fetch` / DB / file-system call so they
 * can be cancelled cleanly.
 */
export interface ToolContext {
  /** Aborts when the agent loop is cancelled (`runAgent`/`agentStep` opts.signal). */
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
  /** Pre-handler stages run in array order before `handler`. Empty by default. */
  readonly stages?: readonly Stage[];
}

/** Pre-handler decision returned by a Stage.
 *   - run:        proceed to the next stage (or, after the last stage, the handler)
 *   - deny:       short-circuit; the call resolves with `{ok:false, error}`. Handler not invoked.
 *   - edit:       proceed with new arguments. Subsequent stages and the handler see the edit.
 *   - synthesize: short-circuit; the call resolves with the given ToolResult. Handler not invoked. */
export type Decision =
  | { readonly kind: "run" }
  | { readonly kind: "deny"; readonly error: string }
  | { readonly kind: "edit"; readonly args: unknown }
  | { readonly kind: "synthesize"; readonly result: ToolResult };

export type StageFn = (
  call: ToolCall,
  ctx: ToolContext,
) => Decision | Promise<Decision>;

/** A pre-handler gate on a tool call. `kind` and `description` are sidecar
 *  metadata so the agent can advertise stage info to the LLM via the tool's
 *  wire description. */
export interface Stage {
  readonly kind: string;
  readonly description?: string;
  readonly fn: StageFn;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Already-parsed JSON arguments emitted by the model. */
  readonly arguments: unknown;
  /** Present once the call has been resolved. Undefined ⇒ pending.
   *  Colocating the result kills the need for a separate `.tool` message. */
  readonly result?: ToolResult;
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
    };

export type Conversation = readonly Message[];

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface Reply {
  readonly message: Message;
  readonly stopReason: StopReason;
  /** Token counts for the request + completion, when the provider reports them. */
  readonly usage?: Usage;
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
  /** Iterate just the text deltas (the common case). */
  text(): AsyncIterable<string>;
}

export interface SendStreamOptions extends SendOptions {
  /** Fires once when the stream's first chunk arrives, with the assistant's role. */
  readonly onStart?: (role: Role) => void;
  /** Fires once per text delta as it arrives. */
  readonly onDelta?: (delta: string) => void;
  /** Fires once when the stream terminates with a stop reason. */
  readonly onStop?: (stopReason: StopReason) => void;
  /** Fires when the stream errors (network failure, body read error, etc.). */
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
  /** Hard cap on round-trips before the loop bails. Default 10. */
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Fires at the start of each loop iteration with the 1-based iteration count. */
  readonly onTurnStart?: (iteration: number) => void;
  /** Fires once per tool call requested by the model in the just-received reply. */
  readonly onToolCall?: (call: ToolCall) => void;
  /** Fires after each tool's handler returns, with the call and its result. */
  readonly onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /** Fires once when the loop terminates (any reason). */
  readonly onFinish?: (reason: AgentFinishReason) => void;
}

export interface AgentResult {
  readonly conversation: readonly Message[];
  readonly reason: AgentFinishReason;
  readonly iterations: number;
  /** Set when the loop ended because of a thrown error (reason === "error"). */
  readonly error?: Error;
}
