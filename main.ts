// Fresh-launch sniper for the pump.fun replay sprint.
//
// Idea: on pump.fun almost every coin dies, but a few gap up hard in their
// first minutes. So we buy launches, not dips: a coin is bought only in its
// first few slots, only if the launch looks honest — the creator did not
// pre-buy a big stack (at most 0.5 SOL), a handful of other wallets piled in
// (1-4), the creator has not sold, nobody has dumped a big chunk yet, and the
// price has already ticked up 10-20% from creation (early momentum, not a
// coin already cratering or already pumped). Stake is small and fixed
// (0.10 SOL, capped at 1% of the curve's real reserve) so one rug costs
// little; exits are fast (take profit at +25%, tight -6% stop, 20-slot max
// hold, instant exit if the creator sells) and a trailing stop (+12% arm,
// 4% drop) lets a gap-up run instead of clipping it.
//
// One buy per coin, one sell. Few trades, high conviction per coin, across
// many coins so the 20-coin bar is cleared with room to spare.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, so the two graded executions produce
// byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const BPS = 10_000n;
// Curve fees charged on a sell: protocol 95 bps + creator 30 bps (fallbacks).
const SELL_FEE_BPS = 125n;

// --- Entry: the launch must be young and look honest ---
const MAX_AGE_SLOTS = 4; // buy only within the first 4 slots after creation
const STAKE = 100_000_000n; // 0.10 SOL per coin
const MIN_BUY = 5_000_000n; // 0.005 SOL: below this the tx fee eats the trade
const MIN_REAL_SOL = 300_000_000n; // 0.30 SOL of real SOL at decision time
const MAX_REAL_SOL = 30n * SOL; // ...and at most 30 SOL (already too big to gap)
const MAX_DEV_BUY = 500_000_000n; // creator's own buys in the create slot, at most 0.5 SOL
const MIN_BUYERS = 1; // distinct non-creator buyers seen before entry
const MAX_BUYERS = 4; // ...at most this many (a bundled launch is a dump waiting)
const MAX_BIG_SELL_BPS = 5000n; // largest single non-creator sell, vs reserve
const MAX_RUNUP_BPS = 2000; // price vs create price: at most +20% already
const MIN_RUNUP_BPS = 1000; // ...and at least +10% (early momentum, not cratering)
const MAX_ENTRIES_PER_BATCH = 2;

// --- Exits ---
// The staged half-take is disabled (TAKE_HALF unreachable): on this data
// clipping winners at +8% cost more than it saved, so positions run whole
// to the full take-profit or the trailing stop instead.
const TAKE_HALF = 10.0; // sell half the position at +10x on cost (disabled)
const TAKE_REST = 0.25; // sell the rest at +25% on cost
const STOP_LOSS = 0.06; // stop the whole position at -6% on cost
const TRAIL_ARM = 0.12; // once the position is up 12%...
const TRAIL_DROP = 0.04; // ...exit on a 4% fall from its best value
const MAX_HOLD_SLOTS = 20; // never hold past 20 slots
const STALE_SLOTS = 60; // exit if no trade has hit the coin for this long
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  lastTradeSlot: number;
  done: boolean;
}

