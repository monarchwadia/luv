---
title: MCP
description: MCP client API — connectMcp, McpConnection.
---

Import from `luv-js/mcp`. See [MCP client guide](/guide/mcp/) for patterns.

## `connectMcp(opts)`

Spawn an MCP server as a subprocess (over stdio) and return a connected
client. Handshake (initialize + tools/list) happens during this call.

```ts
import { connectMcp } from "luv-js/mcp";

const conn = await connectMcp({
  command: "uvx",
  args?: ["my-mcp-server"],
  env?: Record<string, string>,
  cwd?: string,
});
```

Returns `Promise<McpConnection>`.

## `McpConnection`

```ts
interface McpConnection {
  readonly tools: readonly McpToolDef[];     // server-reported tools
  refreshTools(): Promise<readonly McpToolDef[]>;
  asLuvTools(): Tool[];                       // ready for runAgent({ tools })
  callTool(name: string, args?: object): Promise<ToolResult>;
  close(): Promise<void>;
}
```

## `mcpClient(transport)`

Lower-level: build an MCP client over an arbitrary `McpTransport`.
Use this for custom transports (WebSocket, in-memory testing, etc.).

```ts
import { mcpClient } from "luv-js/mcp";
const conn = await mcpClient(myTransport);
```

## `McpRequestError`

Thrown when an MCP method returns a JSON-RPC error response. Carries
`.code` (JSON-RPC error code), `.message`, and `.data`.

## `stdioTransport(opts)`

The stdio transport used by `connectMcp` under the hood. Exposed for
custom client setups.

```ts
import { stdioTransport } from "luv-js/mcp";

const transport = await stdioTransport({
  command: "uvx",
  args: ["my-mcp-server"],
});
```

Implements `McpTransport`:

```ts
interface McpTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  onError(handler: (err: Error) => void): void;
  close(): Promise<void>;
}
```
