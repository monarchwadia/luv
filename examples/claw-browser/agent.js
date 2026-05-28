// Agent loop primitives.
//
// agentStep(opts) — single send/receive cycle (with tool execution for
// any tool_calls the model returned). For interactive mode: user types
// one message, we call agentStep, it returns when done.
//
// runClaw(opts) — continuously-on autonomous daemon. Caller passes a goal
// and a ClawController. We append the goal, then loop forever: a *work*
// phase (step until the model stops calling tools) followed by a *park*
// phase (idle until a wake trigger fires). Triggers are per-agent
// (claw_config): a new user message, a timer heartbeat, and/or a
// workspace file change. The loop only ends when the controller aborts.

import {
  openaiClient,
  anthropicClient,
  LuvError,
} from "./luv.js";
import { makeHandlers, providerTools } from "./tools.js";
import { newId, nowIso, clawConfig } from "./state.js";

function makeClient(agent, apiKey) {
  if (agent.provider === "openai") return openaiClient({ api_key: apiKey });
  return anthropicClient({ api_key: apiKey });
}

function makeSendOpts(agent, extraToolDefs) {
  const tools = providerTools(agent.provider);
  const base = {
    model: agent.model,
    tools: extraToolDefs?.length ? [...tools, ...extraToolDefs] : tools,
  };
  if (agent.provider === "anthropic") base.max_tokens = 4096;
  return base;
}

function appendNode(agent, role, content) {
  const node = {
    id: newId("n"),
    parent_id: agent.head,
    message: { role, content },
  };
  agent.conversation.nodes.push(node);
  agent.head = node.id;
  agent.updated_at = nowIso();
  return node;
}

function updateNode(node, content, agent) {
  node.message.content = content;
  agent.updated_at = nowIso();
}

/**
 * Run one send → stream → tool-loop cycle.
 *
 * @param {object} opts
 * @param {object} opts.agent — agent state (mutated in place)
 * @param {string} opts.apiKey
 * @param {function} opts.onNodeAppended — (node) => void; new node visible
 * @param {function} opts.onNodeUpdated — (node) => void; existing node changed
 * @param {function} opts.rootDirGetter — () => FileSystemDirectoryHandle
 * @param {function} opts.setStatus — (string) => void
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<boolean>} true if the loop terminated cleanly (no
 *   more tool_calls), false if it stopped for some other reason
 *   (signal, error). Caller decides whether to keep going.
 */
export async function agentStep(opts) {
  const {
    agent,
    apiKey,
    onNodeAppended,
    onNodeUpdated,
    rootDirGetter,
    setStatus,
    signal,
    extraToolDefs,
    adminHandlers,
  } = opts;

  const client = makeClient(agent, apiKey);
  const sendOpts = makeSendOpts(agent, extraToolDefs);

  // 1. Build assistant node placeholder.
  const assistantNode = appendNode(agent, "assistant", []);
  onNodeAppended(assistantNode);

  const blocks = [];
  let currentBlock = null;

  // 2. Stream the reply, surfacing deltas live.
  try {
    for await (const event of client.stream(agent.conversation, sendOpts)) {
      if (signal?.aborted) throw new Error("aborted");

      if (event.kind === "block_start") {
        currentBlock = JSON.parse(JSON.stringify(event.block));
        blocks.push(currentBlock);
        updateNode(assistantNode, blocks, agent);
        onNodeUpdated(assistantNode);
      } else if (event.kind === "text_delta" && currentBlock?.kind === "text") {
        currentBlock.text += event.text;
        updateNode(assistantNode, blocks, agent);
        onNodeUpdated(assistantNode);
      } else if (event.kind === "args_delta" && currentBlock?.kind === "tool_call") {
        currentBlock.args += event.args;
        updateNode(assistantNode, blocks, agent);
        onNodeUpdated(assistantNode);
      } else if (event.kind === "block_end") {
        currentBlock = null;
      }
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
      msg = String(e?.message ?? e);
    }
    blocks.push({ kind: "error", category, message: msg, details });
    updateNode(assistantNode, blocks, agent);
    onNodeUpdated(assistantNode);
    setStatus?.(`failed: [${category}] ${msg}`);
    return false;
  }

  // 3. Any tool_calls? Execute them; append tool_result user message.
  const toolCalls = blocks.filter((b) => b.kind === "tool_call");
  if (toolCalls.length === 0) {
    setStatus?.("idle.");
    return true; // natural turn end
  }

  const rootDir = rootDirGetter();
  const fsHandlers = rootDir ? makeHandlers(rootDir) : null;
  const handlers = { ...(fsHandlers ?? {}), ...(adminHandlers ?? {}) };
  const hasAnyHandlers = fsHandlers || adminHandlers;
  const resultBlocks = [];
  for (const tc of toolCalls) {
    if (signal?.aborted) {
      resultBlocks.push({
        kind: "tool_result",
        call_id: tc.id,
        text: "user aborted before this tool ran",
      });
      continue;
    }
    let result;
    try {
      const args = JSON.parse(tc.args);
      if (!(tc.name in handlers)) {
        result = hasAnyHandlers
          ? `error: unknown tool '${tc.name}'`
          : "error: no workspace folder open";
      } else {
        result = await handlers[tc.name](args);
      }
    } catch (e) {
      result = `error: ${e?.message ?? String(e)}`;
    }
    resultBlocks.push({ kind: "tool_result", call_id: tc.id, text: result });
  }

  const resultNode = appendNode(agent, "user", resultBlocks);
  onNodeAppended(resultNode);
  return false; // tools were called; caller decides whether to continue
}