interface Held {
  openedSlot: number;
  bestValue: bigint;
  halfTaken: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();

/** What selling `tokens` would pay, curve fees deducted, at the marked reserves. */
function liquidationValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined || tokens <= 0n) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * SELL_FEE_BPS + BPS - 1n) / BPS;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const slot = batch.slot;

  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        devSold: false,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        lastTradeSlot: e.slot,
        done: false,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.lastTradeSlot = e.slot;
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
        const rqBefore = BigInt(e.real_quote_reserves) + sol;
        if (rqBefore > 0n) {
          const bps = (sol * BPS) / rqBefore;
          if (bps > c.bigSellBps) c.bigSellBps = bps;
        }
      }
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c !== undefined) c.done = true;
    }
  }

  // Track fills: record new positions, forget closed ones.
  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
      held.set(f.mint, { openedSlot: f.slot, bestValue: 0n, halfTaken: false });
    }
    if (f.side === 'sell' && !state.positions.has(f.mint)) {
      held.delete(f.mint);
      const c = coins.get(f.mint);
      if (c !== undefined) c.done = true;
    }
  }
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }

  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const txFee = state.txFeeLamports();
  const marks = new Map<Pubkey, Mark>();
  for (const m of batch.marks) marks.set(m.mint, m);
  const pendingMints = new Set<Pubkey>();
  for (const o of state.pending.values()) pendingMints.add(o.order.mint);

  // 1. Manage held positions, in mint order (deterministic).
  const heldMints = [...state.positions.keys()].sort();
  for (const mint of heldMints) {
    if (orders.length >= cap) break;
    const h = state.positions.get(mint)!;
    const c = coins.get(mint);
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingMints.has(mint)) continue;
    let rec = held.get(mint);
    if (rec === undefined) {
      rec = { openedSlot: slot, bestValue: 0n, halfTaken: false };
      held.set(mint, rec);
    }
    const value = liquidationValue(marks.get(mint), h.token_amount);
    const cost = h.cost_lamports;
    const gain = cost > 0n ? Number(value - cost) / Number(cost) : 0;
    if (value > rec.bestValue) rec.bestValue = value;
    const bestGain = cost > 0n ? Number(rec.bestValue - cost) / Number(cost) : 0;

    let exitAll = false;
    if (gain <= -STOP_LOSS) exitAll = true;
    if (gain >= TAKE_REST) exitAll = true;
    if (slot - rec.openedSlot >= MAX_HOLD_SLOTS) exitAll = true;
    if (c !== undefined && c.devSold) exitAll = true; // creator sold: get out now
    if (c !== undefined && slot - c.lastTradeSlot >= STALE_SLOTS) exitAll = true;
    if (bestGain >= TRAIL_ARM && gain <= bestGain - TRAIL_DROP) exitAll = true;

    if (exitAll) {
      orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      pendingMints.add(mint);
      continue;
    }
    if (!rec.halfTaken && gain >= TAKE_HALF) {
      const half = h.token_amount / 2n;
      if (half > 0n) {
        orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS });
        rec.halfTaken = true;
        pendingMints.add(mint);
      }
    }
  }

  // 2. New entries: launches only, in first-seen order (deterministic:
  // Map preserves insertion order).
  let entries = 0;
  let open = state.committedPositionCount();
  for (const [mint, c] of coins) {
    if (orders.length >= cap || entries >= MAX_ENTRIES_PER_BATCH) break;
    if (open >= state.hello.caps.max_open_positions) break;
    if (c.done) continue;
    const age = slot - c.createSlot;
    if (age > MAX_AGE_SLOTS) {
      c.done = true;
      continue;
    }
    if (state.positions.has(mint) || pendingMints.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    // Rug filter.
    const rq = BigInt(curve.real_quote_reserves);
    if (rq < MIN_REAL_SOL || rq > MAX_REAL_SOL) continue;
    if (c.devBuy > MAX_DEV_BUY) continue;
    if (c.devSold) {
      c.done = true;
      continue;
    }
    if (c.buyers.size < MIN_BUYERS || c.buyers.size > MAX_BUYERS) continue;
    if (c.bigSellBps > MAX_BIG_SELL_BPS) continue;
    // Not already pumped or cratering since creation.
    const vq = BigInt(curve.virtual_quote_reserves);
    const vt = BigInt(curve.virtual_token_reserves);
    if (vt === 0n || c.vt0 === 0n) continue;
    const runupBps = Number(((vq * c.vt0 - c.vq0 * vt) * BPS) / (c.vq0 * vt));
    if (runupBps > MAX_RUNUP_BPS || runupBps < MIN_RUNUP_BPS) continue;

    let amount = STAKE;
    const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
    if (amount > sizeCap) amount = sizeCap;
    if (amount < MIN_BUY) continue;
    if (state.freeCashLamports() - amount - txFee < 0n) continue;

    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    pendingMints.add(mint);
    entries++;
    open++;
  }
  return orders;
}

await runBot({ onBatch });
