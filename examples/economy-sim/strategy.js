// economy-sim — firm strategy: schema, the deterministic evaluator the
// kernel runs every tick, and scripted presets for headless runs.
//
// A "strategy" is a small declarative policy. The kernel calls
// planFirmOrders(firm, world) every tick to turn the firm's current
// strategy + state into concrete orders for that tick — no external/LLM
// call. Agents (later) only choose the strategy; the kernel executes it
// over many fast ticks. That decoupling is what keeps long sims cheap.

import { unitCost } from "./sim.js";

// ---------- Schema ----------

// strategy = {
//   pricing: "cost_plus" | "match_market" | "undercut",
//   markup_pct: number,        // for cost_plus: sell at cost*(1+markup/100)
//   undercut_pct: number,      // for undercut: sell undercut_pct below market (floored at cost)
//   produce_to_stock: number,  // target output inventory; produce toward it (capped by capacity & inputs)
//   input_buy_to_stock: number,// target input inventory; buy toward it (non-raw tiers)
//   max_input_price: number,   // never pay more than this per input unit
// }

export function defaultStrategy() {
  return {
    pricing: "cost_plus",
    markup_pct: 20,
    undercut_pct: 5,
    produce_to_stock: 30,
    input_buy_to_stock: 40,
    max_input_price: 999,
  };
}

// Fill in any missing fields so a partial strategy (e.g. from an LLM) is
// always safe to evaluate.
export function normalizeStrategy(s) {
  const d = defaultStrategy();
  if (!s || typeof s !== "object") return d;
  const pricing = ["cost_plus", "match_market", "undercut"].includes(s.pricing)
    ? s.pricing
    : d.pricing;
  return {
    pricing,
    markup_pct: num(s.markup_pct, d.markup_pct),
    undercut_pct: num(s.undercut_pct, d.undercut_pct),
    produce_to_stock: Math.max(0, num(s.produce_to_stock, d.produce_to_stock)),
    input_buy_to_stock: Math.max(0, num(s.input_buy_to_stock, d.input_buy_to_stock)),
    max_input_price: Math.max(0, num(s.max_input_price, d.max_input_price)),
  };
}

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ---------- Evaluator ----------

// Turn a firm's standing strategy + current state into this tick's orders.
// Returns { sell_price, produce_target, buy_qty, max_buy_price }.
export function planFirmOrders(firm, world) {
  const s = normalizeStrategy(firm.strategy);
  const cost = unitCost(firm, world);
  const marketPrice = world.markets[firm.good].last_price;

  // Pricing.
  let sellPrice;
  if (s.pricing === "match_market") {
    sellPrice = marketPrice > 0 ? marketPrice : cost * 1.1;
  } else if (s.pricing === "undercut") {
    const ref = marketPrice > 0 ? marketPrice : cost * 1.1;
    sellPrice = Math.max(cost, ref * (1 - s.undercut_pct / 100));
  } else {
    sellPrice = cost * (1 + s.markup_pct / 100);
  }
  // Never knowingly sell below cost.
  sellPrice = Math.max(sellPrice, cost > 0 ? cost : 0.01);

  // Production target: refill output inventory toward the target.
  const produceTarget = Math.max(0, s.produce_to_stock - firm.output_stock);

  // Input purchasing (raw tier buys nothing).
  let buyQty = 0;
  let maxBuyPrice = 0;
  if (firm.input_good !== null) {
    buyQty = Math.max(0, s.input_buy_to_stock - firm.input_stock);
    maxBuyPrice = s.max_input_price;
  }

  return {
    sell_price: round4(sellPrice),
    produce_target: produceTarget,
    buy_qty: buyQty,
    max_buy_price: maxBuyPrice,
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// ---------- Scripted strategy presets (for headless / baseline play) ----------

// Each preset is a function (firm, world, rng) => strategy, so a scripted
// "player" can react to its report. Most ignore the args and return a
// fixed policy; `adaptiveUndercutter` reacts to the market price.

export const PRESETS = {
  conservative: () => ({
    pricing: "cost_plus",
    markup_pct: 15,
    produce_to_stock: 25,
    input_buy_to_stock: 35,
    max_input_price: 999,
  }),

  greedy: () => ({
    pricing: "cost_plus",
    markup_pct: 45,
    produce_to_stock: 35,
    input_buy_to_stock: 45,
    max_input_price: 999,
  }),

  undercutter: () => ({
    pricing: "undercut",
    undercut_pct: 8,
    produce_to_stock: 40,
    input_buy_to_stock: 55,
    max_input_price: 999,
  }),

  matcher: () => ({
    pricing: "match_market",
    produce_to_stock: 30,
    input_buy_to_stock: 40,
    max_input_price: 999,
  }),

  // Reacts to its report: ramp production if last round was profitable,
  // pull back if it lost money.
  adaptive: (report) => {
    const profit = report?.recent_profit ?? 0;
    const base = 30;
    const produce = profit >= 0 ? base + 10 : Math.max(10, base - 10);
    return {
      pricing: profit >= 0 ? "cost_plus" : "undercut",
      markup_pct: 25,
      undercut_pct: 10,
      produce_to_stock: produce,
      input_buy_to_stock: produce + 15,
      max_input_price: 999,
    };
  },
};