/**
 * A claw controller wraps an AbortController with a `wake` primitive.
 * `abort()` stops the daemon entirely; `wake(reason)` resumes it from a
 * park (used when a new user message arrives). Timer / file-change wakes
 * are handled internally by parkUntilWake.
 */
export function createClawController(agent) {
  const ac = new AbortController();
  let parkResolve = null; // set only while parked
  return {
    agent,
    get signal() {
      return ac.signal;
    },
    abort() {
      ac.abort();
    },
    isParked() {
      return parkResolve !== null;
    },
    wake(reason = "user_message") {
      if (parkResolve) parkResolve(reason);
    },
    _setPark(fn) {
      parkResolve = fn;
    },
  };
}

/**
 * Continuously-on claw daemon. Runs until `controller.abort()`.
 *
 * @param {object} opts
 * @param {object} opts.agent
 * @param {string} [opts.goal] — appended as the opening user message
 * @param {object} opts.controller — from createClawController
 * @param {string} opts.apiKey
 * @param {function} opts.onNodeAppended
 * @param {function} opts.onNodeUpdated
 * @param {function} opts.rootDirGetter
 * @param {function} opts.setStatus
 * @param {function} [opts.onParked]
 * @param {function} [opts.onResumed]
 */
export async function runClaw(opts) {
  const { agent, goal, controller, onNodeAppended, setStatus } = opts;
  const signal = controller.signal;

  if (goal) {
    const goalNode = {
      id: newId("n"),
      parent_id: agent.head,
      message: {
        role: "user",
        content: [
          {
            kind: "text",
            text: `[claw goal] ${goal}\n\nWork toward this goal autonomously. Call tools as needed. When you have nothing left to do right now, respond with a short status and no tool calls — you'll be re-engaged when there's new work.`,
          },
        ],
      },
    };
    agent.conversation.nodes.push(goalNode);
    agent.head = goalNode.id;
    agent.claw_goal = goal;
    agent.updated_at = nowIso();
    onNodeAppended(goalNode);
  }

  const cfg = clawConfig(agent);
  const maxWork = cfg.max_work_turns;

  while (!signal.aborted) {
    // --- Work phase: step until the model stops calling tools. ---
    agent.claw_state = "running";
    let work = 0;
    while (!signal.aborted) {
      setStatus?.(`${agent.name}: working (turn ${work + 1})...`);
      const done = await agentStep({ ...opts, signal });
      work++;
      if (done) break; // natural end — no more tool calls
      if (work >= maxWork) {
        setStatus?.(`${agent.name}: hit ${maxWork} work turns; parking.`);
        break;
      }
    }
    if (signal.aborted) break;

    // --- Park phase: idle until a wake trigger fires. ---
    agent.claw_state = "parked";
    agent.updated_at = nowIso();
    opts.onParked?.();
    setStatus?.(`${agent.name}: parked — ${describeTriggers(cfg)}.`);

    const reason = await parkUntilWake(controller, opts, cfg);
    if (reason === "abort" || signal.aborted) break;

    agent.claw_state = "running";
    opts.onResumed?.(reason);
    appendWakeNudge(agent, reason, agent.claw_goal, onNodeAppended);
  }

  agent.claw_state = "stopped";
  setStatus?.(`${agent.name}: claw stopped.`);
}

