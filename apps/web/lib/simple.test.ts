import { describe, expect, it } from 'vitest';
import { clockTime, dayTime, inrWhole, signedInr } from './format';
import { exitReasonText, exitSidePrice, friendlyWhy, goalProgress, waitingNote, whyPhrase, istDayLabel, istDayStart, mergeSlimState, openPnlUsd, positionLines, seedCandlesFromSpark, todayFromTrades, toneOf, trackPosition } from './simple';
import { effectiveMaxHoldMinutes, scalperView } from './scalper';
import type { BotState, TradeRow } from './types';

describe('openPnlUsd', () => {
  it('long: gains when price rises, qty-scaled', () => {
    expect(openPnlUsd('long', 3390, 0.2, 3400)).toBeCloseTo(2, 10);
    expect(openPnlUsd('long', 3390, 0.2, 3385)).toBeCloseTo(-1, 10);
  });
  it('short: gains when price falls', () => {
    expect(openPnlUsd('short', 3390, 0.2, 3380)).toBeCloseTo(2, 10);
    expect(openPnlUsd('short', 3390, 0.2, 3395)).toBeCloseTo(-1, 10);
  });
  it('is null without a usable price', () => {
    expect(openPnlUsd('long', 3390, 0.2, null)).toBeNull();
    expect(openPnlUsd('long', 3390, 0.2, NaN)).toBeNull();
  });
});

describe('exitSidePrice', () => {
  it('uses the bid for a long and the ask for a short, last price as the fallback', () => {
    const m = { bid: 99, ask: 101, price: 100 };
    expect(exitSidePrice('long', m)).toBe(99);
    expect(exitSidePrice('short', m)).toBe(101);
    expect(exitSidePrice('long', { bid: null, ask: null, price: 100 })).toBe(100);
    expect(exitSidePrice('short', { bid: null, ask: null, price: null })).toBeNull();
  });
});

describe('trackPosition', () => {
  const long = { side: 'long' as const, entry: 3390, stop: 3385, target: 3400 };
  it('puts the entry between stop and target in proportion to their distances', () => {
    const t = trackPosition({ ...long, price: 3390 })!;
    expect(t.entryX).toBeCloseTo(5 / 15, 10);
    expect(t.priceX).toBeCloseTo(t.entryX, 10);
    expect(t.inProfit).toBe(false);
  });
  it('moves right in profit, left in loss, clamped to the ends', () => {
    expect(trackPosition({ ...long, price: 3395 })!.pctToTarget).toBeCloseTo(50, 10);
    expect(trackPosition({ ...long, price: 3395 })!.priceX).toBeGreaterThan(trackPosition({ ...long, price: 3390 })!.priceX);
    expect(trackPosition({ ...long, price: 3410 })!.priceX).toBe(1);
    const loss = trackPosition({ ...long, price: 3387.5 })!;
    expect(loss.pctToStop).toBeCloseTo(50, 10);
    expect(loss.inProfit).toBe(false);
    expect(trackPosition({ ...long, price: 3300 })!.priceX).toBe(0);
  });
  it('reads the same way for a short (profit on the right)', () => {
    const s = { side: 'short' as const, entry: 3390, stop: 3395, target: 3380 };
    const t = trackPosition({ ...s, price: 3385 })!;
    expect(t.inProfit).toBe(true);
    expect(t.pctToTarget).toBeCloseTo(50, 10);
    expect(t.entryX).toBeCloseTo(5 / 15, 10);
    expect(trackPosition({ ...s, price: 3393 })!.pctToStop).toBeCloseTo(60, 10);
  });
  it('is null for a nonsensical trade and tolerates a missing price', () => {
    expect(trackPosition({ side: 'long', entry: 100, stop: 105, target: 110, price: 100 })).toBeNull();
    const t = trackPosition({ ...long, price: null })!;
    expect(t.priceX).toBe(t.entryX);
  });
});

describe('positionLines', () => {
  it('maps an open position to chart lines', () => {
    expect(positionLines({ side: 'short', entryPrice: 10, stopPrice: 11, targetPrice: 8 })).toEqual({ side: 'short', entry: 10, stop: 11, target: 8 });
    expect(positionLines(null)).toBeNull();
    expect(positionLines({ side: 'long', entryPrice: NaN, stopPrice: 1, targetPrice: 2 })).toBeNull();
  });
});

