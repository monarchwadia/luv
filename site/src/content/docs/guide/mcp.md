---
title: MCP client
description: Use Model Context Protocol servers as luv tools.
---

[Model Context Protocol](https://modelcontextprotocol.io) is a standard for
exposing tools to LLM agents. luv-js ships a client that connects to an MCP
server (over stdio) and exposes its tools as luv `Tool[]` ready for
`runAgent`.

```ts
import { connectMcp } from "luv-js/mcp";
import { runAgent } from "luv-js";

const conn = await connectMcp({
  command: "uvx",
  args: ["my-mcp-server"],
});

const tools = conn.asLuvTools();  // luv Tool[]

await runAgent({
  provider,
  model: "gpt-4o-mini",
  conversation,
  tools,            // pass MCP tools straight in
});

await conn.close();
```

The connection handshake (`initialize` + `notifications/initialized`) and
the initial `tools/list` happen as part of `connectMcp`. The returned
`McpConnection` exposes:

- `conn.tools` — server-reported tool definitions
- `conn.refreshTools()` — re-fetch (for servers that update their toolset)
- `conn.asLuvTools()` — project as luv `Tool[]`
- `conn.callTool(name, args)` — invoke a single tool directly
- `conn.close()` — kill the subprocess

## Mixing MCP tools with local tools

`runAgent({ tools })` doesn't care where a Tool came from. Local + MCP
tools coexist:

```ts
const conn = await connectMcp({...});
const local = tool({...});

await runAgent({
  ...,
  tools: [local, ...conn.asLuvTools()],
});
```

## Bundle impact

The MCP module ships separately at `luv-js/mcp` so apps that don't use it
don't pay for it. Bundled size: ~7 KB on top of luv-js core. Subprocess
spawning uses Bun's native `Bun.spawn` or Node's `node:child_process` —
the module is server-only (browsers can't spawn subprocesses).

## What's not yet supported

- Resources (`resources/list`, `resources/read`)
- Prompts (`prompts/list`, `prompts/get`)
- Sampling
- WebSocket / HTTP transports (only stdio for now)
- Server capability negotiation

These are planned; for now luv-js's MCP client covers the most common case
(tool discovery + invocation) needed for agent workflows.
