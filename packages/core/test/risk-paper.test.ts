import { describe, expect, it } from 'vitest';
import {
  accountEquity,
  applyClose,
  applyOpen,
  closePosition,
  evaluateEntryRisk,
  gaussian,
  mulberry32,
  newDemoAccount,
  openPaperPosition,
  paperContext,
  stepPosition,
  type OpenPosition,
  type PaperContext,
  type RiskState,
  type Signal,
  type Tick,
} from '../src';
import { T0, legacySettings, settings, spec } from './helpers';

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

  it('enforces per-trade risk, net reward and net reward:risk using fees (both legs charged by default)', () => {
    const strict = settings({ limits: { perTradeRiskUsd: 1.0 } });
    expect(failed(decide({}, strict))).toContain('PER_TRADE_RISK');
    // taker entry + taker stop and a $4 target: the fee drag fails the net reward gate.
    const d = decide({}, settings(), signal({ targetMoveUsd: 4, stopMoveUsd: 4 }));
    expect(d.plan!.economics.exitFeeWaived).toBe(false);
    expect(failed(d)).toContain('NET_REWARD_RISK');
  });

  it('dormant Scalper Offer (enabled explicitly): the same $4 trade passes the net-reward gates because only the entry fee is charged', () => {
    const def = legacySettings();
    const sig = signal({ targetMoveUsd: 4, stopMoveUsd: 3 });
    const d = decide({}, def, sig);
    expect(failed(d)).toEqual([]);
    expect(d.plan!.economics.exitFeeWaived).toBe(true);
    expect(d.plan!.economics.feeIfTarget).toBeCloseTo(d.plan!.economics.entryFee, 8);
    // net = gross 0.80 - 1 entry fee (~0.354) ; risk = 3 * 0.2 + stop slippage 0.05 + entry fee
    expect(d.plan!.economics.rewardNet).toBeGreaterThan(0.4);
    expect(d.plan!.economics.netRewardRisk).toBeGreaterThan(0.4);
    // switching the waiver off (the default) makes the identical trade materially worse
    const off = decide({}, legacySettings({ execution: { exitFeeWaiver: { enabled: false } } }), sig);
    expect(off.plan!.economics.rewardNet).toBeLessThan(d.plan!.economics.rewardNet);
    expect(off.plan!.economics.netRewardRisk).toBeLessThan(d.plan!.economics.netRewardRisk);
  });

  it('an enabled waiver is not assumed in the estimates when there is no time limit (a position may outlive the window)', () => {
    const sig = signal({ targetMoveUsd: 4, stopMoveUsd: 3 });
    const unlimited = decide({}, settings({ execution: { exitFeeWaiver: { enabled: true } } }), sig);
    expect(unlimited.plan!.economics.exitFeeWaived).toBe(false);
    expect(unlimited.plan!.economics.feeIfTarget).toBeGreaterThan(unlimited.plan!.economics.entryFee);
    // a policy of "none" also means no time exit, whatever maxHoldMinutes says
    expect(decide({}, settings({ execution: { exitFeeWaiver: { enabled: true } }, exits: { maxHoldMinutes: 30 } }), sig).plan!.economics.exitFeeWaived).toBe(false);
    // with a real time limit inside the window the assumption is back
    expect(decide({}, legacySettings(), sig).plan!.economics.exitFeeWaived).toBe(true);
    // an explicit "not applied" fallback still wins
    const fallback = evaluateEntryRisk({ settings: legacySettings(), spec: spec(), state: baseState(), signal: sig, quote, feeOptions: { waiverOverride: false } });
    expect(fallback.plan!.economics.exitFeeWaived).toBe(false);
  });

  describe('USD 10 target with a USD 5-8 stop (new defaults)', () => {
    const q3390 = { ts: T0, bid: 3389.95, ask: 3390.05, last: 3390 };
    const sig = (stop: number) => signal({ targetMoveUsd: 10, stopMoveUsd: stop, refPrice: 3390 });

    it('plans a 10-dollar move and about USD 1.4 net after fees at ETH 3,390 (maker take-profit)', () => {
      const d = decide({}, settings(), sig(6), q3390);
      expect(failed(d)).toEqual([]);
      const e = d.plan!.economics;
      // a 10 move on 0.20 ETH is 2.00, minus the 0.10 entry slippage (0.02) = 1.98
      expect(e.rewardGross).toBeCloseTo(1.98, 2);
      expect(e.rewardNet).toBeGreaterThan(1.3);
      expect(e.rewardNet).toBeLessThan(1.5);
      // loss at a 6 stop: (6 + 0.1 entry slippage + 0.25 stop slippage) * 0.2 + ~0.80 brokerage
      expect(e.riskNet).toBeGreaterThan(2.0);
      expect(e.riskNet).toBeLessThan(2.2);
    });

    it('the widest stop of the band still fits the per-trade limit at ETH 3,390, and is rejected once fees push it over', () => {
      const wide = decide({}, settings(), sig(8), q3390);
      expect(wide.plan!.economics.riskNet).toBeLessThan(2.5);
      expect(failed(wide)).not.toContain('PER_TRADE_RISK');
      // same stop at ETH 3,600: brokerage grows with the price, the loss cap (full fees) rejects it
      const q3600 = { ts: T0, bid: 3599.95, ask: 3600.05, last: 3600 };
      const high = decide({}, settings(), sig(8), q3600);
      expect(high.plan!.economics.riskNet).toBeGreaterThan(2.5);
      expect(failed(high)).toContain('PER_TRADE_RISK');
    });

    it('a tighter per-trade limit rejects a USD 6 stop (loss cap includes both brokerage legs)', () => {
      const tight = settings({ limits: { perTradeRiskUsd: 2.0 } });
      expect(failed(decide({}, tight, sig(6), q3390))).toContain('PER_TRADE_RISK');
      // stop 5: (5 + 0.1 + 0.25) * 0.2 = 1.07 plus ~0.80 brokerage = ~1.87, inside the same limit
      expect(failed(decide({}, tight, sig(5), q3390))).not.toContain('PER_TRADE_RISK');
    });

    it('the 10-trades-per-24h ceiling is unchanged and the default limits keep every other gate', () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({ ts: T0 - (i + 1) * 3_600_000 }));
      expect(failed(decide({ entries }, settings(), sig(6), q3390))).toEqual(['MAX_TRADES_24H']);
      const s = settings();
      expect(s.limits.maxTradesPer24h).toBe(10);
      expect([s.limits.perTradeRiskUsd, s.limits.dailyLossLimitUsd, s.limits.maxDrawdownPct, s.limits.maxConsecutiveLosses]).toEqual([2.5, 6, 15, 3]);
      expect([s.limits.minFreeMarginPct, s.limits.minLiquidationBufferMultiple, s.limits.minNetRewardRisk]).toEqual([30, 3, 0.25]);
    });
  });

  it('the per-trade LOSS cap is always checked on full fees: an assumed waiver never makes it looser', () => {
    // $3 stop + 0.25 slippage on 0.2 ETH: net loss ~1.00 with the waiver, ~1.36 with full fees.
    const tight = legacySettings({ limits: { perTradeRiskUsd: 1.2, minNetRewardRisk: 0, minExpectedNetRewardUsd: 0 } });
    const d = decide({}, tight, signal({ targetMoveUsd: 5, stopMoveUsd: 3 }));
    expect(d.plan!.economics.riskNet).toBeLessThan(1.2); // the waived estimate would have passed ...
    expect(failed(d)).toContain('PER_TRADE_RISK'); // ... but the loss cap uses the worst case
    // the live fallback (waiver not applied) gives the same verdict
    const live = evaluateEntryRisk({ settings: tight, spec: spec(), state: baseState(), signal: signal({ targetMoveUsd: 5, stopMoveUsd: 3 }), quote, feeOptions: { waiverOverride: false } });
    expect(live.checks.filter((c) => !c.ok).map((c) => c.code)).toContain('PER_TRADE_RISK');
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
  /** The dormant Scalper Offer switched on explicitly, with its 30 minute time limit (the pre-v2 behaviour). */
  const wctx = paperContext(legacySettings(), sp);
  const open = (side: 'long' | 'short' = 'long', c: PaperContext = ctx) =>
    openPaperPosition({ id: 't1', signal: signal({ side }), tick: tick(2999.95, 3000.05, T0), contracts: 20 }, c);

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

  it('the default never time-exits: 30 minutes, 3 hours or 3 days later the position is still open', () => {
    const pos = open();
    for (const minutes of [28.5, 30, 31, 180, 3 * 24 * 60]) {
      const r = stepPosition(pos, tick(3001, 3001.1, T0 + minutes * 60_000, { high: 3001.2, low: 3000.9 }), ctx);
      expect(r.exit, `${minutes} min`).toBeNull();
    }
  });

  it('with a time limit configured and the dormant waiver ON, it time-exits with a market order at 28.5 min (90 s inside the window)', () => {
    const pos = open('long', wctx);
    const before = stepPosition(pos, tick(3001, 3001.1, T0 + 28 * 60_000, { high: 3001.2, low: 3000.9 }), wctx);
    expect(before.exit).toBeNull();
    const r = stepPosition(pos, tick(3001, 3001.1, T0 + 28.5 * 60_000, { high: 3001.2, low: 3000.9 }), wctx);
    expect(r.exit?.reason).toBe('time_exit');
    expect(r.exit?.role).toBe('taker');
    // ... and that exit is free: only the entry fee is ever paid
    const trade = closePosition(r.position, r.exit!, T0 + 28.5 * 60_000, wctx);
    expect(trade.exitFee).toBe(0);
    expect(trade.fees).toBeCloseTo(pos.entryFee.total, 8);
  });

  it('with a configured limit and the waiver off it time-exits at the configured maximum holding time (full closing fee)', () => {
    const off = paperContext(legacySettings({ execution: { exitFeeWaiver: { enabled: false } } }), sp);
    const pos = openPaperPosition({ id: 'n1', signal: signal(), tick: tick(2999.95, 3000.05, T0), contracts: 20 }, off);
    expect(stepPosition(pos, tick(3001, 3001.1, T0 + 29.9 * 60_000, { high: 3001.2, low: 3000.9 }), off).exit).toBeNull();
    const r = stepPosition(pos, tick(3001, 3001.1, T0 + 30 * 60_000, { high: 3001.2, low: 3000.9 }), off);
    expect(r.exit?.reason).toBe('time_exit');
    const trade = closePosition(r.position, r.exit!, T0 + 30 * 60_000, off);
    expect(trade.exitFee).toBeGreaterThan(0);
  });

  it('by default both legs are charged: a stop or a take-profit a few minutes in still pays the closing fee', () => {
    const pos = open();
    const stop = stepPosition(pos, tick(2996, 2996.1, T0 + 5 * 60_000, { low: 2995.5, high: 3000 }), ctx);
    const stopTrade = closePosition(stop.position, stop.exit!, T0 + 5 * 60_000, ctx);
    expect(stopTrade.exitFee).toBeGreaterThan(0);
    expect(stopTrade.exitFeeSaved).toBe(0);
    expect(stopTrade.fees).toBeCloseTo(pos.entryFee.total + stopTrade.exitFee, 8);
    const tp = stepPosition(pos, tick(3005.5, 3005.6, T0 + 10 * 60_000, { high: pos.targetPrice + 0.2, low: 3001 }), ctx);
    const tpTrade = closePosition(tp.position, tp.exit!, T0 + 10 * 60_000, ctx);
    expect(tpTrade.exitFee).toBeGreaterThan(0);
    expect(tpTrade.netPnl).toBeCloseTo(tpTrade.grossPnl - pos.entryFee.total - tpTrade.exitFee, 8);
  });

  it('dormant Scalper Offer (enabled explicitly): stop-loss and take-profit exits inside 30 minutes pay no closing fee; a late close does', () => {
    const pos = open('long', wctx);
    const stop = stepPosition(pos, tick(2996, 2996.1, T0 + 5 * 60_000, { low: 2995.5, high: 3000 }), wctx);
    const stopTrade = closePosition(stop.position, stop.exit!, T0 + 5 * 60_000, wctx);
    expect(stopTrade.exitFee).toBe(0);
    expect(stopTrade.fees).toBeCloseTo(pos.entryFee.total, 8);
    expect(stopTrade.netPnl).toBeCloseTo(stopTrade.grossPnl - pos.entryFee.total + stopTrade.funding, 8);

    const tp = stepPosition(pos, tick(3005.5, 3005.6, T0 + 10 * 60_000, { high: pos.targetPrice + 0.2, low: 3001 }), wctx);
    const tpTrade = closePosition(tp.position, tp.exit!, T0 + 10 * 60_000, wctx);
    expect(tpTrade.exitFee).toBe(0);
    expect(tpTrade.netPnl).toBeCloseTo(tpTrade.grossPnl - pos.entryFee.total, 8);

    // The same stop exit filled at 30:01 is outside the offer: the closing fee is charged.
    const late = closePosition(stop.position, stop.exit!, T0 + 30 * 60_000 + 1000, wctx);
    expect(late.exitFee).toBeGreaterThan(0);
  });

  it('a liquidation pays the full closing fee even inside the dormant Scalper window (not eligible)', () => {
    const pos = open('long', wctx);
    const r = stepPosition(pos, tick(2900, 2900.1, T0 + 2 * 60_000, { low: 2800, high: 3000 }), wctx);
    expect(r.exit?.reason).toBe('liquidation');
    const trade = closePosition(r.position, r.exit!, T0 + 2 * 60_000, wctx);
    expect(trade.exitFee).toBeGreaterThan(0);
    expect(trade.exitFeeSaved).toBe(0);
  });

  it('tightens the stop to a fee-covering break-even after 15 minutes when in profit (policy breakeven_then_close, no waiver: needs ~$3.5)', () => {
    const off = paperContext(legacySettings({ execution: { exitFeeWaiver: { enabled: false } } }), sp);
    const pos = openPaperPosition({ id: 'be0', signal: signal(), tick: tick(2999.95, 3000.05, T0), contracts: 20 }, off);
    // Not yet in profit AFTER fees (needs ~$3.5 move): the stop must NOT be moved.
    const early = stepPosition(pos, tick(3003, 3003.1, T0 + 16 * 60_000, { high: 3003.2, low: 3002.9 }), off);
    expect(early.position.breakevenArmed).toBe(false);
    expect(early.position.stopPrice).toBe(pos.stopPrice);
    const r = stepPosition(pos, tick(3004.2, 3004.3, T0 + 16 * 60_000, { high: 3004.4, low: 3004.1 }), off);
    expect(r.exit).toBeNull();
    expect(r.position.breakevenArmed).toBe(true);
    expect(r.position.stopPrice).toBeGreaterThan(pos.entryPrice);
    // Then a pullback to the new stop exits as breakeven_stop with ~zero net loss
    const back = stepPosition(r.position, tick(3000.5, 3000.6, T0 + 17 * 60_000, { high: 3003, low: r.position.stopPrice - 0.1 }), off);
    expect(back.exit?.reason).toBe('breakeven_stop');
  });

  it('dormant Scalper Offer ON: the break-even stop only has to recover the ENTRY fee (~$1.8 move), since the exit is free', () => {
    const pos = open('long', wctx);
    // entry 3000.15 + entryFee/qty (0.354/0.2 = 1.77) = ~3001.92 : at bid 3001.0 not yet in profit after fees ...
    const early = stepPosition(pos, tick(3001, 3001.1, T0 + 16 * 60_000, { high: 3001.2, low: 3000.9 }), wctx);
    expect(early.position.breakevenArmed).toBe(false);
    // ... at bid 3003 it is, and the stop moves up to ~entry + 1.8, not entry + 3.5
    const r = stepPosition(pos, tick(3003, 3003.1, T0 + 16 * 60_000, { high: 3003.2, low: 3002.9 }), wctx);
    expect(r.position.breakevenArmed).toBe(true);
    expect(r.position.stopPrice).toBeGreaterThan(pos.entryPrice + 1.5);
    expect(r.position.stopPrice).toBeLessThan(pos.entryPrice + 2.2);
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

describe('no time limit (default): a position runs until its target or its stop', () => {
  const sp = spec();
  const dctx = paperContext(settings(), sp);
  const sig = (side: 'long' | 'short', stop = 6) => signal({ side, targetMoveUsd: 10, stopMoveUsd: stop });
  const openAt = (side: 'long' | 'short', c: PaperContext = dctx, stop = 6, at = T0) =>
    openPaperPosition({ id: `nl-${side}`, signal: sig(side, stop), tick: tick(2999.95, 3000.05, at), contracts: 20 }, c);

  /** Minute ticks around `mid`, none reaching the stop or the target. Fails the test if anything exits. */
  function holdQuietly(pos: OpenPosition, c: PaperContext, minutes: number, mid: number, from = T0): OpenPosition {
    let cur = pos;
    for (let m = 1; m <= minutes; m++) {
      const r = stepPosition(cur, tick(mid - 0.05, mid + 0.05, from + m * 60_000, { high: mid + 0.5, low: mid - 0.5 }), c);
      if (r.exit) throw new Error(`unexpected ${r.exit.reason} at minute ${m}`);
      cur = r.position;
    }
    return cur;
  }

  it('long: sits through 6 hours (in profit, not at target) and finally hits the USD 10 target; net = 2.00 - fees', () => {
    const pos = openAt('long');
    expect(pos.entryPrice).toBeCloseTo(3000.15, 6);
    expect(pos.targetPrice).toBeCloseTo(3010.15, 6);
    expect(pos.stopPrice).toBeCloseTo(2994.15, 6);
    const held = holdQuietly(pos, dctx, 360, 3006);
    // no break-even tightening and no time exit, however long it has been in profit
    expect(held.breakevenArmed).toBe(false);
    expect(held.stopPrice).toBe(pos.stopPrice);
    const exitTs = T0 + 361 * 60_000;
    const r = stepPosition(held, tick(3010.5, 3010.6, exitTs, { high: pos.targetPrice + 0.2, low: 3009 }), dctx);
    expect(r.exit?.reason).toBe('take_profit');
    expect(r.exit?.role).toBe('maker');
    expect(r.exit?.price).toBe(pos.targetPrice);
    const trade = closePosition(r.position, r.exit!, exitTs, dctx);
    expect(trade.holdMs).toBe(361 * 60_000);
    expect(trade.exitReason).toBe('take_profit');
    expect(trade.reachedTarget).toBe(true);
    expect(trade.grossPnl).toBeCloseTo(2.0, 8);
    const entryFee = 3000.15 * 0.2 * 0.0005 * 1.18; // taker
    const exitFee = 3010.15 * 0.2 * 0.0002 * 1.18; // maker take-profit, charged in full after 6 hours
    expect(trade.entryFee).toBeCloseTo(entryFee, 8);
    expect(trade.exitFee).toBeCloseTo(exitFee, 8);
    expect(trade.exitFeeSaved ?? 0).toBe(0);
    expect(trade.netPnl).toBeCloseTo(2.0 - entryFee - exitFee, 8);
    expect(trade.netPnl).toBeGreaterThan(1.4);
  });

  it('long: sits through 6 hours and finally hits the stop; the loss is gross loss plus both fees', () => {
    const pos = openAt('long');
    const held = holdQuietly(pos, dctx, 360, 3000.5);
    const exitTs = T0 + 361 * 60_000;
    const r = stepPosition(held, tick(2994.2, 2994.3, exitTs, { high: 3000.5, low: 2994.1 }), dctx);
    expect(r.exit?.reason).toBe('stop_loss');
    expect(r.exit?.role).toBe('taker');
    // stop 2994.15 (bid still above it) minus the 0.25 stop slippage
    expect(r.exit!.price).toBeCloseTo(2993.9, 6);
    const trade = closePosition(r.position, r.exit!, exitTs, dctx);
    expect(trade.holdMs).toBe(361 * 60_000);
    expect(trade.exitReason).toBe('stop_loss');
    expect(trade.reachedTarget).toBe(false);
    expect(trade.grossPnl).toBeCloseTo((2993.9 - 3000.15) * 0.2, 8); // -1.25
    const entryFee = 3000.15 * 0.2 * 0.0005 * 1.18;
    const exitFee = 2993.9 * 0.2 * 0.0005 * 1.18;
    expect(trade.netPnl).toBeCloseTo(-1.25 - entryFee - exitFee, 8);
    expect(trade.netPnl).toBeLessThan(0);
  });

  it('short: USD 10 target hit after a long hold; net = 2.00 - fees (and it mirrors the long)', () => {
    const pos = openAt('short');
    expect(pos.entryPrice).toBeCloseTo(2999.85, 6);
    expect(pos.targetPrice).toBeCloseTo(2989.85, 6);
    expect(pos.stopPrice).toBeCloseTo(3005.85, 6);
    const held = holdQuietly(pos, dctx, 200, 2994);
    const exitTs = T0 + 201 * 60_000;
    const r = stepPosition(held, tick(2989.7, 2989.8, exitTs, { high: 2992, low: pos.targetPrice - 0.2 }), dctx);
    expect(r.exit?.reason).toBe('take_profit');
    const trade = closePosition(r.position, r.exit!, exitTs, dctx);
    expect(trade.grossPnl).toBeCloseTo(2.0, 8);
    const entryFee = 2999.85 * 0.2 * 0.0005 * 1.18;
    const exitFee = 2989.85 * 0.2 * 0.0002 * 1.18;
    expect(trade.netPnl).toBeCloseTo(2.0 - entryFee - exitFee, 8);
  });

  it('short: sits through 6 hours and finally hits the stop', () => {
    const pos = openAt('short');
    const held = holdQuietly(pos, dctx, 360, 2999.5);
    const exitTs = T0 + 361 * 60_000;
    const r = stepPosition(held, tick(3005.7, 3005.8, exitTs, { high: 3005.9, low: 2999 }), dctx);
    expect(r.exit?.reason).toBe('stop_loss');
    const trade = closePosition(r.position, r.exit!, exitTs, dctx);
    expect(trade.netPnl).toBeLessThan(-1.2);
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.fees, 8);
  });

  it('with a market take-profit at ETH 3,390 both legs are taker: fees are about USD 0.80 and the 10 move nets about USD 1.2', () => {
    const mctx = paperContext(settings({ exits: { takeProfitOrderType: 'market' } }), sp);
    const pos = openPaperPosition({ id: 'm', signal: sig('long'), tick: tick(3389.95, 3390.05, T0), contracts: 20 }, mctx);
    const r = stepPosition(pos, tick(3400.2, 3400.3, T0 + 3 * 3_600_000, { high: pos.targetPrice + 0.2, low: 3398 }), mctx);
    expect(r.exit?.reason).toBe('take_profit');
    expect(r.exit?.role).toBe('taker');
    const trade = closePosition(r.position, r.exit!, T0 + 3 * 3_600_000, mctx);
    expect(trade.fees).toBeGreaterThan(0.79);
    expect(trade.fees).toBeLessThan(0.81);
    // 10 move less the 0.10 simulated slippage on a market exit = 9.9 * 0.2 = 1.98 gross
    expect(trade.grossPnl).toBeCloseTo(1.98, 8);
    expect(trade.netPnl).toBeGreaterThan(1.17);
    expect(trade.netPnl).toBeLessThan(1.2);
  });

  it('a stop or a target always fills eventually: random-walk paths, both sides, many hours, never a time exit', () => {
    let longest = 0;
    for (const side of ['long', 'short'] as const) {
      for (let seed = 1; seed <= 25; seed++) {
        const rand = mulberry32(seed * 7919 + (side === 'long' ? 1 : 2));
        let cur = openAt(side);
        let px = 3000;
        let exit: ReturnType<typeof stepPosition>['exit'] = null;
        let minutes = 0;
        while (!exit && minutes < 100_000) {
          minutes++;
          px += gaussian(rand) * 0.6;
          const r = stepPosition(cur, tick(px - 0.05, px + 0.05, T0 + minutes * 60_000, { high: px + 0.25, low: px - 0.25 }), dctx);
          cur = r.position;
          exit = r.exit;
        }
        expect(exit, `${side} seed ${seed} never exited`).not.toBeNull();
        expect(['stop_loss', 'take_profit']).toContain(exit!.reason);
        longest = Math.max(longest, minutes);
      }
    }
    // the point of the test: these positions really did run well past the old 30 minute limit
    expect(longest).toBeGreaterThan(60);
  });

  it('break-even tightening happens only for the breakeven_then_close policy (and then needs no time limit)', () => {
    const be = paperContext(settings({ exits: { timeExitPolicy: 'breakeven_then_close' } }), sp);
    expect(be.settings.exits.maxHoldMinutes).toBeNull();
    const pos = openAt('long', be);
    const armed = holdQuietly(pos, be, 20, 3006);
    expect(armed.breakevenArmed).toBe(true);
    expect(armed.stopPrice).toBeGreaterThan(pos.entryPrice);
    // ... and there is still no time exit hours later
    const later = holdQuietly(armed, be, 300, 3006);
    expect(later.breakevenArmed).toBe(true);

    for (const policy of ['none', 'close_at_market'] as const) {
      const c = paperContext(settings({ exits: { timeExitPolicy: policy, maxHoldMinutes: 600 } }), sp);
      const p = openAt('long', c);
      const held = holdQuietly(p, c, 120, 3006);
      expect(held.breakevenArmed, policy).toBe(false);
      expect(held.stopPrice, policy).toBe(p.stopPrice);
    }
  });

  it('a configured limit is honoured by close_at_market and ignored under the policy "none"', () => {
    const closeAt = paperContext(settings({ exits: { timeExitPolicy: 'close_at_market', maxHoldMinutes: 120 } }), sp);
    const pos = openAt('long', closeAt);
    const held = holdQuietly(pos, closeAt, 119, 3003);
    const r = stepPosition(held, tick(3003, 3003.1, T0 + 120 * 60_000, { high: 3003.5, low: 3002.5 }), closeAt);
    expect(r.exit?.reason).toBe('time_exit');
    expect(closePosition(r.position, r.exit!, T0 + 120 * 60_000, closeAt).exitFee).toBeGreaterThan(0);

    const none = paperContext(settings({ exits: { timeExitPolicy: 'none', maxHoldMinutes: 120 } }), sp);
    const p2 = openAt('long', none);
    expect(stepPosition(p2, tick(3003, 3003.1, T0 + 5 * 3_600_000, { high: 3003.5, low: 3002.5 }), none).exit).toBeNull();
  });
});

describe('funding over a long hold', () => {
  const sp = spec();
  const rate = 0.0001; // +0.01% per 8 h: longs pay shorts
  const fctx = paperContext(settings(), sp, rate);
  const start = Date.UTC(2026, 0, 5, 1, 0, 0); // funding settles at 00:00, 08:00 and 16:00 UTC
  const open = (side: 'long' | 'short') =>
    openPaperPosition({ id: `fund-${side}`, signal: signal({ side, targetMoveUsd: 10, stopMoveUsd: 6 }), tick: tick(2999.95, 3000.05, start), contracts: 20 }, fctx);

  /** One flat tick per minute (last = 3000, far from stop and target) for `minutes`. */
  function hold(pos: OpenPosition, minutes: number) {
    let cur = pos;
    let total = 0;
    const events: number[] = [];
    for (let m = 1; m <= minutes; m++) {
      const r = stepPosition(cur, tick(2999.95, 3000.05, start + m * 60_000), fctx);
      expect(r.exit).toBeNull();
      if (r.fundingDelta !== 0) events.push(m);
      total += r.fundingDelta;
      cur = r.position;
    }
    return { pos: cur, total, events };
  }

  it('9 hours (01:00 -> 10:00 UTC) cross exactly one funding time (08:00): a long pays, a short receives', () => {
    const notionalFee = rate * 3000 * 0.2; // last = 3000 on 0.20 ETH
    const long = hold(open('long'), 9 * 60);
    expect(long.events).toEqual([7 * 60]); // the first tick at or after 08:00
    expect(long.total).toBeCloseTo(-notionalFee, 8);
    expect(long.pos.fundingAccrued).toBeCloseTo(-0.06, 8);
    const short = hold(open('short'), 9 * 60);
    expect(short.events).toEqual([7 * 60]);
    expect(short.total).toBeCloseTo(notionalFee, 8);
    expect(short.pos.fundingAccrued).toBeCloseTo(0.06, 8);
  });

  it('the funding lands in the closed trade and the account balance: net = gross - fees + funding', () => {
    for (const side of ['long', 'short'] as const) {
      const held = hold(open(side), 9 * 60);
      const sign = side === 'long' ? -1 : 1;
      let acct = applyOpen(newDemoAccount(100, start), open(side), start);
      acct = { ...acct, openPosition: held.pos };
      // equity counts the funding already settled while the trade is open
      const mark = tick(2999.95, 3000.05, start + 9 * 3_600_000);
      const unrealised = side === 'long' ? (2999.95 - held.pos.entryPrice) * 0.2 : (held.pos.entryPrice - 3000.05) * 0.2;
      expect(accountEquity(acct, mark)).toBeCloseTo(acct.balanceUsd + unrealised + sign * 0.06, 6);
      // the target is finally reached at 9 h 1 min
      const exitTs = start + (9 * 60 + 1) * 60_000;
      const tgtTick = side === 'long' ? tick(3010.3, 3010.4, exitTs, { high: held.pos.targetPrice + 0.2, low: 3009 }) : tick(2989.6, 2989.7, exitTs, { high: 2991, low: held.pos.targetPrice - 0.2 });
      const r = stepPosition(held.pos, tgtTick, fctx);
      expect(r.exit?.reason).toBe('take_profit');
      const trade = closePosition(r.position, r.exit!, exitTs, fctx);
      expect(trade.funding).toBeCloseTo(sign * 0.06, 8);
      expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.fees + trade.funding, 8);
      acct = applyClose(acct, trade, exitTs);
      expect(acct.balanceUsd).toBeCloseTo(100 + trade.netPnl, 6);
    }
  });

  it('a gap that spans two funding times (01:00 -> 17:00 UTC in one tick) settles both', () => {
    const pos = open('long');
    const r = stepPosition(pos, tick(2999.95, 3000.05, Date.UTC(2026, 0, 5, 17, 0, 0)), fctx);
    expect(r.exit).toBeNull();
    expect(r.fundingDelta).toBeCloseTo(-0.12, 8);
    expect(r.position.nextFundingTs).toBe(Date.UTC(2026, 0, 6, 0, 0, 0));
  });

  it('no funding accrues when no funding time is crossed, and none without a funding rate', () => {
    expect(hold(open('long'), 6 * 60).total).toBe(0); // 01:00 -> 07:00
    const noRate = paperContext(settings(), sp);
    const pos = openPaperPosition({ id: 'nr', signal: signal({ targetMoveUsd: 10, stopMoveUsd: 6 }), tick: tick(2999.95, 3000.05, start), contracts: 20 }, noRate);
    expect(stepPosition(pos, tick(2999.95, 3000.05, start + 9 * 3_600_000), noRate).fundingDelta).toBe(0);
  });
});
