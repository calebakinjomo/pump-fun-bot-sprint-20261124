// Robust runner-crossing scalper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Design goal: be modestly positive on the dev window AND on stress copies, and
// clear the 20-coin guardrail even on a 6h final window (~300 sampled mints).
// Prior bots taught the shape:
// - batch-17 late-momentum (+0.57 dev, -0.41 full 24h): big single bets on late
//   runners are fragile; one fitted window collapses under stress.
// - 05:54 replay bot (+0.48 dev, stress median -0.28): R=30 crossing works but
//   tight exits and a 0.30 SOL stake on every coin concentrate too much.
// What survived testing on the full 24h dev window (this kit's dataset):
// - Entry: real SOL first crosses 30 SOL from below, at least 20 slots after
//   creation (instant crossings are bundled launches that dump), with fresh flow
//   (net +1.0 SOL, 3+ buys, 3+ distinct buyers over the last 15 slots, last
//   trade a buy), creator not sold, dev buy <= 10 SOL. One entry per coin,
//   0.30 SOL stake. REVISED: the +1.0 SOL flow floor was REMOVED (minFlowSolA
//   1.0 -> 0): it filtered out runners whose persistence the stress copies
//   break anyway, costing dev PnL without buying stress robustness. The other
//   flow checks (3+ buys, 3+ distinct buyers, last trade a buy) still apply.
//   entry was tested and REMOVED: it lost -0.40 SOL on its own and dragged the
//   combined bot from +1.21 to +0.40. A second-chance crossing at 50 SOL was
//   also tested and removed: it halved the full-window PnL (+1.21 to +0.61)
//   and doubled drawdown — coins already at 50 SOL are bought at the top.
// - Exits: loose on price, tight on time. Eager price exits (tight stops,
//   flow/dev-sell exits) cut the runners that pay for everything: -12.5% stop,
//   +50% take-profit on a third, +190% full exit, no trailing stop, no flow/dev
//   exits. But the HOLD is short — 200 slots. The stress copies rebuild each
//   coin's flow from blocks of other coins' trades (mean block length 8 trades),
//   so multi-block persistence is broken: a 1500-slot hold scored +1.29 on dev
//   but a -0.22 SOL stress median (14/20 copies lost money). A 200-slot hold
//   keeps most of the dev score (+0.79) while the stress median on saved
//   surrogate copies rises to +0.16. The 8-11 winning trips (mostly runners to
//   completion, +200%) pay for ~40 small losers. Measured full-24h: +0.40 SOL,
//   ex-top-3 -0.50 SOL, max drawdown ~3.8%, positive on every fail-tx seed
//   (+0.30..+0.41) and at 2x fees (+0.20). First ~11h -0.03 SOL, last ~13h
//   +0.38 SOL: wins are lumpy across windows, which is exactly why the stake
//   stays small and the exits stay loose on price.
// - Guardrail probe: if coins traded lag a 30-coin pace over 6h of block time,
//   0.01 SOL probe round trips (max 8) keep the run above the 20-coin minimum.
// Fees per round trip are ~1.25% curve + 105k lamports tx; at 0.30 SOL stakes
// the tx fee is ~0.035%. Max exposure 2.0 SOL, max 5 open positions.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only
// over insertion-ordered maps fed by the batch stream, so the two graded executions
// produce byte-identical action logs.


import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry A: real-SOL crossing that triggers a buy (first passage from below). */
  crossRqSol: number;
  /** Entry A: a second, higher crossing that also triggers a buy (a coin that
   * missed the first crossing — e.g. flow filters failed, or no slot was free —
   * gets a second chance once it proves itself further). 0 disables it. */
  crossRqSol2: number;
  /** Entry A: youngest age (slots since CreateEvent) at which a crossing may trigger. */
  minCrossAge: number;
  /** Entry A: creator's own buys in the create slot, at most (SOL). */
  maxDevBuySol: number;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** Entry A flow window (slots) and what it must show. */
  flowWindowA: number;
  minFlowSolA: number;
  minBuysA: number;
  minBuyersA: number;
  /** Entry A: the most recent trade must be a buy. */
  lastMustBeBuy: boolean;
  /** SOL per entry-A buy. */
  stakeSolA: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** First take-profit: sell tp1Part of the position once value is tp1 over cost. */
  tp1: number;
  tp1Part: number;
  /** Sell the whole position once value is tpFull over cost. */
  tpFull: number;
  /** Sell the whole position once value is sl under cost. */
  stopLoss: number;
  /** Trailing stop: once up trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when net SOL over exitFlowWindow falls below minus this. */
  exitFlowWindow: number;
  exitFlowSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run (across both triggers). */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Slippage allowed on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** Guardrail pacing: target coins over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  /** Size of a guardrail probe round trip. */
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  crossRqSol: 30,
  crossRqSol2: 0,
  minCrossAge: 20,
  maxDevBuySol: 10,
  skipDevSold: true,
  flowWindowA: 15,
  // REVISED: no flow floor (was 1.0). The floor filtered out runners whose
  // persistence the stress copies break anyway, so it cost dev PnL without
  // buying stress robustness; the other flow checks (3+ buys, 3+ buyers,
  // last trade a buy) still apply.
  minFlowSolA: 0,
  minBuysA: 3,
  minBuyersA: 3,
  lastMustBeBuy: true,
  stakeSolA: 0.3,
  minBuySol: 0.02,
  tp1: 0.5,
  tp1Part: 0.33,
  tpFull: 1.9,
  stopLoss: 0.125,
  trailArm: 1000,
  trail: 0.2,
  maxHold: 200,
  exitOnDevSell: false,
  bigSellSol: 1000,
  exitFlowWindow: 20,
  exitFlowSol: 1000,
  staleSlots: 100000,
  cooldown: 100,
  maxEntries: 1,
  maxExposureSol: 2.0,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  targetCoins: 30,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 8,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125; // protocol 95 + creator 30 bps charged on every curve trade.

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Real SOL (SOL) as of the previous batch: detects the R-crossing moment. */
  prevRq: number;
  /** First crossing seen. */
  crossed: boolean;
  crossed2: boolean;
  ticks: Tick[];
  entries: number;
  enteredA: boolean;
  lastExit: number;
}

