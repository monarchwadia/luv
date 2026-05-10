// Pure-TS SSE decoder for OpenAI Chat Completions streaming.
// Mirrors core/src/morphisms/openai/openai_stream.zig.
//
// Loss table (openai stream → luv stream):
//   - id, object, created, model, system_fingerprint, service_tier — dropped per chunk.
//   - obfuscation — dropped (OpenAI anti-extraction noise).
//   - choice.index, choice.logprobs — dropped.
//   - delta.refusal — currently coerced to text (lossy: not tagged).
//   - data: [DONE] terminator — consumed without emitting an event.

import type { Event, Role, StopReason } from "./types.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

interface StreamingDelta {
  role?: string;
  content?: string;
  refusal?: string | null;
}

interface StreamingChunk {
  choices?: ReadonlyArray<{
    delta?: StreamingDelta;
    finish_reason?: string | null;
  }>;
}

export class SseDecoder {
  private pending = "";
  private sawStart = false;
  private done = false;

  /** Feed raw response-body bytes. Returns 0+ events emitted by this chunk. */
  feed(bytes: Uint8Array): Event[] {
    if (this.done) return [];

    // Streaming-decode: bytes may straddle UTF-8 codepoints, so use { stream: true }.
    this.pending += utf8Decoder.decode(bytes, { stream: true });

    const events: Event[] = [];
    while (true) {
      const sep = this.findFrameEnd(this.pending);
      if (sep === -1) break;
      const frame = this.pending.slice(0, sep.start);
      this.pending = this.pending.slice(sep.end);
      this.handleFrame(frame, events);
      if (this.done) break;
    }
    return events;
  }

  /** Locate the end of the next complete SSE frame (terminated by \n\n or \r\n\r\n). */
  private findFrameEnd(s: string): { start: number; end: number } | -1 {
    const a = s.indexOf("\n\n");
    const b = s.indexOf("\r\n\r\n");
    if (a === -1 && b === -1) return -1;
    if (a !== -1 && (b === -1 || a < b)) return { start: a, end: a + 2 };
    return { start: b, end: b + 4 };
  }

  private handleFrame(frame: string, events: Event[]): void {
    // SSE: each frame can have multiple lines; we only want `data:` lines.
    let payload: string | undefined;
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) continue;
      if (line.startsWith(":")) continue; // SSE comment
      if (line.startsWith("data:")) {
        payload = line.slice(5).replace(/^\s+/, "");
        break; // OpenAI never splits a JSON payload across multiple data: lines
      }
    }
    if (payload === undefined) return;

    if (payload === "[DONE]") {
      this.done = true;
      return;
    }

    let chunk: StreamingChunk;
    try {
      chunk = JSON.parse(payload) as StreamingChunk;
    } catch {
      throw new Error(`SseDecoder: malformed JSON in data line: ${payload.slice(0, 100)}`);
    }

    if (!chunk.choices || chunk.choices.length === 0) return;
    const choice = chunk.choices[0]!;

    const delta = choice.delta;
    if (delta) {
      if (!this.sawStart && delta.role === "assistant") {
        events.push({ type: "start", role: "assistant" as Role });
        this.sawStart = true;
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        events.push({ type: "text", delta: delta.content });
      }
    }

    if (typeof choice.finish_reason === "string") {
      events.push({ type: "stop", stopReason: stopReasonOf(choice.finish_reason) });
    }
  }
}

function stopReasonOf(s: string): StopReason {
  switch (s) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}
