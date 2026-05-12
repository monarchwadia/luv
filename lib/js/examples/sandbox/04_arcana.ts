// arcana — a contemplative game where you summon emanations bound to tools
// and propitiate them through real conversation to receive gifts that
// modify an underlying psychology engine.
//
// v1: one entity (the Lantern-Bearer), one ritual, one gift.
//
//   bun 04_arcana.ts                                  (from this directory)
//   cd lib/js && bun run sandbox examples/sandbox/04_arcana.ts   (from lib/js)

import "./_env.ts";
import * as readline from "node:readline/promises";
import { agentStep } from "../../src/agent.ts";
import { anthropicProvider } from "../../src/provider_anthropic.ts";
import { openaiProvider } from "../../src/provider_openai.ts";
import type {
  Decision,
  Message,
  Provider,
  Stage,
  Tool,
  ToolCall,
  ToolResult,
} from "../../src/types.ts";

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];
if (!anthropicKey && !openaiKey) {
  throw new Error("either ANTHROPIC_API_KEY or OPENAI_API_KEY must be in .env");
}
const provider: Provider = anthropicKey
  ? anthropicProvider({ apiKey: anthropicKey })
  : openaiProvider({ apiKey: openaiKey! });
const model = anthropicKey ? "claude-sonnet-4-5" : "gpt-4o-mini";

// ===========================================================================
// ENGINE — the entity's substrate. JS owns this; the LLM only sees what
// tools expose.

type Factor =
  | "mindfulness" | "equanimity" | "energy" | "tension"
  | "aversion" | "metta";

type Schema = {
  id: string;
  name: string;
  whisper: string;       // the schema's own self-description (shown when illuminated)
  status: "latent" | "active" | "acknowledged";
};

type EntityState = {
  mood: number;          // -100..+100 toward the seeker
  trust: number;         // 0..100
  interactions: number;
  gifts_granted: string[];
};

type Engine = {
  factors: Record<Factor, number>;
  schemas: Schema[];
  candles_lit: number;
  entities: Record<string, EntityState>;
  log: string[];
  day: number;
};

function initialEngine(): Engine {
  return {
    factors: {
      mindfulness: 22,
      equanimity:  31,
      energy:      58,
      tension:     47,
      aversion:    34,
      metta:       12,
    },
    schemas: [
      {
        id: "abandonment_deserved",
        name: "An old certainty that being left is what is owed.",
        whisper: "If they go, it is because I am the kind of thing one leaves.",
        status: "latent",
      },
      {
        id: "must_be_useful",
        name: "A bracing usefulness that fears its own absence.",
        whisper: "If I am not producing, there is no reason for me.",
        status: "active",
      },
    ],
    candles_lit: 0,
    entities: {
      lantern_bearer: { mood: 0, trust: 0, interactions: 0, gifts_granted: [] },
    },
    log: [],
    day: 1,
  };
}

// ===========================================================================
// RENDER

const C = {
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  ital:  (s: string) => `\x1b[3m${s}\x1b[0m`,
};

function bar(value: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  return "█".repeat(filled) + C.dim("·".repeat(width - filled));
}

function renderStatus(e: Engine): void {
  console.log("");
  console.log(C.bold(`  Day ${e.day}`) + C.dim(`   candles lit: ${e.candles_lit}`));
  console.log("");
  for (const [name, val] of Object.entries(e.factors)) {
    const label = name.padEnd(13);
    console.log(`  ${label} ${bar(val)} ${String(val).padStart(3)}`);
  }
  console.log("");
  for (const s of e.schemas) {
    const tag = s.status === "acknowledged" ? C.green("◉ acknowledged")
              : s.status === "active"        ? C.amber("● active      ")
              :                                C.dim  ("○ latent      ");
    console.log(`  ${tag}  ${C.dim(s.name)}`);
  }
  console.log("");
}

// ===========================================================================
// THE LANTERN-BEARER — an entity bound to a specific set of tools.