// Wait until one of the agent's enabled triggers fires. Resolves with the
// reason ("user_message" | "timer" | "file_change" | "abort").
function parkUntilWake(controller, opts, cfg) {
  const signal = controller.signal;
  const intervalMs = Math.max(2, cfg.poll_interval_sec) * 1000;

  return new Promise((resolve) => {
    let settled = false;
    let timerId = null;
    let pollId = null;
    let lastSnap = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      controller._setPark(null);
      signal.removeEventListener("abort", onAbort);
      if (timerId) clearTimeout(timerId);
      if (pollId) clearInterval(pollId);
      resolve(reason);
    };

    const onAbort = () => finish("abort");
    if (signal.aborted) return finish("abort");
    signal.addEventListener("abort", onAbort);

    // External wake (a new user message) calls controller.wake() → finish.
    controller._setPark(finish);

    if (cfg.triggers.timer) {
      timerId = setTimeout(() => finish("timer"), intervalMs);
    }

    if (cfg.triggers.file_change) {
      snapshotWorkspace(opts.rootDirGetter?.()).then((s) => {
        if (lastSnap === null) lastSnap = s;
      });
      pollId = setInterval(async () => {
        try {
          const s = await snapshotWorkspace(opts.rootDirGetter?.());
          if (lastSnap !== null && s !== lastSnap) {
            lastSnap = s;
            finish("file_change");
          } else {
            lastSnap = s;
          }
        } catch {
          /* transient FS error — try again next tick */
        }
      }, intervalMs);
    }
  });
}

// On wake, nudge the model so it knows why it was re-engaged. A
// user-message wake needs no nudge (the message is already in the convo).
function appendWakeNudge(agent, reason, goal, onNodeAppended) {
  let text;
  if (reason === "timer") {
    text =
      `[heartbeat ${nowIso()}] Re-check your goal and the workspace. ` +
      `If there is new work toward your goal, do it now by calling tools. ` +
      `If there is nothing to do, reply with a short status and no tool calls to keep waiting.`;
  } else if (reason === "file_change") {
    text =
      `[workspace changed ${nowIso()}] Files in the workspace changed on disk. ` +
      `Inspect what changed (list_files / read_file) and, if it is relevant to your goal` +
      (goal ? ` "${goal}"` : "") +
      `, act on it. Otherwise reply briefly with no tool calls.`;
  } else {
    return; // user_message: already appended by the caller
  }

  const node = {
    id: newId("n"),
    parent_id: agent.head,
    message: { role: "user", content: [{ kind: "text", text }] },
  };
  agent.conversation.nodes.push(node);
  agent.head = node.id;
  agent.updated_at = nowIso();
  onNodeAppended?.(node);
}

function describeTriggers(cfg) {
  const t = cfg.triggers;
  const on = [];
  if (t.user_message) on.push("messages");
  if (t.timer) on.push(`timer ${cfg.poll_interval_sec}s`);
  if (t.file_change) on.push("file changes");
  return on.length ? `wakes on ${on.join(", ")}` : "no triggers (idle until stopped)";
}

// Cheap fingerprint of the workspace tree (name:size:mtime), used to
// detect on-disk changes. Skips heavy/noisy dirs and hidden entries.
const SNAP_SKIP = new Set(["node_modules", ".luv-workspace.json"]);
async function snapshotWorkspace(rootDir, depth = 0) {
  if (!rootDir || depth > 6) return "";
  const parts = [];
  try {
    for await (const [name, handle] of rootDir.entries()) {
      if (name.startsWith(".") || SNAP_SKIP.has(name)) continue;
      if (handle.kind === "file") {
        try {
          const f = await handle.getFile();
          parts.push(`${name}:${f.size}:${f.lastModified}`);
        } catch {
          /* unreadable file — ignore */
        }
      } else {
        parts.push(`${name}/{${await snapshotWorkspace(handle, depth + 1)}}`);
      }
    }
  } catch {
    /* unreadable dir — ignore */
  }
  parts.sort();
  return parts.join("|");
}
