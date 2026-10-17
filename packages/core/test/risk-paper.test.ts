import { describe, expect, it } from 'vitest';
import {
  applyClose,
  applyOpen,
  closePosition,
  evaluateEntryRisk,
  newDemoAccount,
  openPaperPosition,
  paperContext,
  stepPosition,
  type RiskState,
  type Signal,
  type Tick,
} from '../src';
import { T0, settings, spec } from './helpers';

const signal = (over: Partial<Signal> = {}): Signal => ({
  side: 'long',
  candleTime: T0,
  refPrice: 3000,
  atr: 1.5,
  targetMoveUsd: 5,
  stopMoveUsd: 3,
  regime: 'trend_up',
  reasons: ['test'],
  features: {},
  ...over,
});

const tick = (bid: number, ask: number, ts: number, extra: Partial<Tick> = {}): Tick => ({
  ts,
  bid,
  ask,
  last: (bid + ask) / 2,
  high: (bid + ask) / 2,
  low: (bid + ask) / 2,
  ...extra,
});

const baseState = (over: Partial<RiskState> = {}): RiskState => ({
  now: T0,
  mode: 'demo',
  killSwitch: false,
  equityUsd: 100,
  startingEquityUsd: 100,
  peakEquityUsd: 100,
  availableMarginUsd: 100,
  openPositions: 0,
  entries: [],
  realised: [],
  consecutiveLosses: 0,
  lastLossTs: null,
  lastTickTs: T0,
  apiHealthy: true,
  lastEntrySignalCandle: null,
  pendingOrder: false,
  ...over,
});

const quote = { ts: T0, bid: 2999.95, ask: 3000.05, last: 3000 };
// A configuration that passes the economics gate so individual limits can be tested in isolation.
const S = () => settings({ limits: { minNetRewardRisk: 0, minExpectedNetRewardUsd: 0 } });

function decide(state: Partial<RiskState> = {}, s = S(), sig = signal(), q = quote) {
  return evaluateEntryRisk({ settings: s, spec: spec(), state: baseState(state), signal: sig, quote: q });
}
const failed = (d: ReturnType<typeof decide>) => d.checks.filter((c) => !c.ok).map((c) => c.code);

