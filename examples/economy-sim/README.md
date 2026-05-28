# economy-sim — agents competing in a supply-chain economy

A tick-based economic simulation where firms compete in a production
chain. This directory currently holds the **headless kernel**: the pure
simulation plus scripted players, runnable from the command line. LLM
agents and a dashboard come next and plug into the same kernel.

## The model

A linear supply chain. Each tier has several competing firms:

```
 raw producers ──raw──► parts makers ──parts──► assemblers ──product──► final demand
   (tier 0)             (tier 1)               (tier 2)            (exogenous curve)
```

- Goods flow downstream; money flows upstream.
- Raw producers extract raw at a fixed unit cost. Higher tiers buy their
  input on a market, produce (Leontief: fixed input per output, capped by
  capacity), and sell their output.
- Intermediate goods clear on a **posted-offer** market: sellers post a
  price and quantity; buyers take the cheapest first, up to their target
  quantity, their max price, and their cash.
- The final product sells into a downward-sloping **demand curve**
  (`qty = max(0, intercept − slope·price)`) with a seeded random shock.
- Firms pay a fixed cost and a per-unit holding cost each tick. A firm
  that stays cash-negative past a grace period is knocked out.
- **Score: net worth** (cash + inventory at last market price) at the end.

## Standing strategies (why long runs are cheap)

A firm acts through a **strategy** — a small declarative policy the kernel
evaluates every tick with no external calls:

```json
{ "pricing": "cost_plus", "markup_pct": 25,
  "produce_to_stock": 40,
  "input_buy_to_stock": 60, "max_input_price": 12 }
```

Pricing can be `cost_plus`, `match_market`, or `undercut`. The kernel runs
the policy over many fast ticks; players only re-choose their strategy at
**replan** rounds (every `ticks_per_replan` ticks). So decision cost scales
with `firms × replans`, not with the tick count — a 10,000-tick match costs
the same as a 100-tick one. When LLM agents are added, they are the thing
that picks a new strategy at each replan; nothing else changes.

## Determinism

The whole world is a pure function of `(config + the strategies firms
held)`. All randomness comes from a seeded PRNG carried on the world, so a
run replays exactly. Same seed ⇒ same outcome; change the seed ⇒ a
different market.

## Run it

```sh
cd examples/economy-sim
bun run.js
```

Prints per-replan market prices and volume, a final net-worth leaderboard,
and a few sanity checks. `run.js` assigns scripted behaviors (conservative
/ greedy / adaptive) as a baseline; swapping in LLM-backed strategists is
the next step.

## Files

```
sim.js        pure kernel: config, world, tick(), markets, production, scoring, PRNG
strategy.js   strategy schema, the per-tick evaluator, scripted presets
game.js       code game-master: run K ticks → replan all firms → repeat → score
run.js        headless driver with scripted players + sanity checks
```

## Config — the knob panel

Everything that shapes a run lives in `defaultConfig()` in `sim.js`:
chain definition, firms per tier, starting cash/inventory, capacity,
extraction/convert/fixed/holding costs, demand intercept/slope/shock,
bankruptcy grace, and the replan cadence. v1 fixes the chain at three
tiers; widening or deepening it is a config change, not an engine rewrite.

## Not yet built (deferred)

LLM agent strategists, a browser dashboard, and richer economics (credit,
labor, multiple products, geography, contracts). Each is an addition on
top of the same kernel.
