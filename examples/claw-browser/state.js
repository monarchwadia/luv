// Workspace state — schema, IndexedDB persistence, folder sync.
//
// State shape (version 1):
// {
//   version: 1,
//   workspace_id: string,
//   created_at: ISO string,
//   updated_at: ISO string,
//   agents: AgentState[],
//   active_agent_id: string | null,
// }
//
// AgentState:
// {
//   id, name, mode ("auto" | "claw"),
//   status ("active" | "deprecated"),
//   role ("member" | "superadmin"),  // superadmin can manage other agents
//   provider ("openai" | "anthropic"),
//   model: string,
//   created_at, updated_at,
//   conversation: luv Conversation,
//   head: node id or null,
//   claw_goal?: string,
//   claw_config?: ClawConfig,   // wake triggers for continuously-on claw
//   claw_state?: "running" | "parked" | "stopped",  // runtime status
// }
//
// ClawConfig:
// {
//   triggers: { user_message: bool, timer: bool, file_change: bool },
//   poll_interval_sec: number,   // cadence for timer + file_change checks
//   max_work_turns: number,      // safety cap on tool turns before a forced park
// }

export const STATE_VERSION = 1;
const DB_NAME = "luv-workspace";
const DB_STORE = "state";

// ---------- ID helpers ----------

export function newId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------- State factory ----------

export function emptyWorkspaceState() {
  const now = nowIso();
  return {
    version: STATE_VERSION,
    workspace_id: newId("ws"),
    created_at: now,
    updated_at: now,
    agents: [],
    active_agent_id: null,
  };
}

export function newAgent({ name, provider, model }) {
  const now = nowIso();
  return {
    id: newId("agent"),
    name,
    mode: "auto",
    status: "active",
    role: "member",
    provider,
    model,
    created_at: now,
    updated_at: now,
    conversation: { spec_version: "1.0", nodes: [] },
    head: null,
    claw_config: defaultClawConfig(),
  };
}

// ---------- Claw config ----------

export function defaultClawConfig() {
  return {
    triggers: { user_message: true, timer: true, file_change: false },
    poll_interval_sec: 30,
    max_work_turns: 50,
  };
}

// Read an agent's claw config, filling defaults for any missing fields so
// older persisted agents (no claw_config) still behave sensibly.
export function clawConfig(agent) {
  const d = defaultClawConfig();
  const c = agent?.claw_config ?? {};
  return {
    triggers: { ...d.triggers, ...(c.triggers ?? {}) },
    poll_interval_sec: c.poll_interval_sec ?? d.poll_interval_sec,
    max_work_turns: c.max_work_turns ?? d.max_work_turns,
  };
}

// ---------- IndexedDB persistence ----------

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function loadFromIndexedDB() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get("current");
    req.onsuccess = () => resolve(req.result?.state ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveToIndexedDB(state) {
  state.updated_at = nowIso();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ id: "current", state });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Folder sync ----------

const WORKSPACE_FILE = ".luv-workspace.json";

export async function loadFromFolder(rootDir) {
  if (!rootDir) return null;
  try {
    const handle = await rootDir.getFileHandle(WORKSPACE_FILE);
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

export async function saveToFolder(rootDir, state) {
  if (!rootDir) return;
  const handle = await rootDir.getFileHandle(WORKSPACE_FILE, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(state, null, 2));
  await w.close();
}

// ---------- Debounced sync orchestrator ----------

/**
 * Wraps two backends (IDB + folder) with debounced writes. Caller invokes
 * `touch()` after any mutation; the orchestrator coalesces rapid changes.
 */
export function createSyncOrchestrator({ getState, getRootDir, onError }) {
  let idbTimer = null;
  let diskTimer = null;
  let idbPending = false;
  let diskPending = false;

  async function flushIdb() {
    idbPending = false;
    try {
      await saveToIndexedDB(getState());
    } catch (e) {
      onError?.(e);
    }
  }

  async function flushDisk() {
    diskPending = false;
    const rootDir = getRootDir();
    if (!rootDir) return;
    try {
      await saveToFolder(rootDir, getState());
    } catch (e) {
      onError?.(e);
    }
  }

  function touch() {
    idbPending = true;
    diskPending = true;
    if (idbTimer) clearTimeout(idbTimer);
    if (diskTimer) clearTimeout(diskTimer);
    idbTimer = setTimeout(flushIdb, 300);
    diskTimer = setTimeout(flushDisk, 1500);
  }

  async function flushNow() {
    if (idbTimer) {
      clearTimeout(idbTimer);
      idbTimer = null;
    }
    if (diskTimer) {
      clearTimeout(diskTimer);
      diskTimer = null;
    }
    if (idbPending) await flushIdb();
    if (diskPending) await flushDisk();
  }

  return { touch, flushNow };
}

// ---------- State queries ----------

export function getAgent(state, id) {
  return state.agents.find((a) => a.id === id) ?? null;
}

export function activeAgents(state) {
  return state.agents.filter((a) => a.status === "active");
}

export function deprecatedAgents(state) {
  return state.agents.filter((a) => a.status === "deprecated");
}
