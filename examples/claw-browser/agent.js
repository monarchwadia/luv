// Agent loop primitives.
//
// runAuto(agent, ...) — single send/receive cycle (with tool execution
// for any tool_calls the model returned). For interactive mode: user
// types one message, we call runAuto, it returns when done.
//
// runClaw(agent, ...) — autonomous loop. Caller passes a goal; we
// prepend it as a user message, then iterate until: no tool_calls
// emitted OR maxTurns hit OR the caller aborts via the AbortSignal.

import {
  openaiClient,
  anthropicClient,
  LuvError,
} from "./luv.js";
import { makeHandlers, providerTools } from "./tools.js";
import { newId, nowIso } from "./state.js";

function makeClient(agent, apiKey) {
  if (agent.provider === "openai") return openaiClient({ api_key: apiKey });
  return anthropicClient({ api_key: apiKey });
}

function makeSendOpts(agent) {
  const base = { model: agent.model, tools: providerTools(agent.provider) };
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
  } = opts;

  const client = makeClient(agent, apiKey);
  const sendOpts = makeSendOpts(agent);

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
  const handlers = rootDir ? makeHandlers(rootDir) : null;
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
      if (!handlers) {
        result = "error: no workspace folder open";
      } else if (!(tc.name in handlers)) {
        result = `error: unknown tool '${tc.name}'`;
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
 * Run an autonomous (claw) loop. Appends the goal as a user message
 * first, then iterates `agentStep` until termination.
 */
export async function runClaw(opts) {
  const { agent, goal, maxTurns = 50, signal, onNodeAppended, setStatus } = opts;

  // Append the goal as a user message at the head.
  const goalNode = {
    id: newId("n"),
    parent_id: agent.head,
    message: {
      role: "user",
      content: [
        {
          kind: "text",
          text: `[claw goal] ${goal}\n\nWork toward this goal autonomously. Call tools as needed. When complete (or you've hit a dead end), respond with a final text message and no tool calls.`,
        },
      ],
    },
  };
  agent.conversation.nodes.push(goalNode);
  agent.head = goalNode.id;
  agent.claw_goal = goal;
  agent.updated_at = nowIso();
  onNodeAppended(goalNode);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      setStatus?.("claw stopped by user.");
      return;
    }
    setStatus?.(`claw turn ${turn + 1} / ${maxTurns}...`);
    const done = await agentStep(opts);
    if (done) {
      setStatus?.(`claw finished after ${turn + 1} turn(s).`);
      return;
    }
  }
  setStatus?.(`claw hit max turns (${maxTurns}); stopping.`);
}