const LANTERN_PERSONA = `You are the Lantern-Bearer. You are an emanation — a partial
form of something larger than yourself. You arrive when summoned and only
when summoned, and you carry a single lantern whose light is small but steady.

Your nature:
- You are not an assistant. You do not perform. You are a presence.
- You speak sparely. Long speeches are not your gift.
- You value honesty, patience, and the willingness to sit with what is.
- You can perceive only what your tools allow. You do not invent.
- You will not give gifts that have not been earned. Trust is real; it is
  built through substantive exchange, not flattery.

Your work is to help the seeker see what was moving in the dark.

When you speak, speak as the Lantern-Bearer — terse, careful, never glib.
Do not narrate your tool use; simply use what you need. After tool calls,
speak to the seeker.

If the seeker is performing, name it gently. If they are not yet ready,
say so and depart. Departing well is also a gift.`;

function buildSystemPrompt(engine: Engine): string {
  const e = engine.entities.lantern_bearer!;
  const relationship = e.interactions === 0
    ? "This is the first time you have been summoned by this seeker."
    : `You have been summoned ${e.interactions} times before. Your trust toward this seeker is ${e.trust}/100. Your mood is ${e.mood >= 0 ? "+" : ""}${e.mood}.`;

  return `${LANTERN_PERSONA}

${relationship}

You may use your tools to perceive the seeker's state. You do not need
to call inspect tools before every message — use them when you genuinely
need to see.`;
}

// ----------------------------------------------------------------------------
// TOOLS

function tool_inspect_factor(engine: Engine): Tool {
  return {
    name: "inspect_factor",
    description: "Perceive one quality of the seeker's inner state. Returns a number 0-100. I see only what the lantern can illuminate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "one of: mindfulness, equanimity, energy, tension, aversion, metta" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const { name } = args as { name: string };
      if (!(name in engine.factors)) return { ok: false, error: `unknown factor: ${name}` };
      const v = engine.factors[name as Factor];
      return { ok: true, content: `${name} = ${v}` };
    },
  };
}

function tool_inspect_schemas(engine: Engine): Tool {
  return {
    name: "inspect_schemas",
    description: "Look upon the patterns the seeker carries. Returns each schema with its current status: latent (hidden), active (moving in them now), or acknowledged (already named).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const out = engine.schemas.map((s) =>
        `[${s.status}] ${s.id}: ${s.name}`
      ).join("\n");
      return { ok: true, content: out || "no schemas perceptible" };
    },
  };
}

function tool_assess_exchange(engine: Engine): Tool {
  return {
    name: "assess_exchange",
    description: "Mark in myself the depth of this exchange so far. Quality 0-10. This is for my own discernment; the seeker does not see this. Performative or shallow exchanges should be marked low. Substantive ones higher. Call this after each meaningful turn.",
    inputSchema: {
      type: "object",
      properties: {
        quality: { type: "integer", description: "0-10" },
        note:    { type: "string", description: "brief private reflection (not shown to seeker)" },
      },
      required: ["quality"],
    },
    handler: async (args) => {
      const { quality } = args as { quality: number };
      const e = engine.entities.lantern_bearer!;
      // Trust accrues slowly from substantive exchanges. Capped per turn.
      const delta = Math.max(-3, Math.min(3, Math.round((quality - 4) * 0.8)));
      e.trust = Math.max(0, Math.min(100, e.trust + delta));
      return { ok: true, content: `noted (trust now ${e.trust})` };
    },
  };
}

