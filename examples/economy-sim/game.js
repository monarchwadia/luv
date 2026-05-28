// economy-sim — the game-master (code, not an LLM).
//
// Runs the match: assign each firm a starting strategy, then alternate
// between running a batch of fast ticks and a "replan" round where every
// firm is given a report and chooses a new strategy. Scoring is net worth
// at the end.
//
// A "strategist" is a function (report) => strategy. In headless runs
// these are scripted (see strategy.js PRESETS). Later, an agent harness
// supplies strategists that call an LLM with the report and parse a
// strategy back out — the game-master itself does not change.

import { createWorld, tick, netWorth, leaderboard, round2 } from "./sim.js";
import { normalizeStrategy } from "./strategy.js";

// Build the partial-information report a firm sees at replan time. This is
// also exactly what an LLM strategist would be shown.
export function buildReport(firm, world) {
  const recent = firm.profit_history.slice(-world.config.ticks_per_replan);
  const recentProfit = recent.reduce((a, b) => a + b, 0);

  // Competitors in the same tier: only their last posted sell price is
  // visible (partial information).
  const rivals = world.firms
    .filter((f) => f.tier === firm.tier && f.id !== firm.id)
    .map((f) => ({
      id: f.id,
      alive: f.alive,
      last_price: f._plan ? round2(f._plan.sell_price) : null,
    }));

  return {
    firm_id: firm.id,
    tier: firm.tier,
    good: firm.good,
    input_good: firm.input_good,
    cash: round2(firm.cash),
    input_stock: firm.input_stock,
    output_stock: firm.output_stock,
    capacity: firm.capacity,
    net_worth: round2(netWorth(firm, world)),
    recent_profit: round2(recentProfit),
    last_production: firm.last_production,
    last_sales_qty: firm.last_sales_qty,
    market_prices: {
      raw: round2(world.markets.raw?.last_price ?? 0),
      part: round2(world.markets.part?.last_price ?? 0),
      product: round2(world.markets.product?.last_price ?? 0),
    },
    product_demand: round2(world.markets.product?.last_demand ?? 0),
    rivals,
  };
}

// strategists: { [firmId]: (report) => strategy }. Firms without an entry
// keep their current strategy (or the default).
export async function runGame({ config, strategists, onReplan, onTickBatch }) {
  const world = createWorld(config);

  // Initial strategies (replan round 0, before any ticks).
  await replanAll(world, strategists, onReplan, 0);

  const rounds = Math.ceil(config.total_ticks / config.ticks_per_replan);
  let ticksRun = 0;
  for (let round = 0; round < rounds; round++) {
    const batch = Math.min(config.ticks_per_replan, config.total_ticks - ticksRun);
    for (let k = 0; k < batch; k++) tick(world);
    ticksRun += batch;
    onTickBatch?.(world, round);

    if (ticksRun < config.total_ticks) {
      await replanAll(world, strategists, onReplan, round + 1);
    }
  }

  return { world, scores: leaderboard(world), history: world.history };
}

async function replanAll(world, strategists, onReplan, round) {
  for (const firm of world.firms) {
    if (!firm.alive) continue;
    const strategist = strategists?.[firm.id];
    if (!strategist) {
      if (!firm.strategy) firm.strategy = normalizeStrategy(null);
      continue;
    }
    const report = buildReport(firm, world);
    const chosen = await strategist(report);
    firm.strategy = normalizeStrategy(chosen);
    onReplan?.(firm, report, round);
  }
}
