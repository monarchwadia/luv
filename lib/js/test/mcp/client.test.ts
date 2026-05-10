// Item D tests: MCP client + JSON-RPC framing via a mock transport (no real subprocess).

import { test, expect } from "bun:test";
import { mcpClient, McpRequestError } from "../../src/mcp/client.ts";
import type { McpTransport } from "../../src/mcp/transport.ts";
import type { JsonRpcMessage, JsonRpcRequest } from "../../src/mcp/types.ts";

/** A scriptable mock transport that replies to known method calls. */
function mockTransport(scripts: Record<string, (params: unknown) => unknown>): {
  transport: McpTransport;
  sent: JsonRpcMessage[];
} {
  const sent: JsonRpcMessage[] = [];
  let onMsg: ((m: JsonRpcMessage) => void) | null = null;
  const transport: McpTransport = {
    async send(msg) {
      sent.push(msg);
      // If it's a request, respond on the next microtask.
      if ("method" in msg && "id" in msg) {
        const req = msg as JsonRpcRequest;
        const handler = scripts[req.method];
        if (handler) {
          queueMicrotask(() => {
            try {
              const result = handler(req.params);
              onMsg?.({ jsonrpc: "2.0", id: req.id, result });
            } catch (err) {
              onMsg?.({
                jsonrpc: "2.0",
                id: req.id,
                error: {
                  code: -32603,
                  message: err instanceof Error ? err.message : String(err),
                },
              });
            }
          });
        } else {
          queueMicrotask(() =>
            onMsg?.({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32601, message: `method not found: ${req.method}` },
            }),
          );
        }
      }
      // notifications get no response
    },
    onMessage(h) { onMsg = h; },
    onError(_h) { /* ignored in tests */ },
    async close() { /* no-op */ },
  };
  return { transport, sent };
}

test("mcpClient: handshake (initialize + initialized notification + tools/list)", async () => {
  const { transport, sent } = mockTransport({
    initialize: () => ({
      protocolVersion: "2025-03-26",
      capabilities: {},
      serverInfo: { name: "test-server", version: "0.0.1" },
    }),
    "tools/list": () => ({
      tools: [
        { name: "echo", description: "echoes a message", inputSchema: { type: "object" } },
      ],
    }),
  });

  const conn = await mcpClient(transport);
  expect(conn.tools.length).toBe(1);
  expect(conn.tools[0]?.name).toBe("echo");

  // Verify the wire sequence: initialize request, initialized notification, tools/list request.
  expect(sent.length).toBe(3);
  expect((sent[0] as JsonRpcRequest).method).toBe("initialize");
  expect((sent[1] as { method: string }).method).toBe("notifications/initialized");
  expect((sent[2] as JsonRpcRequest).method).toBe("tools/list");
});

test("mcpClient: asLuvTools produces handlers that invoke tools/call", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const { transport } = mockTransport({
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities: {} }),
    "tools/list": () => ({
      tools: [
        {
          name: "echo",
          description: "echoes",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
      ],
    }),
    "tools/call": (params) => {
      const p = params as { name: string; arguments?: { msg: string } };
      calls.push({ name: p.name, args: p.arguments });
      return { content: [{ type: "text", text: `you said: ${p.arguments?.msg}` }] };
    },
  });

  const conn = await mcpClient(transport);
  const luvTools = conn.asLuvTools();
  expect(luvTools.length).toBe(1);

  const result = await luvTools[0]!.handler({ msg: "hi" }, {});
  if (!result.ok) throw new Error("expected ok");
  expect(result.content).toBe("you said: hi");
  expect(calls).toEqual([{ name: "echo", args: { msg: "hi" } }]);
});

test("mcpClient: callTool surfaces server errors as ok=false ToolResult", async () => {
  const { transport } = mockTransport({
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities: {} }),
    "tools/list": () => ({ tools: [] }),
    "tools/call": () => {
      throw new Error("tool execution failed");
    },
  });
  const conn = await mcpClient(transport);
  const result = await conn.callTool("anything", {});
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("tool execution failed");
});

test("mcpClient: callTool with isError=true marks the result as ok=false", async () => {
  const { transport } = mockTransport({
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities: {} }),
    "tools/list": () => ({ tools: [] }),
    "tools/call": () => ({
      content: [{ type: "text", text: "city not found" }],
      isError: true,
    }),
  });
  const conn = await mcpClient(transport);
  const result = await conn.callTool("lookup", { city: "Atlantis" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("city not found");
});

test("mcpClient: McpRequestError propagates code + message from JSON-RPC error", async () => {
  const { transport } = mockTransport({
    initialize: () => {
      throw new Error("server boom");
    },
  });
  await expect(mcpClient(transport)).rejects.toBeInstanceOf(McpRequestError);
});

test("mcpClient: refreshTools re-fetches the tool list", async () => {
  let toolsetVersion = 0;
  const { transport } = mockTransport({
    initialize: () => ({ protocolVersion: "2025-03-26", capabilities: {} }),
    "tools/list": () => {
      toolsetVersion++;
      return {
        tools: Array.from({ length: toolsetVersion }, (_, i) => ({
          name: `tool_${i}`,
          inputSchema: { type: "object" },
        })),
      };
    },
  });
  const conn = await mcpClient(transport);
  expect(conn.tools.length).toBe(1);
  const refreshed = await conn.refreshTools();
  expect(refreshed.length).toBe(2);
  expect(conn.tools.length).toBe(2);
});
