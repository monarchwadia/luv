// JSON-RPC 2.0 client + MCP-specific helpers.
//
// Manages id correlation between requests and responses, surfaces tools/list
// and tools/call as Promises, and exposes an `asLuvTools()` projection so an
// MCP server's tools can be passed straight into runAgent.

import type { Tool, ToolResult } from "../types.ts";
import { stdioTransport, type McpTransport, type StdioTransportOptions } from "./transport.ts";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResponseError,
  McpInitializeParams,
  McpInitializeResult,
  McpToolDef,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListResult,
} from "./types.ts";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "luv-js", version: "0.1.0" };

export class McpRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, error: JsonRpcResponseError["error"]) {
    super(`luv-js mcp: ${method} failed: [${error.code}] ${error.message}`);
    this.code = error.code;
    this.data = error.data;
    this.name = "McpRequestError";
  }
}

/** A live connection to an MCP server. Use `connectMcp` to obtain one. */
export interface McpConnection {
  /** Server-reported tools, fetched once at connect time. */
  readonly tools: readonly McpToolDef[];
  /** Re-fetch the tool list. Use after a server-side change. */
  refreshTools(): Promise<readonly McpToolDef[]>;
  /** Project the MCP tools as luv Tool[] ready for `runAgent({ tools })`. */
  asLuvTools(): Tool[];
  /** Invoke a single tool by name. Lower-level than asLuvTools(). */
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Tear down the underlying transport. Idempotent. */
  close(): Promise<void>;
}

/** Spawn an MCP server over stdio and return a connected client. */
export async function connectMcp(opts: StdioTransportOptions): Promise<McpConnection> {
  const transport = await stdioTransport(opts);
  return mcpClient(transport);
}

/** Build an MCP client over an arbitrary transport (for testing). */
export async function mcpClient(transport: McpTransport): Promise<McpConnection> {
  let nextId = 1;
  const pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();

  transport.onError((err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  transport.onMessage((msg) => {
    if (!isResponse(msg)) return; // we don't handle server-initiated requests / notifications yet
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if ("error" in msg) {
      slot.reject(new McpRequestError(slot.method, msg.error));
    } else {
      slot.resolve(msg.result);
    }
  });

  async function request<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) };
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
    await transport.send(req);
    return promise as Promise<T>;
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined && { params }) };
    await transport.send(note);
  }

  // Handshake.
  const initParams: McpInitializeParams = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  };
  await request<McpInitializeResult>("initialize", initParams);
  await notify("notifications/initialized");

  let tools: McpToolDef[] = [];
  async function refresh(): Promise<readonly McpToolDef[]> {
    const result = await request<McpToolsListResult>("tools/list");
    tools = result.tools;
    return tools;
  }
  await refresh();

  return {
    get tools() {
      return tools;
    },
    refreshTools: refresh,
    asLuvTools(): Tool[] {
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Tool["inputSchema"],
        handler: async (args) => callToolImpl(t.name, args as Record<string, unknown>),
      }));
    },
    callTool(name, args) {
      return callToolImpl(name, args);
    },
    async close() {
      await transport.close();
    },
  };

  async function callToolImpl(name: string, args?: Record<string, unknown>): Promise<ToolResult> {
    const params: McpToolsCallParams = { name, ...(args !== undefined && { arguments: args }) };
    let result: McpToolsCallResult;
    try {
      result = await request<McpToolsCallResult>("tools/call", params);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Fold the content blocks into a single string for luv's text-only ToolResult.
    const text = (result.content ?? [])
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "resource") return b.resource.text ?? `[resource ${b.resource.uri}]`;
        if (b.type === "image") return `[image ${b.mimeType}]`;
        return "";
      })
      .join("\n");
    if (result.isError) return { ok: false, error: text };
    return { ok: true, content: text };
  }
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}