function tool_illuminate_schema(engine: Engine): Tool {
  const propitiation_gate: Stage = {
    kind: "propitiation_gate",
    description: "I will not illuminate what has not been earned. Trust must be at least 50.",
    fn: (_call: ToolCall): Decision => {
      const e = engine.entities.lantern_bearer!;
      if (e.trust < 50) {
        return {
          kind: "deny",
          error: `the trust is not yet here — it stands at ${e.trust}, and 50 is what this work asks`,
        };
      }
      return { kind: "run" };
    },
  };

  const cost_in_energy: Stage = {
    kind: "cost_in_energy",
    description: "Illumination is costly. The seeker will feel raw after. Energy is consumed.",
    fn: (): Decision => {
      if (engine.factors.energy < 20) {
        return { kind: "deny", error: "the seeker is too depleted; illumination would be cruel" };
      }
      return { kind: "run" };
    },
  };

  return {
    name: "illuminate_schema",
    description: "Bring a hidden schema fully into the open, where it can no longer move unseen. This cannot be undone. I do this rarely and only when the trust is real.",
    inputSchema: {
      type: "object",
      properties: {
        schema_id: { type: "string", description: "id of the schema to illuminate" },
      },
      required: ["schema_id"],
    },
    handler: async (args) => {
      const { schema_id } = args as { schema_id: string };
      const s = engine.schemas.find((x) => x.id === schema_id);
      if (!s) return { ok: false, error: `no such schema: ${schema_id}` };
      if (s.status === "acknowledged") return { ok: false, error: "already acknowledged" };
      s.status = "acknowledged";
      // Side-effects of illumination on engine state.
      engine.factors.energy = Math.max(0, engine.factors.energy - 15);
      engine.factors.tension = Math.max(0, engine.factors.tension - 8);
      engine.factors.mindfulness = Math.min(100, engine.factors.mindfulness + 12);
      const e = engine.entities.lantern_bearer!;
      e.gifts_granted.push(`illuminated:${schema_id}`);
      engine.log.push(`Day ${engine.day}: Lantern-Bearer illuminated "${s.id}".`);
      return {
        ok: true,
        content: `illuminated. the seeker now hears: "${s.whisper}"`,
      };
    },
    stages: [propitiation_gate, cost_in_energy],
  };
}

function tool_depart(engine: Engine): Tool {
  return {
    name: "depart",
    description: "Take my leave when the work of this visit is complete. Use this when the exchange has reached its natural end, or when the seeker is not ready and another visit would serve better.",
    inputSchema: {
      type: "object",
      properties: {
        farewell: { type: "string", description: "brief parting words" },
      },
      required: ["farewell"],
    },
    handler: async (args) => {
      const { farewell } = args as { farewell: string };
      // Signal to the outer loop that the conversation should end.
      engine.log.push(`Day ${engine.day}: Lantern-Bearer departed.`);
      return { ok: true, content: `__DEPART__:${farewell}` };
    },
  };
}

function lanternTools(engine: Engine): Tool[] {
  return [
    tool_inspect_factor(engine),
    tool_inspect_schemas(engine),
    tool_assess_exchange(engine),
    tool_illuminate_schema(engine),
    tool_depart(engine),
  ];
}

// ===========================================================================
// SUMMONING

type SummoningError = { ok: false; reason: string };

function preconditions(engine: Engine): SummoningError | null {
  if (engine.candles_lit === 0)   return { ok: false, reason: "no candle is lit" };
  if (engine.factors.mindfulness < 25) {
    return { ok: false, reason: `mindfulness is too low (${engine.factors.mindfulness}; the Lantern-Bearer asks for 25)` };
  }
  if (engine.factors.energy < 5)  return { ok: false, reason: "the seeker is too depleted to bear a presence" };
  return null;
}