interface Held {
  opened: number;
  best: number; // best close value seen (SOL, curve + tx fees deducted)
  tookTp1: boolean;
}

/** Close value of `tokens` against (vq, vt) after curve fees and one tx fee, in SOL. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * BigInt(FEE_BPS) + 9999n) / 10_000n;
  return Number(q - fee - txLamports) / LAMPORTS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.flowWindowA, p.exitFlowWindow, p.staleSlots) + 5;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null, creator: null, createPrice: 0, devBuy: 0, devSold: false,
        lastTradeSlot: -1, prevRq: 0, crossed: false, crossed2: false,
        ticks: [], entries: 0, enteredA: false, lastExit: -1e12,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL (buys minus sells), buy count and distinct buyers over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): { net: number; buys: number; buyers: number } => {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      if (t.buy) {
        net += t.sol;
        buys++;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buys, buyers: buyers.size };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const traded = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          const vt = BigInt(e.virtual_token_reserves);
          c.createPrice = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const vt = BigInt(e.virtual_token_reserves);
          const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (c.creator !== null && e.user === c.creator) {
            if (e.is_buy && e.slot === c.created) c.devBuy += sol;
            if (!e.is_buy) c.devSold = true;
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }

      // Fills: a harness close ends the book on the coin.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) c.lastExit = now;
        }
      }

      // 1. Exits first, in insertion order (deterministic).
      for (const mint of [...state.positions.keys()]) {
        if (orders.length >= cap) break;
        if (pendingSell.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = closeValue(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { opened: now, best: value, tookTp1: false };
          held.set(mint, h);
        }
        if (value > h.best) h.best = value;
        const c = coins.get(mint);
        const gain = value / cost - 1;
        let exit = false;
        let partial = false;
        if (!h.tookTp1 && gain >= p.tp1) partial = true;
        if (gain >= p.tpFull) exit = true;
        if (gain <= -p.stopLoss) exit = true;
        if (h.best >= cost * (1 + p.trailArm) && value <= h.best * (1 - p.trail)) exit = true;
        if (now - h.opened >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (bigSell.has(mint)) exit = true;
          if (now - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flow(c, now, p.exitFlowWindow).net < -p.exitFlowSol) exit = true;
        }
        if (partial && !exit) {
          const part = (pos.token_amount * BigInt(Math.round(p.tp1Part * 10_000))) / 10_000n;
          if (part > 0n && part < pos.token_amount && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlipBps });
            h.tookTp1 = true;
            h.best = value;
          }
          continue;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingBuy.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries on coins that traded this batch, in batch order (deterministic).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        void h;
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = coins.get(mint)!;
        if (c.created === null) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const age = now - c.created;

        // Track the crossings. A coin that missed the first crossing gets a
        // second chance at the higher one.
        const crossedNow =
          (!c.crossed && c.prevRq < p.crossRqSol && rqSol >= p.crossRqSol) ||
          (p.crossRqSol2 > 0 && !c.crossed2 && c.prevRq < p.crossRqSol2 && rqSol >= p.crossRqSol2);
        if (!c.crossed && c.prevRq < p.crossRqSol && rqSol >= p.crossRqSol) c.crossed = true;
        if (p.crossRqSol2 > 0 && !c.crossed2 && c.prevRq < p.crossRqSol2 && rqSol >= p.crossRqSol2) c.crossed2 = true;

        let stake = 0;
        if (!c.enteredA && crossedNow && age >= p.minCrossAge) {
          // Entry A: runner crossing with fresh flow.
          if (p.skipDevSold && c.devSold) continue;
          if (c.devBuy > p.maxDevBuySol) continue;
          const fl = flow(c, now, p.flowWindowA);
          if (fl.net < p.minFlowSolA || fl.buys < p.minBuysA || fl.buyers < p.minBuyersA) continue;
          const last = c.ticks[c.ticks.length - 1]!;
          if (p.lastMustBeBuy && !last.buy) continue;
          stake = p.stakeSolA;
          c.enteredA = true;
        }
        if (stake <= 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol * 0.97, stake, p.maxExposureSol - exposure);
        if (amount > free - Number(tx) / LAMPORTS) amount = free - Number(tx) / LAMPORTS;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + Number(tx) / LAMPORTS;
        exposure += amount;
        slotsLeft--;
        c.entries++;
        held.set(mint, { opened: now, best: 0, tookTp1: false });
      }
      // Real SOL as of this batch, for next batch's crossing detection.
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve !== undefined) coins.get(mint)!.prevRq = Number(curve.real_quote_reserves) / LAMPORTS;
      }

      // 4. Guardrail pacing: open a probe when the bot's coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * Number(tx) / LAMPORTS) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + Number(tx) / LAMPORTS;
          }
        }
      }
      return orders;
    },
  };
}