describe('plain-English texts', () => {
  it('explains exits', () => {
    expect(exitReasonText('take_profit')).toBe('Take profit reached');
    expect(exitReasonText('stop_loss')).toBe('Stop loss hit');
    expect(exitReasonText('manual')).toBe('Closed by hand');
    expect(exitReasonText('something_new')).toBe('Something new');
    expect(exitReasonText(null)).toBe('Closed');
  });
  it('turns risk codes into one friendly line and never leaks the code', () => {
    expect(friendlyWhy(['DAILY_LOSS_LIMIT: Rolling 24h realised P&L -4.00 (loss limit -3)'])).toBe('The daily loss limit was reached, so it is resting');
    expect(friendlyWhy(['SPREAD: Spread 0.9 (max 0.5)', 'NET_REWARD: x'])).toBe('The gap between buyers and sellers is too wide right now');
    const unknown = friendlyWhy(['WEIRD_NEW_CODE: whatever'])!;
    expect(unknown).toBe('A safety check did not pass');
    expect(unknown).not.toMatch(/WEIRD/);
    expect(friendlyWhy([])).toBeNull();
    expect(friendlyWhy(undefined)).toBeNull();
  });
  it('says why nothing is open, in order of importance, without raw codes', () => {
    const base = { killSwitch: false, running: true, workerActive: true };
    const d = (over: object) => ({ risk: { tradingAllowed: true, blockers: [] as string[] }, lastDecision: null as null | { allowed: boolean; reasons: string[] }, ...over }) as never;
    expect(waitingNote({ ...base, killSwitch: true, demo: d({}) })).toMatch(/emergency stop/);
    expect(waitingNote({ ...base, running: false, demo: d({}) })).toMatch(/paused/);
    expect(waitingNote({ ...base, demo: d({ risk: { tradingAllowed: false, blockers: ['MAX_TRADES_24H: New trades in rolling 24h: 10 / 10'] } }) })).toBe('Not trading right now: the limit of new trades in 24 hours has been reached.');
    expect(waitingNote({ ...base, demo: d({ lastDecision: { allowed: false, reasons: ['SPREAD: Spread 1 (max 0.5)'] } }) })).toBe('The last setup was skipped: the gap between buyers and sellers is too wide right now.');
    expect(waitingNote({ ...base, demo: d({ lastDecision: { allowed: true, reasons: [] } }) })).toBeNull();
    expect(waitingNote({ ...base, demo: null })).toBeNull();
    expect(whyPhrase(['NOPE: x'])).toBe('a safety check did not pass');
  });
  it('tones', () => {
    expect(toneOf(0.4)).toBe('win');
    expect(toneOf(-0.4)).toBe('loss');
    expect(toneOf(0)).toBe('flat');
    expect(toneOf(null)).toBe('flat');
  });
});

describe('IST day and today from trades', () => {
  // 2026-10-19 20:00 UTC = 2026-10-20 01:30 IST
  const now = Date.UTC(2026, 9, 19, 20, 0, 0);
  it('uses the IST calendar day', () => {
    expect(istDayLabel(now)).toBe('2026-10-20');
    expect(istDayStart(now)).toBe(Date.UTC(2026, 9, 19, 18, 30, 0));
  });
  const row = (over: Partial<TradeRow>): TradeRow => ({
    id: 'x', mode: 'demo', status: 'closed', side: 'long', contracts: 20, qtyEth: 0.2, leverage: 50, entryTs: now - 1000, exitTs: now - 500, entryPrice: 1, exitPrice: 2,
    exitReason: 'take_profit', grossPnl: 2, fees: 0.8, netPnl: 1.2, netPnlInr: 100, holdMs: 500, regime: null, ...over,
  });
  it('counts only trades closed today and splits wins and losses', () => {
    const t = todayFromTrades(
      [row({}), row({ netPnl: -2, netPnlInr: -170, fees: 0.8 }), row({ exitTs: istDayStart(now) - 1 }), row({ status: 'open', exitTs: null }), row({ netPnl: 0, netPnlInr: 0 })],
      now, 500, 10,
    );
    expect(t).toMatchObject({ day: '2026-10-20', trades: 3, wins: 1, losses: 1, goalInr: 500, tradesLimit: 10 });
    expect(t.netPnlUsd).toBeCloseTo(-0.8, 10);
    expect(t.netPnlInr).toBeCloseTo(-70, 10);
    expect(t.feesUsd).toBeCloseTo(2.4, 10);
  });
  it('goal progress is clamped and a loss counts as zero', () => {
    expect(goalProgress(250, 500)).toBe(0.5);
    expect(goalProgress(900, 500)).toBe(1);
    expect(goalProgress(-30, 500)).toBe(0);
    expect(goalProgress(10, 0)).toBe(0);
  });
});

