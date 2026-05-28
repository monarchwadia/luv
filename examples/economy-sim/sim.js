// economy-sim — pure simulation kernel.
//
// A tick-based supply-chain economy. A linear chain of goods is produced
// tier by tier (raw -> part -> product) by competing firms; the final
// product is sold into an exogenous, downward-sloping demand curve.
//
// Everything here is pure and deterministic given a seed: tick(world)
// mutates the world in place but introduces no randomness beyond the
// seeded PRNG carried on the world. That makes a run exactly replayable
// from (config + the sequence of strategies the firms held).
//
// The kernel knows nothing about LLMs. Firms act through a "strategy"
// (a small declarative policy, see strategy.js) that the kernel evaluates
// every tick with no external calls. Agents only set strategies; the
// kernel executes them.

import { planFirmOrders } from "./strategy.js";

// ---------- Seeded PRNG (mulberry32) ----------

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Config ----------

// The config object is the whole "knob panel" for the simulation. v1
// fixes the chain at three tiers; widening it is a config change, not an
// engine rewrite.
export function defaultConfig(overrides = {}) {
  const base = {
    seed: 12345,

    // The production chain, upstream -> downstream. Each tier's firms
    // consume `input` (none for the raw tier) and produce `good`.
    chain: [
      { good: "raw", input: null, input_per_output: 0 },
      { good: "part", input: "raw", input_per_output: 1 },
      { good: "product", input: "part", input_per_output: 1 },
    ],

    firms_per_tier: 3,

    // Starting endowments (per firm).
    start_cash: 1000,
    start_input_stock: 10,
    start_output_stock: 0,
    capacity: 20, // max units a firm can produce per tick

    // Costs.
    raw_unit_cost: 2, // extraction cost for the raw tier (per unit)
    convert_cost: 0, // extra per-unit production cost for non-raw tiers
    fixed_cost: 5, // per firm, per tick
    holding_cost_per_unit: 0.05, // per unit of stock held at tick end

    // Exogenous final demand for the product: qty = max(0, intercept - slope*price).
    demand_intercept: 60,
    demand_slope: 2,
    demand_shock_std: 5, // uniform +/- shock applied to the intercept each tick

    // Bankruptcy: a firm knocked out after this many consecutive negative-cash ticks.
    bankruptcy_grace: 3,

    // Match cadence (used by game.js, kept here so a run is fully described
    // by its config).
    ticks_per_replan: 10,
    total_ticks: 100,
  };
  return { ...base, ...overrides };
}

// ---------- World construction ----------

export function createWorld(config) {
  const firms = [];
  let n = 0;
  config.chain.forEach((tierDef, tier) => {
    for (let i = 0; i < config.firms_per_tier; i++) {
      firms.push({
        id: `f${tier}_${i}`,
        name: `${tierDef.good}-firm-${i}`,
        tier,
        good: tierDef.good,
        input_good: tierDef.input,
        input_per_output: tierDef.input_per_output,
        cash: config.start_cash,
        input_stock: tierDef.input ? config.start_input_stock : 0,
        output_stock: config.start_output_stock,
        capacity: config.capacity,
        strategy: null, // set by the game-master before the first tick
        alive: true,
        negative_ticks: 0,
        // bookkeeping refreshed each tick (for reports)
        last_production: 0,
        last_sales_qty: 0,
        last_sales_revenue: 0,
        last_input_bought: 0,
        last_input_cost: 0,
        last_profit: 0,
        profit_history: [],
      });
      n++;
    }
  });

  const markets = {};
  for (const tierDef of config.chain) {
    markets[tierDef.good] = { last_price: 0, last_volume: 0 };
  }
  markets[config.chain[config.chain.length - 1].good].last_demand = 0;

  return {
    tick: 0,
    config,
    firms,
    markets,
    _rng: makeRng(config.seed),
    history: [],
  };
}

// ---------- Helpers ----------

function aliveFirmsInTier(world, tier) {
  return world.firms.filter((f) => f.alive && f.tier === tier);
}

