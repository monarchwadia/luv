// luv claw — browser
// Single-page agent that uses File System Access API + luv's
// canonical conversation type + provider-agnostic transports.
//
// Tools exposed to the model:
//   list_files(path)              — list directory contents
//   read_file(path)               — get a file's contents as text
//   write_file(path, contents)    — write/overwrite a file (asks user approval)
//
// All paths are relative to the folder the user opened.

import {
  openaiClient,
  anthropicClient,
  LuvError,
} from "./luv.js";

// ---------- App state ----------

const state = {
  /** @type {FileSystemDirectoryHandle | null} */
  rootDir: null,
  /** luv canonical Conversation */
  conv: { spec_version: "1.0", nodes: [] },
  /** @type {string | null} current head node id */
  head: null,
  /** whether an agent loop is running */
  busy: false,
};

// ---------- Tools (closures over rootDir) ----------

const TOOL_DEFS = [
  {
    name: "list_files",
    description:
      "List the entries (files and directories) at a path relative to the project root.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path (use '.' or empty for root)" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file at a path relative to the project root.",
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write (or overwrite) a UTF-8 text file at a path relative to the project root. " +
      "Requires explicit user approval before each call.",
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

async function resolvePath(rel, { createDirs = false } = {}) {
  if (!state.rootDir) throw new Error("No folder is open. Click 'open folder' first.");
  const segments = rel
    .replace(/^\.\/?/, "")
    .split("/")
    .filter((s) => s && s !== ".");
  let dir = state.rootDir;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: createDirs });
  }
  return { dir, name: segments[segments.length - 1] };
}

async function tool_list_files(args) {
  const path = (args.path ?? "").replace(/^\.\/?/, "");
  let dir = state.rootDir;
  if (path) {
    const parts = path.split("/").filter(Boolean);
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p);
    }
  }
  const entries = [];
  for await (const [name, h] of dir.entries()) {
    entries.push(`${h.kind === "directory" ? "d" : "-"} ${name}`);
  }
  entries.sort();
  return entries.join("\n") || "(empty)";
}

async function tool_read_file(args) {
  const { dir, name } = await resolvePath(args.path);
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return await file.text();
}

