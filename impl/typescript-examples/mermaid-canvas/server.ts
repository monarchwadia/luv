// mermaid-canvas — speak, and watch a Mermaid diagram draw itself.
//
// The browser does the listening (Chrome Web Speech API) and the drawing
// (mermaid.js). This Bun server does exactly one interesting thing: it
// takes the running transcript and asks an LLM, *through luv*, to render it
// as a single Mermaid diagram. The conversation is a canonical luv
// `Conversation`; swapping OpenAI for Anthropic is a one-line change.
//
//   bun server.ts        (set OPENAI_API_KEY first — see README)

import { LUV_SPEC_VERSION, LuvError, openaiClient } from "luv";
import type { Conversation } from "luv";

// ---------- env ----------

// Load the repo-root .env regardless of cwd. Existing process env wins.
const rootEnv = Bun.file(new URL("../../../.env", import.meta.url));
if (await rootEnv.exists()) {
  for (const line of (await rootEnv.text()).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (!key || process.env[key]) continue;
    process.env[key] = (rawVal ?? "").replace(/^["']|["']$/g, "");
  }
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY not set in the repo-root .env or your environment");
  process.exit(1);
}

const MODEL = process.env.LUV_CANVAS_MODEL ?? "gpt-4o-mini";
const PORT = Number(process.env.PORT ?? 3000);
const client = openaiClient({ api_key: apiKey });

// ---------- the one prompt that matters ----------

const SYSTEM_PROMPT = `You turn a live, spoken conversation transcript into a single Mermaid diagram.

The transcript arrives incrementally as two people talk. Your job is to keep ONE coherent diagram that captures the concepts, entities, decisions, and relationships being discussed, and to evolve it as the conversation grows.

Rules:
- Output ONLY valid Mermaid diagram source. No markdown code fences, no prose, no explanation, no leading or trailing commentary.
- Pick the most fitting diagram type for what's being discussed: flowchart (graph TD / LR), sequenceDiagram, mindmap, classDiagram, stateDiagram-v2, or erDiagram.
- Prefer stability: keep node names and structure consistent between updates so the picture grows rather than churns. Add and connect new ideas; only restructure when the conversation clearly changed direction.
- Keep node text short (a few words). Use clear, human-readable labels.
- Escape or avoid characters that break Mermaid (quotes inside labels, stray semicolons, parentheses in node text).
- If the transcript is empty or too short to mean anything, output a minimal valid placeholder:
  flowchart TD
    start["Listening..."]`;

// Build a fresh canonical conversation for each render. We don't need
// multi-turn memory here — the full transcript is the input, and the
// previous diagram is passed as context so the model evolves it.
function buildConversation(transcript: string, previous: string): Conversation {
  const userText =
    (previous.trim()
      ? `Current diagram (evolve this; keep it stable where you can):\n${previous}\n\n`
      : "") + `Conversation transcript so far:\n${transcript}`;

  return {
    spec_version: LUV_SPEC_VERSION,
    nodes: [
      {
        id: "n0",
        parent_id: null,
        message: { role: "system", content: [{ kind: "text", text: SYSTEM_PROMPT }] },
      },
      {
        id: "n1",
        parent_id: "n0",
        message: { role: "user", content: [{ kind: "text", text: userText }] },
      },
    ],
  };
}

// Models sometimes wrap output in ```mermaid fences despite instructions.
function stripFences(s: string): string {
  const fenced = s.match(/```(?:mermaid)?\s*\n?([\s\S]*?)\n?```/);
  return (fenced ? fenced[1]! : s).trim();
}

// ---------- server ----------

const html = Bun.file(new URL("./index.html", import.meta.url));

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "POST" && url.pathname === "/diagram") {
      let body: { transcript?: string; previous?: string };
      try {
        body = (await req.json()) as { transcript?: string; previous?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      const transcript = (body.transcript ?? "").trim();
      const previous = body.previous ?? "";

      try {
        const reply = await client.send(buildConversation(transcript, previous), { model: MODEL });
        const text = reply.message.content
          .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
          .map((b) => b.text)
          .join("");
        return Response.json({ mermaid: stripFences(text) });
      } catch (err) {
        if (err instanceof LuvError) {
          return Response.json(
            { error: err.data.message, category: err.data.category },
            { status: 502 },
          );
        }
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`mermaid-canvas — model ${MODEL}`);
console.log(`open  http://localhost:${server.port}  in Chrome, click Record, and start talking.`);
