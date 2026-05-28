# claw-browser — luv workspace

A multi-agent workspace that lives entirely in a browser tab. No
install, no server, no backend. The whole thing is static files plus a
bundled copy of luv. It uses the File System Access API to read and
write real files; it persists all state to IndexedDB and syncs it to a
`.luv-workspace.json` file in the workspace folder.

## What it does

- **Open a folder** as a workspace (one-time permission grant).
- **Run many agents** in that workspace, each with its own conversation,
  provider, and model.
- **Two modes per agent:**
  - **auto** — interactive, like a chat. You type, it replies, it can
    call tools, you type again.
  - **claw** — autonomous. You give it a goal; it runs the tool loop on
    its own until it finishes or hits the turn limit.
- **Switch modes at any time.** auto ↔ claw. Switching to claw asks for
  a goal; switching to auto stops a running claw.
- **Three file tools:** `list_files`, `read_file`, `write_file`
  (write asks for approval).
- **Live streaming** of replies, token by token.
- **Persistence:** every change is saved to IndexedDB (debounced ~300ms)
  and synced to `<folder>/.luv-workspace.json` (debounced ~1.5s).
  Reload the page and your whole workspace comes back.
- **Never delete:** agents are deprecated/reactivated, not removed. The
  full history stays in the workspace file.

## Run it

Chromium-based browser required (Chrome, Edge, Brave, Arc, Opera) — the
File System Access API isn't in Firefox or Safari yet.

From the repo root, start any static server:

```sh
python3 -m http.server 8000
# or: bun --hot serve .   /   npx serve
```

Open `http://localhost:<port>/examples/claw-browser/index.html`.

1. Paste an `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` (kept in
   localStorage; never written to the workspace file).
2. Click **open folder** and grant read/write to your project.
3. Click **+ new agent**, name it, pick a provider/model.
4. Type a message (auto mode), or switch the agent to **claw** and give
   it a goal.

The workspace state is written to `<folder>/.luv-workspace.json`. Commit
it, share it, or open the same folder later to resume exactly where you
left off.

## State model

A single workspace state object (versioned) holds everything:

```jsonc
{
  "version": 1,
  "workspace_id": "ws_...",
  "created_at": "...",
  "updated_at": "...",
  "active_agent_id": "agent_...",
  "agents": [
    {
      "id": "agent_...",
      "name": "coder",
      "mode": "auto",            // or "claw"
      "status": "active",        // or "deprecated"
      "provider": "openai",
      "model": "gpt-4o-mini",
      "conversation": { "spec_version": "1.0", "nodes": [ /* luv */ ] },
      "head": "n_...",
      "claw_goal": "...",        // present in claw mode
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

Each agent's `conversation` is a canonical luv `Conversation`. The
workspace file is just JSON — readable, diffable, portable.

## Files

```
index.html   — UI shell + styles
app.js       — wiring, rendering, lifecycle, agent/claw orchestration
state.js     — state schema, IndexedDB persistence, folder sync
agent.js     — agentStep (one cycle) + runClaw (autonomous loop)
tools.js     — File System Access tools
luv.js       — bundled luv runtime (regenerate with `bun run bundle:browser`)
```

## Security model

The browser is the sandbox. The agents can do exactly what the user
granted via File System Access — typically one folder, revocable at any
time from browser settings. API keys live only in localStorage and
memory; they are never written into the workspace file that syncs to
disk. The `write_file` approval prompt is a UX safeguard, not the
security boundary — the sandbox is.

## Current limitations

- **Forks not yet in the UI.** The data model is fork-ready (every node
  has `parent_id`) but the conversation view walks linearly. Regenerate
  / branch buttons are a planned addition.
- **No conflict merge.** If the same workspace folder is opened in two
  tabs, last-writer-wins on the `.luv-workspace.json`.
- **Text only.** No multimodal.
- **Single-branch conversation rendering.** A forked conversation would
  show all nodes in array order rather than as a tree.

## Why this is interesting

A complete multi-agent IDE-shell — interactive agents and autonomous
background workers, file editing, persistence, provider portability —
as a static web page. Open it from a URL. No node, no electron, no
docker. The browser's native APIs and luv's canonical types do all the
work.