async function tool_write_file(args) {
  const { dir, name } = await resolvePath(args.path, { createDirs: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(args.contents ?? "");
  await w.close();
  return `wrote ${args.path} (${(args.contents ?? "").length} bytes)`;
}

/** @type {Record<string, (args: any) => Promise<string>>} */
const TOOL_HANDLERS = {
  list_files: tool_list_files,
  read_file: tool_read_file,
  write_file: tool_write_file,
};

// Tools that require user approval before executing.
const NEEDS_APPROVAL = new Set(["write_file"]);

// ---------- Provider-agnostic client ----------

function makeClient() {
  const provider = $provider.value;
  const apiKey = $apiKey.value.trim();
  if (!apiKey) throw new Error("API key is required");
  if (provider === "openai") return openaiClient({ api_key: apiKey });
  return anthropicClient({ api_key: apiKey });
}

function makeSendOpts() {
  const provider = $provider.value;
  const model = $model.value.trim();
  if (provider === "openai") return { model };
  return { model, max_tokens: 4096 };
}

function providerTools() {
  // Each provider has slightly different tool definition shape.
  const provider = $provider.value;
  if (provider === "openai") {
    return TOOL_DEFS.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }
  // anthropic
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
}

// ---------- DOM helpers ----------

const $ = (id) => document.getElementById(id);
const $conv = $("conversation");
const $input = $("input");
const $send = $("send");
const $apiKey = $("api-key");
const $provider = $("provider");
const $model = $("model");
const $folderInfo = $("folder-info");
const $openFolder = $("open-folder");
const $status = $("status");
const $approval = $("approval");
const $approvalTool = $("approval-tool");
const $approvalArgs = $("approval-args");
const $approvalApprove = $("approval-approve");
const $approvalReject = $("approval-reject");

function setStatus(s) { $status.textContent = s; }
function setBusy(b) {
  state.busy = b;
  $send.disabled = b;
  $input.disabled = b;
}

// Track DOM elements per node so streaming can update in place.
const nodeEls = new Map();

function ensureNodeEl(node) {
  let el = nodeEls.get(node.id);
  if (el) return el;
  el = document.createElement("div");
  el.className = `turn role-${node.message.role}`;
  el.innerHTML = `<div class="role-label">${node.message.role}</div>`;
  $conv.appendChild(el);
  nodeEls.set(node.id, el);
  return el;
}

function renderNode(node) {
  const el = ensureNodeEl(node);
  // Clear all but the role label
  while (el.children.length > 1) el.removeChild(el.lastChild);
  for (const block of node.message.content) {
    el.appendChild(renderBlock(block));
  }
  el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function renderBlock(block) {
  const div = document.createElement("div");
  div.classList.add("block");
  if (block.kind === "text") {
    div.classList.add("text");
    div.textContent = block.text;
  } else if (block.kind === "tool_call") {
    div.classList.add("tool-call");
    div.innerHTML = `<span class="name">${escapeHtml(block.name)}</span>(${escapeHtml(block.args)})`;
  } else if (block.kind === "tool_result") {
    div.classList.add("tool-result");
    div.textContent = block.text;
  } else if (block.kind === "error") {
    div.classList.add("error");
    div.textContent = `[${block.category}] ${block.message}`;
  }
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

// ---------- Approval modal ----------

function askApproval(toolName, args) {
  return new Promise((resolve) => {
    $approvalTool.textContent = `Tool: ${toolName}`;
    $approvalArgs.textContent = JSON.stringify(args, null, 2);
    $approval.showModal();
    const cleanup = () => {
      $approvalApprove.removeEventListener("click", onApprove);
      $approvalReject.removeEventListener("click", onReject);
      $approval.close();
    };
    const onApprove = () => { cleanup(); resolve(true); };
    const onReject = () => { cleanup(); resolve(false); };
    $approvalApprove.addEventListener("click", onApprove);
    $approvalReject.addEventListener("click", onReject);
  });
}

// ---------- Conversation operations ----------

function newId() {
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

function appendNode(role, content) {
  const node = {
    id: newId(),
    parent_id: state.head,
    message: { role, content },
  };
  state.conv.nodes.push(node);
  state.head = node.id;
  renderNode(node);
  return node;
}

function updateNode(node, content) {
  node.message.content = content;
  renderNode(node);
}

// ---------- Agent loop ----------

async function runTurn(userText) {
  appendNode("user", [{ kind: "text", text: userText }]);

  const client = makeClient();
  const opts = { ...makeSendOpts(), tools: providerTools() };

  for (let turn = 0; turn < 20; turn++) {
    setStatus(`turn ${turn + 1} — sending to ${$provider.value}...`);

    // Build a placeholder assistant node so streaming has a target.
    const assistantNode = appendNode("assistant", []);
    const blocks = [];
    let currentBlock = null;

    try {
      for await (const event of client.stream(state.conv, opts)) {
        if (event.kind === "block_start") {
          currentBlock = JSON.parse(JSON.stringify(event.block));
          blocks.push(currentBlock);
          updateNode(assistantNode, blocks);
        } else if (event.kind === "text_delta" && currentBlock?.kind === "text") {
          currentBlock.text += event.text;
          updateNode(assistantNode, blocks);
        } else if (event.kind === "args_delta" && currentBlock?.kind === "tool_call") {
          currentBlock.args += event.args;
          updateNode(assistantNode, blocks);
        } else if (event.kind === "block_end") {
          currentBlock = null;
        }
        // message_start / message_end ignored
      }
    } catch (e) {
      let category = "unknown";
      let msg;
      let details = "{}";
      if (e instanceof LuvError) {
        category = e.data.category;
        msg = e.data.message;
        details = e.data.details;
      } else {
        msg = String(e);
      }
      blocks.push({ kind: "error", category, message: msg, details });
      updateNode(assistantNode, blocks);
      setStatus(`failed: [${category}] ${msg}`);
      return;
    }

    const toolCalls = blocks.filter((b) => b.kind === "tool_call");
    if (toolCalls.length === 0) {
      setStatus("done.");
      return;
    }

    setStatus(`turn ${turn + 1} — running ${toolCalls.length} tool call(s)...`);
    const resultBlocks = [];
    for (const tc of toolCalls) {
      let result;
      try {
        const args = JSON.parse(tc.args);
        if (NEEDS_APPROVAL.has(tc.name)) {
          const ok = await askApproval(tc.name, args);
          if (!ok) {
            result = `user rejected the call to ${tc.name}`;
          } else {
            result = await TOOL_HANDLERS[tc.name](args);
          }
        } else {
          result = await TOOL_HANDLERS[tc.name](args);
        }
      } catch (e) {
        result = `error: ${e?.message ?? String(e)}`;
      }
      resultBlocks.push({ kind: "tool_result", call_id: tc.id, text: result });
    }
    appendNode("user", resultBlocks);
  }

  setStatus("hit max turns; stopping.");
}

// ---------- Event wiring ----------

$openFolder.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    state.rootDir = handle;
    $folderInfo.textContent = handle.name + "/";
    updateSendButton();
  } catch (e) {
    setStatus(`folder open canceled: ${e.message}`);
  }
});

$apiKey.addEventListener("input", updateSendButton);
$provider.addEventListener("change", () => {
  $model.value = $provider.value === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5";
  updateSendButton();
});

$send.addEventListener("click", () => onSend());
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !state.busy) {
    e.preventDefault();
    onSend();
  }
});

async function onSend() {
  const text = $input.value.trim();
  if (!text || state.busy) return;
  $input.value = "";
  setBusy(true);
  try {
    await runTurn(text);
  } finally {
    setBusy(false);
  }
}

function updateSendButton() {
  $send.disabled = !($apiKey.value.trim() && state.rootDir && !state.busy);
}

// ---------- Boot ----------

if (!window.showDirectoryPicker) {
  setStatus(
    "File System Access API not available. Use Chrome, Edge, or another Chromium-based browser.",
  );
  $openFolder.disabled = true;
} else {
  setStatus("paste an API key and open a folder to start.");
}