describe('risk manager', () => {
  it('allows a healthy trade and plans 20 contracts / $12 margin at 50x', () => {
    const d = decide();
    expect(failed(d)).toEqual([]);
    expect(d.allowed).toBe(true);
    expect(d.plan!.contracts).toBe(20);
    expect(d.plan!.marginUsd).toBeCloseTo((0.2 * 3000.05) / 50, 6);
    expect(d.plan!.stopPrice).toBeLessThan(d.plan!.entryPrice);
    expect(d.plan!.targetPrice).toBeGreaterThan(d.plan!.entryPrice);
  });

  it('blocks the 11th entry inside a rolling 24h window and releases after it ages out', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ ts: T0 - (i + 1) * 3_600_000 }));
    expect(failed(decide({ entries }))).toContain('MAX_TRADES_24H');
    const aged = entries.map((e, i) => (i === 0 ? { ts: T0 - 25 * 3_600_000 } : e));
    expect(failed(decide({ entries: aged }))).not.toContain('MAX_TRADES_24H');
  });

  it('blocks when a position is already open (single position default)', () => {
    expect(failed(decide({ openPositions: 1 }))).toContain('MAX_OPEN_POSITIONS');
  });

  it('enforces the daily loss limit using rolling 24h realised P&L', () => {
    const realised = [{ ts: T0 - 3_600_000, netPnl: -6.5 }];
    expect(failed(decide({ realised }))).toContain('DAILY_LOSS_LIMIT');
    expect(failed(decide({ realised: [{ ts: T0 - 26 * 3_600_000, netPnl: -6.5 }] }))).not.toContain('DAILY_LOSS_LIMIT');
  });

  it('enforces max drawdown, consecutive-loss breaker and post-loss cooldown', () => {
    expect(failed(decide({ equityUsd: 80, peakEquityUsd: 100 }))).toContain('MAX_DRAWDOWN');
    expect(failed(decide({ consecutiveLosses: 3, lastLossTs: T0 - 40 * 60_000 }))).toContain('CONSECUTIVE_LOSSES');
    // the breaker pauses, then recovers by itself after consecutiveLossPauseMinutes (default 120)
    expect(failed(decide({ consecutiveLosses: 3, lastLossTs: T0 - 121 * 60_000 }))).not.toContain('CONSECUTIVE_LOSSES');
    expect(failed(decide({ lastLossTs: T0 - 60_000 }))).toContain('COOLDOWN');
    expect(failed(decide({ lastLossTs: T0 - 10 * 60_000 }))).not.toContain('COOLDOWN');
  });

  it('rejects wide spreads, stale data and unhealthy connectivity (fail closed)', () => {
    expect(failed(decide({}, S(), signal(), { ...quote, bid: 2999, ask: 3001 }))).toContain('SPREAD');
    expect(failed(decide({ lastTickTs: T0 - 60_000 }))).toContain('STALE_DATA');
    expect(failed(decide({ lastTickTs: null }))).toContain('STALE_DATA');
    expect(failed(decide({ apiHealthy: false }))).toContain('API_UNHEALTHY');
  });

  it('protects against duplicate signals and in-flight orders', () => {
    expect(failed(decide({ lastEntrySignalCandle: T0 }))).toContain('DUPLICATE_SIGNAL');
    expect(failed(decide({ pendingOrder: true }))).toContain('PENDING_ORDER');
  });

  it('enforces the kill switch', () => {
    expect(failed(decide({ killSwitch: true }))).toContain('KILL_SWITCH');
  });

  it('enforces per-trade risk, net reward and net reward:risk using fees', () => {
    const strict = settings({ limits: { perTradeRiskUsd: 1.0 } });
    expect(failed(decide({}, strict))).toContain('PER_TRADE_RISK');
    // Default config: with taker entry+stop and a $4 target the fee drag fails the net reward gate.
    const def = settings();
    const d = decide({}, def, signal({ targetMoveUsd: 4, stopMoveUsd: 4 }));
    expect(failed(d)).toContain('NET_REWARD_RISK');
  });

  it('requires free margin and a liquidation buffer; leverage never overrides them', () => {
    expect(failed(decide({ availableMarginUsd: 10, equityUsd: 100 }))).toContain('FREE_MARGIN');
    // 100x: liquidation distance ~ 0.5% of 3000 = $15, stop $6*3 = $18 needed.
    const lev = settings({ position: { leverage: 100 }, limits: { minNetRewardRisk: 0, minExpectedNetRewardUsd: 0 } });
    expect(failed(decide({}, lev, signal({ stopMoveUsd: 6 })))).toContain('LIQUIDATION_BUFFER');
    expect(failed(decide({}, settings({ position: { leverage: 150 } })))).toContain('LEVERAGE');
  });

  it('live mode fails closed without arming, verified spec, or reconciliation', () => {
    const live = (over: Partial<RiskState> = {}, sp = spec()) =>
      evaluateEntryRisk({ settings: S(), spec: sp, state: baseState({ mode: 'live', ...over }), signal: signal(), quote });
    const codes = (d: ReturnType<typeof live>) => d.checks.filter((c) => !c.ok).map((c) => c.code);
    expect(codes(live())).toEqual(expect.arrayContaining(['LIVE_NOT_ARMED', 'NOT_RECONCILED']));
    expect(codes(live({ liveArmed: true, reconciled: true }, spec({ verified: false })))).toContain('SPEC_UNVERIFIED');
    expect(live({ liveArmed: true, reconciled: true }).allowed).toBe(true);
  });
});

