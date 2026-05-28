// luv workspace — main app.

import {
  STATE_VERSION,
  emptyWorkspaceState,
  newAgent,
  loadFromIndexedDB,
  loadFromFolder,
  createSyncOrchestrator,
  getAgent,
  activeAgents,
  deprecatedAgents,
  clawConfig,
  nowIso,
  newId,
} from "./state.js";

import { agentStep, runClaw, createClawController } from "./agent.js";

// ---------- Global state ----------

let state = emptyWorkspaceState();
let rootDir = null;
let apiKeys = { openai: "", anthropic: "" };

// Active task tracking: per-agent AbortController for cancellation.
const runningAgents = new Map(); // agentId -> AbortController

// API keys live in localStorage + memory only — never written to the
// workspace state object, so they never reach the on-disk file.

const sync = createSyncOrchestrator({
  getState: () => state,
  getRootDir: () => rootDir,
  onError: (e) => setStatus(`sync error: ${e.message ?? e}`),
});

function touch() {
  state.updated_at = nowIso();
  updateSaveInfo();
  sync.touch();
}

// ---------- DOM helpers ----------

const $ = (id) => document.getElementById(id);
const $sidebar = $("sidebar");
const $agentHeader = $("agent-header");
const $conversation = $("conversation");
const $inputRow = $("input-row");
const $status = $("status");
const $folderInfo = $("folder-info");
const $saveInfo = $("save-info");
const $openFolder = $("open-folder");
const $openaiKey = $("openai-key");
const $anthropicKey = $("anthropic-key");

const $newDlg = $("new-agent-dialog");
const $newName = $("new-agent-name");
const $newProvider = $("new-agent-provider");
const $newModel = $("new-agent-model");
const $newCancel = $("new-agent-cancel");
const $newCreate = $("new-agent-create");

const $clawDlg = $("claw-goal-dialog");
const $clawText = $("claw-goal-text");
const $clawCancel = $("claw-cancel");
const $clawStart = $("claw-start");

const $cfgDlg = $("claw-config-dialog");
const $cfgUser = $("cfg-trig-user");
const $cfgTimer = $("cfg-trig-timer");
const $cfgFile = $("cfg-trig-file");
const $cfgInterval = $("cfg-interval");
const $cfgMaxWork = $("cfg-max-work");
const $cfgCancel = $("cfg-cancel");
const $cfgSave = $("cfg-save");

function setStatus(s) { $status.textContent = s; }
function updateSaveInfo() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  $saveInfo.textContent = `· last change ${hh}:${mm}:${ss}`;
}

function defaultModelFor(provider) {
  return provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5";
}

// ---------- Rendering: sidebar ----------

function renderSidebar() {
  $sidebar.innerHTML = "";

  const newBtn = document.createElement("button");
  newBtn.className = "new-agent";
  newBtn.textContent = "+ new agent";
  newBtn.addEventListener("click", openNewAgentDialog);
  $sidebar.appendChild(newBtn);

  const active = activeAgents(state);
  const dep = deprecatedAgents(state);

  if (active.length > 0) {
    const h = document.createElement("h4");
    h.textContent = "Active";
    $sidebar.appendChild(h);
    for (const a of active) $sidebar.appendChild(renderAgentCard(a));
  }
  if (dep.length > 0) {
    const h = document.createElement("h4");
    h.textContent = "Deprecated";
    $sidebar.appendChild(h);
    for (const a of dep) $sidebar.appendChild(renderAgentCard(a));
  }
  if (active.length === 0 && dep.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "8px 16px";
    empty.textContent = "no agents yet.";
    $sidebar.appendChild(empty);
  }
}

function renderAgentCard(agent) {
  const div = document.createElement("div");
  div.className = "agent-card";
  if (agent.id === state.active_agent_id) div.classList.add("active");
  if (agent.status === "deprecated") div.classList.add("deprecated");

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = agent.name;
  div.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "meta";

  const mode = document.createElement("span");
  mode.className = `mode-badge ${agent.mode}`;
  mode.textContent = agent.mode;
  meta.appendChild(mode);

  const status = document.createElement("span");
  const running = runningAgents.has(agent.id);
  let cls;
  if (agent.status === "deprecated") cls = "deprecated";
  else if (running) cls = agent.claw_state === "parked" ? "parked" : "running";
  else cls = "idle";
  status.className = `status-badge ${cls}`;
  status.textContent = cls;
  meta.appendChild(status);

  meta.appendChild(document.createTextNode(agent.model));
  div.appendChild(meta);

  div.addEventListener("click", () => {
    state.active_agent_id = agent.id;
    touch();
    render();
  });
  return div;
}

