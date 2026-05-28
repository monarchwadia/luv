// economy-sim — headless driver.
//
// Runs a full match with *scripted* strategists (no LLM, no UI) so the
// economics can be verified directly. Run it with:
//
//   bun run.js            (from examples/economy-sim/)
//
// This is the baseline the agent harness + dashboard will later plug into:
// swap the scripted strategists for LLM-backed ones, keep everything else.

import { defaultConfig, round2 } from "./sim.js";
import { runGame } from "./game.js";
import { PRESETS } from "./strategy.js";

// Assign a mix of scripted behaviors across each tier so the market has
// something to resolve: a conservative pricer, a greedy pricer, and an
// adaptive undercutter.
function buildStrategists(config) {
  const behaviors = ["conservative", "greedy", "adaptive"];
  const strategists = {};
  config.chain.forEach((_, tier) => {
    for (let i = 0; i < config.firms_per_tier; i++) {
      const id = `f${tier}_${i}`;
      const name = behaviors[i % behaviors.length];
      strategists[id] = (report) => PRESETS[name](report);
    }
  });
  return strategists;
}

function fmt(n, w = 8) {
  return String(n).padStart(w);
}

async function main() {
  const config = defaultConfig({
    seed: 42,
    firms_per_tier: 3,
    total_ticks: 120,
    ticks_per_replan: 10,
  });

  const strategists = buildStrategists(config);

  console.log("=== economy-sim headless run ===");
  console.log(
    `chain: ${config.chain.map((c) => c.good).join(" -> ")} | ` +
      `${config.firms_per_tier} firms/tier | ${config.total_ticks} ticks | ` +
      `replan every ${config.ticks_per_replan} | seed ${config.seed}\n`,
  );

  const { world, scores } = await runGame({
    config,
    strategists,
    onTickBatch: (w) => {
      const m = w.markets;
      console.log(
        `tick ${fmt(w.tick, 3)} | ` +
          `prices raw=${fmt(round2(m.raw.last_price), 6)} ` +
          `part=${fmt(round2(m.part.last_price), 6)} ` +
          `product=${fmt(round2(m.product.last_price), 6)} | ` +
          `product vol=${fmt(m.product.last_volume, 4)} | ` +
          `alive=${w.firms.filter((f) => f.alive).length}/${w.firms.length}`,
      );
    },
  });

  console.log("\n=== final leaderboard (by net worth) ===");
  for (const s of scores) {
    console.log(
      `${s.net_worth >= 0 ? " " : ""}${fmt(s.net_worth, 9)}  ` +
        `${s.alive ? "  " : "X "}${s.id} (tier ${s.tier})  cash=${fmt(s.cash, 8)}`,
    );
  }

  runChecks(world, scores);
}

function runChecks(world, scores) {
  const problems = [];

  for (const s of scores) {
    if (!Number.isFinite(s.net_worth) || !Number.isFinite(s.cash)) {
      problems.push(`non-finite score for ${s.id}`);
    }
  }
  if (!world.firms.some((f) => f.alive)) {
    problems.push("every firm went bankrupt — economy collapsed");
  }
  const tradedProduct = world.history.some((h) => h.product_volume > 0);
  if (!tradedProduct) problems.push("product never traded — demand never met supply");

  // Soft check: value should rise up the chain (raw <= part <= product).
  const m = world.markets;
  const valueAddsUp =
    m.raw.last_price <= m.part.last_price + 1e-9 &&
    m.part.last_price <= m.product.last_price + 1e-9;

  console.log("\n=== checks ===");
  console.log(`product traded:        ${tradedProduct ? "yes" : "NO"}`);
  console.log(`firms alive at end:    ${world.firms.filter((f) => f.alive).length}`);
  console.log(`value rises up chain:  ${valueAddsUp ? "yes" : "no (worth a look)"}`);

  if (problems.length) {
    console.log("\nFAILED:");
    for (const p of problems) console.log(` - ${p}`);
    process.exit(1);
  }
  console.log("\nOK");
}

main();