describe('older backend tolerance', () => {
  it('seeds chart candles from spark and drops the minute that is still forming', () => {
    const now = 10 * 60_000 + 20_000;
    const c = seedCandlesFromSpark([[7 * 60_000, 100], [8 * 60_000, 102], [9 * 60_000, 101], [10 * 60_000, 103]], now);
    expect(c.map((x) => x.t)).toEqual([7 * 60_000, 8 * 60_000, 9 * 60_000]);
    expect(c[1]).toMatchObject({ o: 100, c: 102, h: 102, l: 100 });
    expect(c[2]).toMatchObject({ o: 102, c: 101, h: 102, l: 101 });
    expect(seedCandlesFromSpark(undefined, now)).toEqual([]);
  });
  it('slim snapshots get the last full chart series back; full ones pass through', () => {
    const prev = { spark: [[1, 2]], market: { quote: null, candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }] } } as unknown as BotState;
    const slim = { slim: true, spark: [], market: { quote: null, candles: [] }, now: 5 } as unknown as BotState;
    const m = mergeSlimState(prev, slim);
    expect(m.spark).toEqual([[1, 2]]);
    expect(m.market?.candles).toHaveLength(1);
    expect(m.slim).toBeUndefined();
    const full = { spark: [[9, 9]], market: { quote: null, candles: [] }, now: 6 } as unknown as BotState;
    expect(mergeSlimState(prev, full)).toBe(full);
    expect(mergeSlimState(null, { slim: true, spark: [], now: 1 } as unknown as BotState).spark).toEqual([]);
  });
});

describe('time limit helpers (null = no limit)', () => {
  const settings = (hold: number | null, policy: string, waiver = false) =>
    ({ exits: { maxHoldMinutes: hold, timeExitPolicy: policy }, execution: { exitFeeWaiver: { enabled: waiver } } }) as never;
  it('no limit when unset or when the policy is none', () => {
    expect(effectiveMaxHoldMinutes(settings(null, 'none'))).toBeNull();
    expect(effectiveMaxHoldMinutes(settings(45, 'none'))).toBeNull();
    expect(effectiveMaxHoldMinutes(settings(45, 'close_at_market'))).toBe(45);
    expect(effectiveMaxHoldMinutes(settings(45, 'close_at_market', true))).toBe(28.5);
  });
  it('scalperView never yields NaN or Infinity', () => {
    const state = (econ: unknown) => ({ settings: { exits: { maxHoldMinutes: null, timeExitPolicy: 'none' }, execution: {} }, economics: econ, live: {} }) as unknown as BotState;
    const v = scalperView(state({ scalper: { assumed: false, effective: false, liveEffective: false, windowMinutes: 30, safetyMarginSeconds: 90, effectiveMaxHoldMinutes: null } }), 'demo');
    expect(v).toMatchObject({ assumed: false, effectiveMaxHoldMin: null, configuredMaxHoldMin: null, hasTimeLimit: false, clamped: false });
    const old = scalperView(state(null), 'demo');
    expect(old.effectiveMaxHoldMin).toBeNull();
    expect(old.assumed).toBe(false);
  });
});

describe('format helpers', () => {
  it('whole rupees and signed rupees', () => {
    expect(inrWhole(1234.4)).toBe('₹1,234');
    expect(inrWhole(-70.2)).toBe('−₹70');
    expect(inrWhole(-0.3)).toBe('₹0');
    expect(signedInr(101.6)).toBe('+₹102');
    expect(signedInr(-0.2)).toBe('₹0');
    expect(signedInr(null)).toBe('—');
  });
  it('day labels', () => {
    const now = new Date(2026, 9, 19, 15, 0, 0).getTime();
    expect(dayTime(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe('Today, 09:05');
    expect(dayTime(new Date(2026, 9, 18, 23, 10).getTime(), now)).toBe('Yesterday, 23:10');
    expect(dayTime(new Date(2026, 9, 12, 9, 0).getTime(), now)).toMatch(/^12 Oct, 09:00$/);
    expect(dayTime(null, now)).toBe('—');
    expect(clockTime(null)).toBe('—');
  });
});