// ---------- Rendering: active-agent header ----------

function renderAgentHeader() {
  $agentHeader.innerHTML = "";
  const a = activeAgent();
  if (!a) {
    $agentHeader.style.display = "none";
    return;
  }
  $agentHeader.style.display = "";

  const name = document.createElement("input");
  name.className = "agent-name";
  name.value = a.name;
  name.addEventListener("change", () => {
    a.name = name.value || "(unnamed)";
    a.updated_at = nowIso();
    touch();
    renderSidebar();
  });
  $agentHeader.appendChild(name);

  const sep1 = document.createElement("span");
  sep1.style.color = "var(--fg-deep-dim)";
  sep1.textContent = "·";
  $agentHeader.appendChild(sep1);

  // Mode toggle
  const modeSel = document.createElement("select");
  modeSel.innerHTML = `
    <option value="auto">auto</option>
    <option value="claw">claw</option>
  `;
  modeSel.value = a.mode;
  modeSel.addEventListener("change", () => {
    const newMode = modeSel.value;
    if (newMode === a.mode) return;
    if (newMode === "claw") {
      modeSel.value = a.mode; // revert until goal entered
      openClawDialog();
    } else {
      switchToAuto(a);
    }
  });
  $agentHeader.appendChild(makeLabel("mode"));
  $agentHeader.appendChild(modeSel);

  // Provider
  const provSel = document.createElement("select");
  provSel.innerHTML = `
    <option value="openai">openai</option>
    <option value="anthropic">anthropic</option>
  `;
  provSel.value = a.provider;
  provSel.addEventListener("change", () => {
    a.provider = provSel.value;
    a.model = defaultModelFor(a.provider);
    a.updated_at = nowIso();
    touch();
    renderAgentHeader();
    renderSidebar();
  });
  $agentHeader.appendChild(makeLabel("provider"));
  $agentHeader.appendChild(provSel);

  // Model
  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.value = a.model;
  modelInput.style.width = "180px";
  modelInput.addEventListener("change", () => {
    a.model = modelInput.value;
    a.updated_at = nowIso();
    touch();
    renderSidebar();
  });
  $agentHeader.appendChild(makeLabel("model"));
  $agentHeader.appendChild(modelInput);

  // Spacer
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  $agentHeader.appendChild(spacer);

  // Claw wake-trigger config
  const cfgBtn = document.createElement("button");
  cfgBtn.textContent = "claw config";
  cfgBtn.title = "Configure when this claw wakes from a park";
  cfgBtn.addEventListener("click", () => openClawConfigDialog(a));
  $agentHeader.appendChild(cfgBtn);

  // Deprecate / reactivate
  if (a.status === "active") {
    const dep = document.createElement("button");
    dep.className = "danger";
    dep.textContent = "deprecate";
    dep.addEventListener("click", () => deprecateAgent(a));
    $agentHeader.appendChild(dep);
  } else {
    const re = document.createElement("button");
    re.textContent = "reactivate";
    re.addEventListener("click", () => reactivateAgent(a));
    $agentHeader.appendChild(re);
  }
}

function makeLabel(text) {
  const s = document.createElement("span");
  s.style.color = "var(--fg-dim)";
  s.style.fontSize = "11px";
  s.textContent = text;
  return s;
}

// ---------- Rendering: conversation ----------

