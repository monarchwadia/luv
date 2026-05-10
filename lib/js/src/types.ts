// Canonical luv types — pure data, mirrors core/src/morphisms/luv/luv.zig.
// All public types in luv-js flow through these.

export type Role = "system" | "user" | "assistant";

export interface Message {
  readonly role: Role;
  readonly text: string;
}

export type Conversation = readonly Message[];

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "content_filter"
  | "stop_sequence"
  | "tool_use"
  | "other";

export interface Reply {
  readonly message: Message;
  readonly stopReason: StopReason;
}

export type Event =
  | { readonly type: "start"; readonly role: Role }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "stop"; readonly stopReason: StopReason };

export interface SendOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly conversation: Conversation;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

/** A streaming response. Iterate, await `.done`, or rely on hooks. */
export interface LuvStream extends AsyncIterable<Event> {
  /** Aborts the underlying fetch and frees the wasm decoder. Idempotent. */
  cancel(): void;
  /** True after `cancel()` (or external `signal.abort()`) has fired. */
  readonly aborted: boolean;
  /** Resolves with the assembled final Reply when the stream completes. */
  readonly done: Promise<Reply>;
}

export interface SendStreamOptions extends SendOptions {
  readonly onStart?: (role: Role) => void;
  readonly onDelta?: (delta: string) => void;
  readonly onStop?: (stopReason: StopReason) => void;
  readonly onError?: (err: Error) => void;
}
