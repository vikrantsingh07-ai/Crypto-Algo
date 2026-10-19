import type { MarketCandle, PositionLines } from './market/types';
import type { BotState, DemoToday, TradeRow } from './types';

/**
 * Pure helpers behind the simple (default) dashboard view: live profit/loss of the open simulated trade, plain-English
 * texts, today's results and tolerance for an older backend. No React in here so it can be unit tested.
 */

export type Side = 'long' | 'short';

// ---------------------------------------------------------------------------------------------------------------- time

/** India Standard Time, UTC+5:30 (no daylight saving). The operator's "today" is an IST calendar day. */
export const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;

export const istDayStart = (ts: number): number => Math.floor((ts + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
export const istDayLabel = (ts: number): string => new Date(istDayStart(ts) + IST_OFFSET_MS).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------- open trade numbers

/**
 * Price-move profit or loss of an open trade in USD, before any brokerage: (price - entry) x quantity for a long,
 * the opposite for a short. null while there is no usable price.
 */
export function openPnlUsd(side: Side, entry: number, qtyEth: number, price: number | null | undefined): number | null {
  if (price === null || price === undefined || !Number.isFinite(price) || !Number.isFinite(entry) || !Number.isFinite(qtyEth)) return null;
  const dir = side === 'long' ? 1 : -1;
  return dir * (price - entry) * qtyEth;
}

/**
 * The price a trade would be closed at right now: the bid for a long (you sell into it), the ask for a short. Falls back
 * to the last price when the book side is unknown.
 */
export function exitSidePrice(side: Side, m: { bid: number | null; ask: number | null; price: number | null }): number | null {
  const px = side === 'long' ? m.bid : m.ask;
  return px !== null && Number.isFinite(px) && px > 0 ? px : m.price !== null && Number.isFinite(m.price) && m.price > 0 ? m.price : null;
}

export interface TrackPosition {
  /** 0..1 along the bar that runs stop (left) -> entry -> target (right), for a long AND a short */
  stopX: 0;
  entryX: number;
  targetX: 1;
  priceX: number;
  /** price is on the profit side of the entry */
  inProfit: boolean;
  /** how far to the target: 0..100 while in profit (clamped), 0 while at or below entry */
  pctToTarget: number;
  /** how far to the stop: 0..100 while in loss, 0 otherwise */
  pctToStop: number;
}

/**
 * Where the live price sits on the bar "stop - entry - target". The bar always reads loss on the left and profit on the
 * right, whichever way the trade points, so a short needs no mental flip. Returns null for a degenerate trade.
 */
export function trackPosition(p: { side: Side; entry: number; stop: number; target: number; price: number | null }): TrackPosition | null {
  const { side, entry, stop, target, price } = p;
  if (![entry, stop, target].every(Number.isFinite)) return null;
  const dir = side === 'long' ? 1 : -1;
  const targetDist = dir * (target - entry); // > 0 for a sane trade
  const stopDist = dir * (entry - stop); // > 0 for a sane trade
  if (!(targetDist > 0) || !(stopDist > 0)) return null;
  const entryX = stopDist / (stopDist + targetDist);
  let priceX = entryX;
  let pctToTarget = 0;
  let pctToStop = 0;
  let inProfit = false;
  if (price !== null && Number.isFinite(price)) {
    const move = dir * (price - entry);
    if (move >= 0) {
      inProfit = move > 0;
      const f = Math.min(1, move / targetDist);
      priceX = entryX + f * (1 - entryX);
      pctToTarget = f * 100;
    } else {
      const f = Math.min(1, -move / stopDist);
      priceX = entryX - f * entryX;
      pctToStop = f * 100;
    }
  }
  return { stopX: 0, entryX, targetX: 1, priceX, inProfit, pctToTarget, pctToStop };
}

/** Lines the chart draws for the open trade. */
export function positionLines(pos: { side: Side; entryPrice: number; stopPrice: number; targetPrice: number } | null | undefined): PositionLines | null {
  if (!pos) return null;
  if (![pos.entryPrice, pos.stopPrice, pos.targetPrice].every(Number.isFinite)) return null;
  return { side: pos.side, entry: pos.entryPrice, stop: pos.stopPrice, target: pos.targetPrice };
}

// --------------------------------------------------------------------------------------------------------- plain words

export type ResultTone = 'win' | 'loss' | 'flat';

/** Win / loss by the sign of the net result (after brokerage). */
export const toneOf = (net: number | null | undefined): ResultTone => (net === null || net === undefined || !Number.isFinite(net) || net === 0 ? 'flat' : net > 0 ? 'win' : 'loss');

const EXIT_TEXT: Record<string, string> = {
  take_profit: 'Take profit reached',
  stop_loss: 'Stop loss hit',
  breakeven_stop: 'Stopped at break-even',
  time_exit: 'Closed after its time limit',
  manual: 'Closed by hand',
  kill_switch: 'Closed by the emergency stop',
  mode_switch: 'Closed when the mode changed',
  liquidation: 'Closed by the exchange (liquidation)',
  reconcile: 'Closed to match the exchange',
  end_of_data: 'Closed at the end of the data',
};

/** Why a trade closed, in words an ordinary user understands. */
export function exitReasonText(reason: string | null | undefined): string {
  if (!reason) return 'Closed';
  return EXIT_TEXT[reason] ?? reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const WHY_TEXT: Record<string, string> = {
  KILL_SWITCH: 'the emergency stop is on',
  STALE_DATA: 'waiting for fresh market prices',
  API_UNHEALTHY: 'waiting for the market connection to recover',
  MAX_TRADES_24H: 'the limit of new trades in 24 hours has been reached',
  DAILY_LOSS_LIMIT: 'the daily loss limit was reached, so it is resting',
  MAX_DRAWDOWN: 'the account fell too far from its peak, so it is resting',
  CONSECUTIVE_LOSSES: 'taking a break after a run of losses',
  COOLDOWN: 'a short cool-down after the last loss',
  SPREAD: 'the gap between buyers and sellers is too wide right now',
  PER_TRADE_RISK: 'the possible loss on this setup was above the per-trade limit',
  NET_REWARD: 'the expected profit after brokerage was too small',
  NET_REWARD_RISK: 'the expected profit after brokerage was too small for the risk',
  LIQUIDATION_BUFFER: 'there was not enough safety margin for this setup',
  FREE_MARGIN: 'there was not enough free margin for this setup',
  MIN_BALANCE: 'there was not enough balance available',
  DUPLICATE_SIGNAL: 'that setup had already been handled',
  MAX_OPEN_POSITIONS: 'a trade is already running',
  PENDING_ORDER: 'an order is still being processed',
  QUANTITY: 'the position size in the settings needs a look',
  LEVERAGE: 'the leverage in the settings needs a look',
};

const upFirst = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

/**
 * A lower-case phrase for why the algo is not trading, from the risk manager's reasons ("CODE: message"). The first
 * reason wins because the risk manager lists the most fundamental check first. Unknown codes get a generic phrase; the
 * raw text is never shown to an ordinary user.
 */
export function whyPhrase(reasons: readonly string[] | null | undefined): string | null {
  if (!reasons || reasons.length === 0) return null;
  for (const r of reasons) {
    const code = /^([A-Z0-9_]+):/.exec(r)?.[1];
    if (code && WHY_TEXT[code]) return WHY_TEXT[code];
  }
  return 'a safety check did not pass';
}

/** `whyPhrase` as a sentence start: "The daily loss limit was reached, so it is resting". */
export function friendlyWhy(reasons: readonly string[] | null | undefined): string | null {
  const p = whyPhrase(reasons);
  return p === null ? null : upFirst(p);
}

/**
 * The one calm line under "Waiting for a good setup": why nothing is open right now, in plain words. null when there is
 * nothing useful to add.
 */
export function waitingNote(state: Pick<BotState, 'killSwitch' | 'running' | 'workerActive' | 'demo'>): string | null {
  if (state.killSwitch) return 'The emergency stop is on, so no new trades are opened.';
  if (!state.workerActive) return 'The trading engine is not active on this server right now.';
  if (!state.running) return 'The algo is paused, so no new trades are opened.';
  const d = state.demo;
  if (!d) return null;
  if (d.risk && d.risk.tradingAllowed === false) {
    const p = whyPhrase(d.risk.blockers);
    if (p) return `Not trading right now: ${p}.`;
  }
  const last = d.lastDecision;
  if (last && !last.allowed) {
    const p = whyPhrase(last.reasons);
    if (p) return `The last setup was skipped: ${p}.`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------- today's results

/** Today's results (IST day) worked out from the trade list, for a backend that does not send `demo.today`. */
export function todayFromTrades(trades: readonly TradeRow[], now: number, goalInr: number, tradesLimit: number): DemoToday {
  const from = istDayStart(now);
  const to = from + DAY_MS;
  let n = 0;
  let wins = 0;
  let losses = 0;
  let usd = 0;
  let inr = 0;
  let fees = 0;
  for (const t of trades) {
    if (t.status !== 'closed' || t.exitTs === null || t.exitTs < from || t.exitTs >= to) continue;
    n++;
    const net = t.netPnl ?? 0;
    if (net > 0) wins++;
    else if (net < 0) losses++;
    usd += net;
    inr += t.netPnlInr ?? 0;
    fees += t.fees ?? 0;
  }
  return { day: istDayLabel(now), trades: n, wins, losses, netPnlUsd: usd, netPnlInr: inr, feesUsd: fees, goalInr, tradesLimit };
}

/** The daily goal in INR (display only), tolerant of settings from a backend that predates it. */
export const goalInrOf = (state: BotState): number => {
  const g = (state.settings as { goals?: { dailyProfitInr?: number } }).goals?.dailyProfitInr;
  return typeof g === 'number' && Number.isFinite(g) && g >= 0 ? g : 500;
};

export const tradesLimitOf = (state: BotState): number => state.settings.limits?.maxTradesPer24h ?? 10;

/** `demo.today` from the backend when present, otherwise computed from the loaded trades (null until those load). */
export function resolveToday(state: BotState, trades: readonly TradeRow[] | null): DemoToday | null {
  if (state.demo?.today) return state.demo.today;
  if (!trades) return null;
  return todayFromTrades(trades, state.now, goalInrOf(state), tradesLimitOf(state));
}

/** Share of the daily goal reached, 0..1 (a loss counts as 0). */
export const goalProgress = (netInr: number, goalInr: number): number => (goalInr > 0 && Number.isFinite(netInr) ? Math.max(0, Math.min(1, netInr / goalInr)) : 0);

// -------------------------------------------------------------------------------- older / slimmer backend tolerance

/**
 * Chart seed for a backend that has no `state.market`: the one-minute closes in `state.spark` as flat-bodied candles
 * (open = previous close). Points in the minute that is still forming are left out, they are not closed candles.
 */
export function seedCandlesFromSpark(spark: readonly (readonly [number, number])[] | null | undefined, now: number): MarketCandle[] {
  if (!spark || spark.length === 0) return [];
  const forming = Math.floor(now / 60_000) * 60_000;
  const out: MarketCandle[] = [];
  let prev: number | null = null;
  for (const [t, c] of spark) {
    if (!Number.isFinite(t) || !Number.isFinite(c) || t >= forming) continue;
    const o = prev ?? c;
    out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0 });
    prev = c;
  }
  return out;
}

/**
 * `/api/state?slim=1` leaves out the two bulky chart series. Put the ones from the last full snapshot back so the rest of
 * the dashboard (and an older backend, which ignores the flag and sends everything) never sees a hole.
 */
export function mergeSlimState(prev: BotState | null, next: BotState): BotState {
  if (!next.slim) return next;
  const { slim: _slim, ...rest } = next;
  void _slim;
  const merged: BotState = { ...rest, spark: prev?.spark ?? [] };
  if (next.market) merged.market = { ...next.market, candles: prev?.market?.candles ?? [] };
  return merged;
}