function renderConversation() {
  $conversation.innerHTML = "";
  const a = activeAgent();
  if (!a) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div>no agent selected.</div>
      <div style="margin-top: 8px; font-size: 12px;">create one in the sidebar.</div>
    `;
    $conversation.appendChild(empty);
    return;
  }
  if (a.conversation.nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = a.mode === "claw"
      ? "claw mode — set a goal to start."
      : "type a message to start.";
    $conversation.appendChild(empty);
    return;
  }
  // Walk the active branch from root → head (linear).
  for (const node of a.conversation.nodes) {
    $conversation.appendChild(renderNode(node));
  }
  $conversation.scrollTop = $conversation.scrollHeight;
}

function renderNode(node) {
  const el = document.createElement("div");
  el.className = `turn role-${node.message.role}`;
  el.dataset.nodeId = node.id;
  const role = document.createElement("div");
  role.className = "role-label";
  role.textContent = node.message.role;
  el.appendChild(role);
  for (const block of node.message.content) {
    el.appendChild(renderBlock(block));
  }
  return el;
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

// Update or append a single node (for live streaming).
function updateNodeInDom(node) {
  const a = activeAgent();
  if (!a) return;
  let el = $conversation.querySelector(`[data-node-id="${node.id}"]`);
  if (!el) {
    el = renderNode(node);
    $conversation.appendChild(el);
  } else {
    // Re-render content blocks.
    while (el.children.length > 1) el.removeChild(el.lastChild);
    for (const block of node.message.content) {
      el.appendChild(renderBlock(block));
    }
  }
  $conversation.scrollTop = $conversation.scrollHeight;
}

// ---------- Rendering: input row ----------

function renderInputRow() {
  $inputRow.innerHTML = "";
  const a = activeAgent();
  if (!a) return;

  if (a.status === "deprecated") {
    const btn = document.createElement("button");
    btn.className = "action-btn warn";
    btn.style.width = "100%";
    btn.textContent = "reactivate to send";
    btn.addEventListener("click", () => reactivateAgent(a));
    $inputRow.appendChild(btn);
    return;
  }

  // Running claw: let the user talk to it live, plus a stop button.
  if (runningAgents.has(a.id) && a.mode === "claw") {
    const input = makeMessageInput(a, "message the claw...", false);
    $inputRow.appendChild(input.textarea);
    $inputRow.appendChild(input.sendBtn);
    const stop = document.createElement("button");
    stop.className = "action-btn danger";
    stop.textContent = "stop";
    stop.addEventListener("click", () => stopAgent(a));
    $inputRow.appendChild(stop);
    return;
  }

  // Running auto: just a stop button (one cycle in flight).
  if (runningAgents.has(a.id)) {
    const btn = document.createElement("button");
    btn.className = "action-btn danger";
    btn.style.width = "100%";
    btn.textContent = "stop";
    btn.addEventListener("click", () => stopAgent(a));
    $inputRow.appendChild(btn);
    return;
  }

  // Idle claw: offer to (re)start with a goal.
  if (a.mode === "claw") {
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.style.width = "100%";
    btn.textContent = "claw idle — set a goal to start";
    btn.addEventListener("click", () => openClawDialog());
    $inputRow.appendChild(btn);
    return;
  }

  // Auto mode: textarea + send.
  const input = makeMessageInput(a, "type a message...", true);
  $inputRow.appendChild(input.textarea);
  $inputRow.appendChild(input.sendBtn);
  setTimeout(() => input.textarea.focus(), 0);
}

// Build a textarea + send button that calls sendUserMessage on submit.
// `gateOnCanSend` disables the controls when canSend() is false (auto
// mode); a running claw stays enabled so the user can interject.
function makeMessageInput(agent, placeholder, gateOnCanSend) {
  const textarea = document.createElement("textarea");
  textarea.id = "input";
  textarea.placeholder = placeholder;
  textarea.rows = 1;

  const sendBtn = document.createElement("button");
  sendBtn.id = "send";
  sendBtn.className = "action-btn";
  sendBtn.textContent = "send";

  if (gateOnCanSend) {
    const ready = canSend();
    sendBtn.disabled = !ready;
    textarea.disabled = !ready;
  }

  const submit = () => {
    const text = textarea.value.trim();
    if (!text) return;
    if (gateOnCanSend && !canSend()) return;
    textarea.value = "";
    sendUserMessage(text);
  };
  sendBtn.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  return { textarea, sendBtn };
}

function canSend() {
  const a = activeAgent();
  if (!a) return false;
  if (a.status === "deprecated") return false;
  if (runningAgents.has(a.id)) return false;
  if (!rootDir) return false;
  const key = apiKeys[a.provider];
  return !!key;
}

// ---------- Render orchestrator ----------

function render() {
  renderSidebar();
  renderAgentHeader();
  renderConversation();
  renderInputRow();
}

// ---------- State queries ----------

function activeAgent() {
  return getAgent(state, state.active_agent_id);
}

// ---------- Agent lifecycle ----------

function deprecateAgent(agent) {
  if (runningAgents.has(agent.id)) stopAgent(agent);
  agent.status = "deprecated";
  agent.updated_at = nowIso();
  touch();
  render();
}

function reactivateAgent(agent) {
  agent.status = "active";
  agent.updated_at = nowIso();
  touch();
  render();
}

function switchToAuto(agent) {
  if (runningAgents.has(agent.id)) stopAgent(agent);
  agent.mode = "auto";
  agent.claw_goal = undefined;
  agent.updated_at = nowIso();
  touch();
  render();
}

function stopAgent(agent) {
  const ctl = runningAgents.get(agent.id);
  if (ctl) ctl.abort();
}

// ---------- Send (auto mode) ----------

async function sendUserMessage(text) {
  const a = activeAgent();
  if (!a) return;

  // Append user node.
  const userNode = {
    id: newId("n"),
    parent_id: a.head,
    message: { role: "user", content: [{ kind: "text", text }] },
  };
  a.conversation.nodes.push(userNode);
  a.head = userNode.id;
  a.updated_at = nowIso();
  updateNodeInDom(userNode);
  touch();

  // If this agent is a running claw, deliver the message to it rather than
  // starting a separate cycle. It wakes immediately if its user_message
  // trigger is on; otherwise the message waits for the next timer/file wake.
  if (a.mode === "claw" && runningAgents.has(a.id)) {
    const ctl = runningAgents.get(a.id);
    const cfg = clawConfig(a);
    if (cfg.triggers.user_message) {
      ctl.wake?.("user_message");
      setStatus(`${a.name}: message delivered — waking claw.`);
    } else {
      setStatus(`${a.name}: message queued (claw wakes on timer/file changes).`);
    }
    return;
  }

  // Run agent step loop until no more tool calls or aborted.
  const ctl = new AbortController();
  runningAgents.set(a.id, ctl);
  render();

  try {
    for (let turn = 0; turn < 20; turn++) {
      if (ctl.signal.aborted) break;
      setStatus(`${a.name}: turn ${turn + 1}...`);
      const done = await agentStep({
        agent: a,
        apiKey: apiKeys[a.provider],
        onNodeAppended: (n) => { updateNodeInDom(n); touch(); },
        onNodeUpdated: (n) => { updateNodeInDom(n); touch(); },
        rootDirGetter: () => rootDir,
        setStatus,
        signal: ctl.signal,
      });
      if (done) break;
    }
  } finally {
    runningAgents.delete(a.id);
    render();
  }
}

// ---------- Claw mode ----------

function openClawDialog() {
  $clawText.value = "";
  $clawDlg.showModal();
}

$clawCancel.addEventListener("click", () => $clawDlg.close());
$clawStart.addEventListener("click", async () => {
  const goal = $clawText.value.trim();
  if (!goal) return;
  $clawDlg.close();
  const a = activeAgent();
  if (!a) return;
  a.mode = "claw";
  a.updated_at = nowIso();
  touch();
  render();
  await startClaw(a, goal);
});

async function startClaw(agent, goal) {
  const ctl = createClawController(agent);
  runningAgents.set(agent.id, ctl);
  render();
  try {
    await runClaw({
      agent,
      goal,
      controller: ctl,
      apiKey: apiKeys[agent.provider],
      onNodeAppended: (n) => { updateNodeInDom(n); touch(); },
      onNodeUpdated: (n) => { updateNodeInDom(n); touch(); },
      rootDirGetter: () => rootDir,
      setStatus,
      onParked: () => { touch(); renderSidebar(); renderInputRow(); },
      onResumed: () => { renderSidebar(); renderInputRow(); },
    });
  } finally {
    runningAgents.delete(agent.id);
    agent.claw_state = "stopped";
    render();
  }
}

// ---------- Claw config dialog ----------

function openClawConfigDialog(agent) {
  const cfg = clawConfig(agent);
  $cfgUser.checked = cfg.triggers.user_message;
  $cfgTimer.checked = cfg.triggers.timer;
  $cfgFile.checked = cfg.triggers.file_change;
  $cfgInterval.value = cfg.poll_interval_sec;
  $cfgMaxWork.value = cfg.max_work_turns;
  $cfgDlg.dataset.agentId = agent.id;
  $cfgDlg.showModal();
}

$cfgCancel.addEventListener("click", () => $cfgDlg.close());
$cfgSave.addEventListener("click", () => {
  const agent = getAgent(state, $cfgDlg.dataset.agentId);
  if (!agent) { $cfgDlg.close(); return; }

  const triggers = {
    user_message: $cfgUser.checked,
    timer: $cfgTimer.checked,
    file_change: $cfgFile.checked,
  };
  // A claw with no triggers would park forever — keep the timer on.
  if (!triggers.user_message && !triggers.timer && !triggers.file_change) {
    triggers.timer = true;
  }
  const interval = Math.max(2, parseInt($cfgInterval.value, 10) || 30);
  const maxWork = Math.max(1, parseInt($cfgMaxWork.value, 10) || 50);

  agent.claw_config = {
    triggers,
    poll_interval_sec: interval,
    max_work_turns: maxWork,
  };
  agent.updated_at = nowIso();
  touch();
  $cfgDlg.close();
  setStatus(`${agent.name}: claw config saved (applies at next park).`);
  render();
});

// ---------- New agent dialog ----------

function openNewAgentDialog() {
  $newName.value = `agent ${state.agents.length + 1}`;
  $newProvider.value = "openai";
  $newModel.value = defaultModelFor("openai");
  $newDlg.showModal();
  setTimeout(() => $newName.focus(), 0);
}

$newProvider.addEventListener("change", () => {
  $newModel.value = defaultModelFor($newProvider.value);
});
$newCancel.addEventListener("click", () => $newDlg.close());
$newCreate.addEventListener("click", () => {
  const a = newAgent({
    name: $newName.value || `agent ${state.agents.length + 1}`,
    provider: $newProvider.value,
    model: $newModel.value || defaultModelFor($newProvider.value),
  });
  state.agents.push(a);
  state.active_agent_id = a.id;
  touch();
  render();
  $newDlg.close();
});

// ---------- Folder open ----------

$openFolder.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    rootDir = handle;
    $folderInfo.textContent = handle.name + "/";

    // Try to load workspace from folder.
    const fromFolder = await loadFromFolder(handle);
    if (fromFolder && fromFolder.version === STATE_VERSION) {
      state = fromFolder;
      setStatus(`loaded workspace from ${handle.name}/.luv-workspace.json`);
    } else if (fromFolder && fromFolder.version !== STATE_VERSION) {
      setStatus(
        `workspace file version ${fromFolder.version} not supported (expected ${STATE_VERSION}); ignoring`,
      );
    } else {
      setStatus(`no existing workspace in ${handle.name}; using local state.`);
      touch(); // create the file
    }
    render();
  } catch (e) {
    if (e.name !== "AbortError") setStatus(`folder open: ${e.message}`);
  }
});

// ---------- API key persistence ----------

$openaiKey.addEventListener("input", () => {
  apiKeys.openai = $openaiKey.value;
  localStorage.setItem("luv:openai_key", apiKeys.openai);
  render();
});
$anthropicKey.addEventListener("input", () => {
  apiKeys.anthropic = $anthropicKey.value;
  localStorage.setItem("luv:anthropic_key", apiKeys.anthropic);
  render();
});

// ---------- Boot ----------

async function boot() {
  if (!window.showDirectoryPicker) {
    setStatus(
      "File System Access API not available. Use Chrome, Edge, or a Chromium-based browser.",
    );
    $openFolder.disabled = true;
    return;
  }

  // Restore API keys from localStorage.
  apiKeys.openai = localStorage.getItem("luv:openai_key") ?? "";
  apiKeys.anthropic = localStorage.getItem("luv:anthropic_key") ?? "";
  $openaiKey.value = apiKeys.openai;
  $anthropicKey.value = apiKeys.anthropic;

  // Load most recent workspace from IDB if any.
  const fromIdb = await loadFromIndexedDB();
  if (fromIdb && fromIdb.version === STATE_VERSION) {
    state = fromIdb;
    setStatus(
      "restored from local cache. open a folder to sync changes to disk.",
    );
  }
  render();
}

boot();
