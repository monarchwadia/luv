export type {
  Role,
  Block,
  ErrorCategory,
  Message,
  Node,
  Conversation,
  FinishReason,
  Reply,
  StreamEventReply,
  StreamReply,
  ValidationError,
  ValidationResult,
} from "./types.js";

export { LUV_SPEC_VERSION, ERROR_CATEGORIES, LuvError } from "./types.js";

export {
  encodeBlock,
  encodeMessage,
  encodeNode,
  encodeConversation,
  encodeReply,
  encodeStreamEventReply,
  encodeStreamReply,
  encodeValidationError,
  encodeValidationResult,
  stringify,
} from "./encode.js";

export {
  consume_luv_stream_reply,
  produce_luv_stream_reply,
} from "./stream.js";

export {
  validate_luv_conversation,
  validate_luv_message,
  validate_luv_block,
  validate_luv_reply,
  validate_luv_stream_reply,
} from "./validate.js";

export {
  luv_send_to_openai_http_request,
  openai_http_response_to_luv_reply,
  openai_http_stream_to_luv_stream,
  openaiClient,
  type HTTPRequest,
  type HTTPResponse,
  type OpenAIClient,
  type OpenAIClientConfig,
  type ErrorPolicy,
  type ErrorPolicyMap,
} from "./transport/openai_chat.js";