// Estimate a firm's per-unit production cost — used by pricing rules.
export function unitCost(firm, world) {
  if (firm.input_good === null) return world.config.raw_unit_cost;
  const inputPrice = world.markets[firm.input_good].last_price || world.config.raw_unit_cost;
  return inputPrice * firm.input_per_output + world.config.convert_cost;
}

// Final-demand quantity at a given price (this tick's shocked curve).
function demandAt(price, intercept, config) {
  return Math.max(0, intercept - config.demand_slope * price);
}

// ---------- Market clearing ----------

// Posted-offer clearing for an intermediate good: sellers post (price,
// qty); buyers (next tier) buy cheapest-first up to their target qty,
// their max price, and their cash. Deterministic: offers sorted by price
// then id, buyers served by willingness-to-pay then id.
function clearIntermediateMarket(world, good, sellers, buyers) {
  const offers = sellers
    .map((f) => ({ firm: f, price: f._plan.sell_price, qty: f.output_stock }))
    .filter((o) => o.qty > 0 && o.price > 0)
    .sort((a, b) => a.price - b.price || a.firm.id.localeCompare(b.firm.id));

  const bids = buyers
    .map((f) => ({
      firm: f,
      remaining: f._plan.buy_qty,
      max_price: f._plan.max_buy_price,
    }))
    .filter((b) => b.remaining > 0)
    .sort((a, b) => b.max_price - a.max_price || a.firm.id.localeCompare(b.firm.id));

  let volume = 0;
  let revenue = 0;

  for (const offer of offers) {
    if (offer.qty <= 0) continue;
    for (const bid of bids) {
      if (offer.qty <= 0) break;
      if (bid.remaining <= 0) continue;
      if (bid.max_price < offer.price) continue;
      const affordable = Math.floor(bid.firm.cash / offer.price);
      const qty = Math.min(offer.qty, bid.remaining, affordable);
      if (qty <= 0) continue;
      const cost = qty * offer.price;

      bid.firm.cash -= cost;
      bid.firm.input_stock += qty;
      bid.firm.last_input_bought += qty;
      bid.firm.last_input_cost += cost;

      offer.firm.cash += cost;
      offer.firm.output_stock -= qty;
      offer.firm.last_sales_qty += qty;
      offer.firm.last_sales_revenue += cost;

      offer.qty -= qty;
      bid.remaining -= qty;
      volume += qty;
      revenue += cost;
    }
  }

  world.markets[good].last_volume = volume;
  if (volume > 0) world.markets[good].last_price = revenue / volume;
}

// Final-demand clearing for the product: cheapest offers sell first, each
// limited by how much the demand curve wants at that offer's price.
function clearProductMarket(world, good, sellers) {
  const config = world.config;
  const shock = (world._rng() * 2 - 1) * config.demand_shock_std;
  const intercept = config.demand_intercept + shock;

  const offers = sellers
    .map((f) => ({ firm: f, price: f._plan.sell_price, qty: f.output_stock }))
    .filter((o) => o.qty > 0 && o.price > 0)
    .sort((a, b) => a.price - b.price || a.firm.id.localeCompare(b.firm.id));

  let cumulative = 0;
  let volume = 0;
  let revenue = 0;

  for (const offer of offers) {
    const wanted = demandAt(offer.price, intercept, config);
    const available = Math.max(0, wanted - cumulative);
    const qty = Math.min(offer.qty, Math.floor(available));
    if (qty > 0) {
      const proceeds = qty * offer.price;
      offer.firm.cash += proceeds;
      offer.firm.output_stock -= qty;
      offer.firm.last_sales_qty += qty;
      offer.firm.last_sales_revenue += proceeds;
      cumulative += qty;
      volume += qty;
      revenue += proceeds;
    }
  }

  world.markets[good].last_volume = volume;
  world.markets[good].last_demand = Math.max(0, intercept);
  if (volume > 0) world.markets[good].last_price = revenue / volume;
}

// ---------- The tick ----------

