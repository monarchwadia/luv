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
      "Write or overwrite a UTF-8 text file at a path relative to the workspace root. " +
      "May require explicit user approval.",
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

export const NEEDS_APPROVAL = new Set(["write_file"]);

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

export function providerTools(providerName) {
  if (providerName === "openai") {
    return TOOL_DEFS.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
}