describe('paper execution simulator', () => {
  const s = settings();
  const sp = spec();
  const ctx = paperContext(s, sp);
  const open = (side: 'long' | 'short' = 'long') =>
    openPaperPosition({ id: 't1', signal: signal({ side }), tick: tick(2999.95, 3000.05, T0), contracts: 20 }, ctx);

  it('fills the entry at ask + slippage with a taker fee, deducted from the virtual balance', () => {
    const pos = open();
    expect(pos.entryPrice).toBeCloseTo(3000.15, 6);
    expect(pos.entryFee.role).toBe('taker');
    expect(pos.entryFee.total).toBeCloseTo(3000.15 * 0.2 * 0.0005 * 1.18, 6);
    const acct = applyOpen(newDemoAccount(100, T0), pos, T0);
    expect(acct.balanceUsd).toBeCloseTo(100 - pos.entryFee.total, 8);
    expect(acct.openPosition).not.toBeNull();
  });

  it('short entries fill at bid - slippage', () => {
    const pos = open('short');
    expect(pos.entryPrice).toBeCloseTo(2999.85, 6);
    expect(pos.stopPrice).toBeGreaterThan(pos.entryPrice);
    expect(pos.targetPrice).toBeLessThan(pos.entryPrice);
  });

  it('exits at the stop with extra slippage, as a taker', () => {
    const pos = open();
    const r = stepPosition(pos, tick(2996, 2996.1, T0 + 60_000, { low: 2995.5, high: 3000 }), ctx);
    expect(r.exit?.reason).toBe('stop_loss');
    expect(r.exit?.role).toBe('taker');
    expect(r.exit!.price).toBeLessThanOrEqual(pos.stopPrice - s.execution.simStopSlippageUsd + 1e-9);
    const trade = closePosition(r.position, r.exit!, T0 + 60_000, ctx);
    expect(trade.netPnl).toBeLessThan(0);
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.fees + trade.funding, 6);
  });

  it('take-profit fills only after the market trades THROUGH the target, as a maker', () => {
    const pos = open();
    const touch = stepPosition(pos, tick(3004, 3004.1, T0 + 60_000, { high: pos.targetPrice, low: 3001 }), ctx);
    expect(touch.exit).toBeNull();
    const through = stepPosition(pos, tick(3005.5, 3005.6, T0 + 120_000, { high: pos.targetPrice + 0.2, low: 3001 }), ctx);
    expect(through.exit?.reason).toBe('take_profit');
    expect(through.exit?.role).toBe('maker');
    expect(through.exit?.price).toBe(pos.targetPrice);
    const trade = closePosition(through.position, through.exit!, T0 + 120_000, ctx);
    expect(trade.reachedTarget).toBe(true);
    expect(trade.netPnl).toBeGreaterThan(0);
  });

  it('assumes the STOP fills first when stop and target both trade inside one tick', () => {
    const pos = open();
    const r = stepPosition(pos, tick(3000, 3000.1, T0 + 60_000, { high: pos.targetPrice + 1, low: pos.stopPrice - 1 }), ctx);
    expect(r.exit?.reason).toBe('stop_loss');
  });

  it('time-exits at the maximum holding time with a market order', () => {
    const pos = open();
    const r = stepPosition(pos, tick(3001, 3001.1, T0 + 30 * 60_000, { high: 3001.2, low: 3000.9 }), ctx);
    expect(r.exit?.reason).toBe('time_exit');
    expect(r.exit?.role).toBe('taker');
  });

  it('tightens the stop to a fee-covering break-even after 15 minutes when in profit', () => {
    const pos = open();
    // Not yet in profit AFTER fees (needs ~$3.5 move): the stop must NOT be moved.
    const early = stepPosition(pos, tick(3003, 3003.1, T0 + 16 * 60_000, { high: 3003.2, low: 3002.9 }), ctx);
    expect(early.position.breakevenArmed).toBe(false);
    expect(early.position.stopPrice).toBe(pos.stopPrice);
    const r = stepPosition(pos, tick(3004.2, 3004.3, T0 + 16 * 60_000, { high: 3004.4, low: 3004.1 }), ctx);
    expect(r.exit).toBeNull();
    expect(r.position.breakevenArmed).toBe(true);
    expect(r.position.stopPrice).toBeGreaterThan(pos.entryPrice);
    // Then a pullback to the new stop exits as breakeven_stop with ~zero net loss
    const back = stepPosition(r.position, tick(3000.5, 3000.6, T0 + 17 * 60_000, { high: 3003, low: r.position.stopPrice - 0.1 }), ctx);
    expect(back.exit?.reason).toBe('breakeven_stop');
  });

  it('charges funding when a funding timestamp is crossed (long pays positive funding)', () => {
    const fctx = paperContext(s, sp, 0.0001);
    const start = Date.UTC(2026, 0, 5, 7, 50, 0);
    const pos = openPaperPosition({ id: 'f', signal: signal(), tick: tick(2999.95, 3000.05, start), contracts: 20 }, fctx);
    const r = stepPosition(pos, tick(3000.5, 3000.6, Date.UTC(2026, 0, 5, 8, 0, 1), { high: 3000.6, low: 3000 }), fctx);
    expect(r.fundingDelta).toBeCloseTo(-0.0001 * 3000.55 * 0.2, 4);
  });

  it('account bookkeeping keeps balance consistent: balance = start + sum(net)', () => {
    let acct = applyOpen(newDemoAccount(100, T0), open(), T0);
    const r = stepPosition(acct.openPosition!, tick(3005.5, 3005.6, T0 + 120_000, { high: 3006, low: 3001 }), ctx);
    const trade = closePosition(r.position, r.exit!, T0 + 120_000, ctx);
    acct = applyClose(acct, trade, T0 + 120_000);
    expect(acct.balanceUsd).toBeCloseTo(100 + trade.netPnl, 6);
    expect(acct.openPosition).toBeNull();
    expect(acct.totalFeesUsd).toBeCloseTo(trade.fees, 6);
  });
});