// One simulation step. Sequence: plan -> produce (from existing input
// stock) -> clear markets downstream-to-upstream -> costs -> bankruptcy.
// Producing from existing stock (rather than goods bought this same tick)
// avoids a within-tick ordering dependency between buying and producing.
export function tick(world) {
  const config = world.config;
  const alive = world.firms.filter((f) => f.alive);

  // Snapshot cash to compute per-firm profit at the end.
  for (const f of alive) f._cash_before = f.cash;

  // 1. Plan + reset per-tick bookkeeping.
  for (const f of alive) {
    f.last_production = 0;
    f.last_sales_qty = 0;
    f.last_sales_revenue = 0;
    f.last_input_bought = 0;
    f.last_input_cost = 0;
    f._plan = planFirmOrders(f, world);
  }

  // 2. Production (consume input stock; raw tier pays extraction cost).
  for (const f of alive) {
    let produce = Math.min(f._plan.produce_target, f.capacity);
    if (f.input_good !== null) {
      const maxFromInput = Math.floor(f.input_stock / f.input_per_output);
      produce = Math.min(produce, maxFromInput);
    }
    produce = Math.max(0, produce);
    if (produce > 0) {
      if (f.input_good === null) {
        f.cash -= produce * config.raw_unit_cost;
      } else {
        f.input_stock -= produce * f.input_per_output;
        f.cash -= produce * config.convert_cost;
      }
      f.output_stock += produce;
      f.last_production = produce;
    }
  }

  // 3. Market clearing, downstream product first then upstream goods.
  for (let tier = config.chain.length - 1; tier >= 0; tier--) {
    const good = config.chain[tier].good;
    const sellers = aliveFirmsInTier(world, tier);
    if (tier === config.chain.length - 1) {
      clearProductMarket(world, good, sellers);
    } else {
      const buyers = aliveFirmsInTier(world, tier + 1);
      clearIntermediateMarket(world, good, sellers, buyers);
    }
  }

  // 4. Operating costs.
  for (const f of alive) {
    const holding = (f.input_stock + f.output_stock) * config.holding_cost_per_unit;
    f.cash -= config.fixed_cost + holding;
  }

  // 5. Bankruptcy + profit bookkeeping.
  for (const f of alive) {
    f.last_profit = f.cash - f._cash_before;
    f.profit_history.push(f.last_profit);
    if (f.cash < 0) {
      f.negative_ticks += 1;
      if (f.negative_ticks > config.bankruptcy_grace) {
        f.alive = false;
        f.input_stock = 0;
        f.output_stock = 0;
      }
    } else {
      f.negative_ticks = 0;
    }
  }

  world.tick += 1;
  world.history.push(snapshot(world));
}

// ---------- Scoring ----------

// Net worth = cash + inventory valued at last market prices. Inventory of
// a knocked-out firm is already zeroed.
export function netWorth(firm, world) {
  const outPrice = world.markets[firm.good].last_price || 0;
  const inPrice = firm.input_good ? world.markets[firm.input_good].last_price || 0 : 0;
  return firm.cash + firm.output_stock * outPrice + firm.input_stock * inPrice;
}

export function leaderboard(world) {
  return world.firms
    .map((f) => ({
      id: f.id,
      name: f.name,
      tier: f.tier,
      alive: f.alive,
      cash: round2(f.cash),
      net_worth: round2(netWorth(f, world)),
    }))
    .sort((a, b) => b.net_worth - a.net_worth);
}

// ---------- Snapshots / utilities ----------

function snapshot(world) {
  const prices = {};
  for (const good of Object.keys(world.markets)) {
    prices[good] = round2(world.markets[good].last_price);
  }
  return {
    tick: world.tick,
    prices,
    product_volume: world.markets[world.config.chain[world.config.chain.length - 1].good].last_volume,
    firms: world.firms.map((f) => ({
      id: f.id,
      cash: round2(f.cash),
      out: f.output_stock,
      in: f.input_stock,
      alive: f.alive,
    })),
  };
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}
