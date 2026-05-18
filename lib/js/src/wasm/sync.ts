// Loader seam (stable import path). The mechanical wasm marshalling —
// instance bootstrap, `callWasm`, and the decoder/agent handle helpers — is
// GENERATED from the declarative descriptor core/src/wasm_abi/abi.zig
// (loader.generated.ts). This file re-exports it unchanged.
//
// Only the two codec-coupled openai-brick wrappers below stay hand-written:
// they carry that brick's wire codec (encodeSendRequest/decodeReply). They
// move to generated output with the declarative wire schema
// (plans/generate-sdks.md, P3) — declared remnant, not invented glue.

export {
  callWasm,
  decoderNew,
  decoderFree,
  decoderFeed,
  agentStart,
  agentPoll,
  agentFeedReply,
  agentFeedTools,
  agentAbort,
  agentDestroy,
} from "./loader.generated.ts";

import { callWasm } from "./loader.generated.ts";
import {
  encodeSendRequest,
  decodeReply,
  type CodecSendRequest,
  type CodecReply,
} from "../codec.ts";

const td = new TextDecoder();
const te = new TextEncoder();

/** Synchronous: CodecSendRequest -> OpenAI wire request JSON string. */
export function buildRequest(req: CodecSendRequest): string {
  return td.decode(callWasm("luv_build_request", encodeSendRequest(req)));
}

/** Synchronous: OpenAI wire response JSON -> decoded CodecReply. */
export function parseReply(wireResponseJson: string): CodecReply {
  return decodeReply(callWasm("luv_parse_reply", te.encode(wireResponseJson)));
}
