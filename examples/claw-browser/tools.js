// File-system tools the agent can call. All paths are relative to
// the workspace root directory (a FileSystemDirectoryHandle).

export const TOOL_DEFS = [
  {
    name: "list_files",
    description:
      "List the entries (files and directories) at a path relative to the workspace root.",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path (use '.' or empty for root)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file at a path relative to the workspace root.",
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write or overwrite a UTF-8 text file at a path relative to the workspace root.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["path", "contents"],
    },
  },
];

// Superadmin-only tools for managing the other agents in this workspace.
// These are pure schemas; their handlers live in app.js (they mutate the
// live workspace state and drive agent lifecycle).
export const ADMIN_TOOL_DEFS = [
  {
    name: "list_agents",
    description:
      "List every agent in the workspace with its id, name, role, mode, status, provider, model, running state, and message count.",
    schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_agent",
    description:
      "Create a new member agent in the workspace. It starts idle; use start_claw to run it autonomously, or message_agent to talk to it.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        provider: { type: "string", enum: ["openai", "anthropic"] },
        model: { type: "string", description: "Optional; defaults to the provider's small model." },
        mode: { type: "string", enum: ["auto", "claw"], description: "Optional; defaults to auto." },
      },
      required: ["name", "provider"],
    },
  },
  {
    name: "configure_agent",
    description:
      "Update an existing agent's settings. Any field may be omitted to leave it unchanged. claw_config sets wake triggers; its shape is " +
      '{ "triggers": { "user_message": bool, "timer": bool, "file_change": bool }, "poll_interval_sec": number, "max_work_turns": number }. ' +
      "Cannot change an agent's role.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        name: { type: "string" },
        provider: { type: "string", enum: ["openai", "anthropic"] },
        model: { type: "string" },
        mode: { type: "string", enum: ["auto", "claw"] },
        claw_config: { type: "object" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "deprecate_agent",
    description: "Deprecate (disable) an agent. It stops if running and can no longer send messages until reactivated. Cannot deprecate yourself.",
    schema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
    },
  },
  {
    name: "reactivate_agent",
    description: "Reactivate a previously deprecated agent.",
    schema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
    },
  },
  {
    name: "start_claw",
    description: "Start an agent as an autonomous claw with a goal. It runs in the background until it parks, then wakes on its configured triggers.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        goal: { type: "string" },
      },
      required: ["agent_id", "goal"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop a running agent or claw. Cannot stop yourself.",
    schema: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
    },
  },
  {
    name: "message_agent",
    description:
      "Send a message to another agent and get its reply. If the target is idle it runs and the reply text is returned. If it is already running (e.g. a live claw) the message is delivered and it replies in its own conversation. Cannot message yourself.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["agent_id", "message"],
    },
  },
  {
    name: "read_agent_conversation",
    description: "Read the most recent messages from another agent's conversation.",
    schema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        last_n: { type: "number", description: "How many recent messages to return (default 20)." },
      },
      required: ["agent_id"],
    },
  },
];

async function resolvePath(rootDir, rel, { createDirs = false } = {}) {
  if (!rootDir) throw new Error("No workspace open.");
  const segments = (rel ?? "")
    .replace(/^\.\/?/, "")
    .split("/")
    .filter((s) => s && s !== ".");
  if (segments.length === 0) {
    throw new Error("Empty path. Use a filename.");
  }
  let dir = rootDir;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: createDirs });
  }
  return { dir, name: segments[segments.length - 1] };
}

export function makeHandlers(rootDir) {
  return {
    async list_files(args) {
      const path = (args.path ?? "").replace(/^\.\/?/, "");
      let dir = rootDir;
      if (path) {
        for (const p of path.split("/").filter(Boolean)) {
          dir = await dir.getDirectoryHandle(p);
        }
      }
      const entries = [];
      for await (const [name, h] of dir.entries()) {
        entries.push(`${h.kind === "directory" ? "d" : "-"} ${name}`);
      }
      entries.sort();
      return entries.join("\n") || "(empty)";
    },

    async read_file(args) {
      const { dir, name } = await resolvePath(rootDir, args.path);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return await file.text();
    },

    async write_file(args) {
      const { dir, name } = await resolvePath(rootDir, args.path, {
        createDirs: true,
      });
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(args.contents ?? "");
      await w.close();
      return `wrote ${args.path} (${(args.contents ?? "").length} bytes)`;
    },
  };
}

// Format an array of tool defs into the provider's wire shape.
export function formatTools(defs, providerName) {
  if (providerName === "openai") {
    return defs.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
}

export function providerTools(providerName) {
  return formatTools(TOOL_DEFS, providerName);
}