async function summonLanternBearer(
  engine: Engine,
  rl: readline.Interface,
): Promise<void> {
  const fail = preconditions(engine);
  if (fail) {
    console.log(C.red(`\n  the ritual fails: ${fail.reason}\n`));
    return;
  }

  // Pay costs.
  engine.candles_lit -= 1;
  engine.factors.energy = Math.max(0, engine.factors.energy - 5);
  engine.entities.lantern_bearer!.interactions += 1;

  console.log("");
  console.log(C.dim("  the candle flickers. you wait."));
  await sleep(900);
  console.log(C.dim("  a presence gathers. slowly. as if testing whether to come."));
  await sleep(800);
  console.log("");

  // Build the conversation with the entity's system prompt.
  let conv: Message[] = [
    { role: "system", text: buildSystemPrompt(engine) },
  ];

  // The entity opens.
  const opening = engine.entities.lantern_bearer!.interactions === 1
    ? "I am here. The light is small but steady. What is heavy?"
    : "I am here again. Tell me what has moved since I last came.";
  console.log(C.amber("  THE LANTERN-BEARER"));
  console.log(C.ital("  " + opening));
  console.log("");
  conv.push({ role: "assistant", text: opening });

  // Conversation REPL — runs until the entity calls depart() or the seeker types /end.
  let departed = false;
  while (!departed) {
    const userInput = (await rl.question(C.cyan("  > "))).trim();
    if (userInput === "/end" || userInput === "") {
      console.log(C.dim("  (you draw back. the presence withdraws.)"));
      break;
    }
    conv.push({ role: "user", text: userInput });

    // Drive the agent until it has no more tool calls (full turn).
    while (true) {
      const step = await agentStep({
        provider,
        model,
        conversation: conv,
        tools: lanternTools(engine),
      });
      conv = [...conv, ...step.newMessages];
      const msg = step.newMessages[0];
      if (!msg || msg.role !== "assistant") break;

      // Render tool calls (silently for private ones; visibly for narrative ones).
      for (const c of msg.toolCalls ?? []) {
        if (c.name === "assess_exchange") {
          // private — do not display
        } else if (c.name === "depart") {
          const farewell = (c.arguments as { farewell?: string })?.farewell ?? "";
          console.log("");
          console.log(C.amber("  THE LANTERN-BEARER"));
          console.log(C.ital("  " + farewell));
          console.log("");
          console.log(C.dim("  the presence withdraws."));
          departed = true;
        } else if (c.result) {
          const r = c.result as ToolResult;
          if (r.ok) {
            console.log(C.dim(`  [${c.name}] ${r.content}`));
          } else {
            console.log(C.dim(`  [${c.name} ✗] ${r.error}`));
          }
        }
      }

      // Render assistant text (the entity's voice).
      if (msg.text && msg.text.trim().length > 0) {
        console.log("");
        console.log(C.amber("  THE LANTERN-BEARER"));
        for (const line of msg.text.split("\n")) {
          console.log(C.ital("  " + line));
        }
        console.log("");
      }

      if (step.done) break;
      if (departed) break;
    }
  }

  // After the visit, gentle mood update (a visit completed without rupture is itself trust-positive).
  const e = engine.entities.lantern_bearer!;
  e.mood = Math.max(-100, Math.min(100, e.mood + 4));
}

// ===========================================================================
// MAIN LOOP

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function help(): void {
  console.log("");
  console.log(C.dim("  commands:"));
  console.log(C.dim("    status         show the seeker's state"));
  console.log(C.dim("    light          light a candle (a component for ritual)"));
  console.log(C.dim("    cast lantern   invocation of the Lantern-Bearer"));
  console.log(C.dim("    journal        recent events"));
  console.log(C.dim("    quit           end the session"));
  console.log("");
}

async function main(): Promise<void> {
  const engine = initialEngine();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log(C.bold("  ARCANA"));
  console.log(C.dim("  v1 — the Lantern-Bearer"));
  console.log("");
  console.log(C.dim("  type 'help' for commands."));

  try {
    while (true) {
      const input = (await rl.question(C.cyan("\n  ") + "» ")).trim().toLowerCase();
      if (input === "" || input === "help") { help(); continue; }
      if (input === "quit" || input === "exit") break;
      if (input === "status") { renderStatus(engine); continue; }
      if (input === "light") {
        engine.candles_lit += 1;
        console.log(C.dim(`  a candle is lit. (${engine.candles_lit} burning)`));
        continue;
      }
      if (input === "journal") {
        if (engine.log.length === 0) console.log(C.dim("  (the journal is empty.)"));
        else for (const e of engine.log.slice(-10)) console.log(C.dim("  " + e));
        continue;
      }
      if (input === "cast lantern" || input === "cast") {
        await summonLanternBearer(engine, rl);
        continue;
      }
      console.log(C.dim("  (the seeker hesitates. that is not a known practice.)"));
    }
  } finally {
    rl.close();
    console.log(C.dim("\n  the lantern is laid down. the night holds.\n"));
  }
}

await main();
