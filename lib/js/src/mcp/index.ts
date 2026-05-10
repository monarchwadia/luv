// luv-js/mcp — Model Context Protocol client.
//
// Spawns an MCP server as a subprocess, fetches its tool list, and exposes
// the tools as a `luv.Tool[]` ready for `runAgent({ tools })`. Each tool's
// handler dispatches back through the MCP connection.

export {
  connectMcp,
  mcpClient,
  McpRequestError,
  type McpConnection,
} from "./client.ts";
export {
  stdioTransport,
  type McpTransport,
  type StdioTransportOptions,
} from "./transport.ts";
export type {
  McpInitializeParams,
  McpInitializeResult,
  McpToolDef,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListResult,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcId,
} from "./types.ts";
