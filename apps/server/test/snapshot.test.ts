import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Candle } from '@cryptoalgo/core';
import { buildApi } from '../src/api';
import { loadCandles, runBacktestJob } from '../src/services/backtestService';
import { MARKET_CANDLES } from '../src/services/bot';
import { IST_OFFSET_MS, istDayLabel, istDayStart, summariseToday } from '../src/services/today';
import { LEGACY_SCALPER, closeSharedDb, makeHarness, signalAt, type Harness } from './harness';

/**
 * The dashboard snapshot (GET /api/state): the additions of the v2 dashboard (state.market, state.demo.today,
 * state.economics.roundTrip), the "no time limit" null-safety, the read rate limits and the cost of building it.
 */

const MIN = 60_000;
// 2026-06-01 23:30 IST = 18:00 UTC
const T = Date.UTC(2026, 5, 1, 18, 0, 0);
let h: Harness;
let apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await h?.stop();
});
afterAll(closeSharedDb);

const ctx = () => ({ killSwitch: false, apiHealthy: true, lastTickTs: h.clock.t });
const demoQuote = (ts: number, bid: number, ask = bid + 0.1) => ({ ts, bid, ask, last: (bid + ask) / 2 });
const snapshot = () => h.rt.bot.snapshot() as any;

/** A runtime that has loaded its bot state (the snapshot needs it); no timers or feeds are started. */
async function boot(opts: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(opts);
  await h.rt.bot.init();
  return h;
}

/** Every number in the document, to prove Infinity / NaN never reach a JSON snapshot (JSON.stringify would turn them into null silently). */
function nonFinite(v: unknown, path = '$', out: string[] = []): string[] {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => nonFinite(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) nonFinite(x, `${path}.${k}`, out);
  return out;
}

/** Open a demo long at the current clock and close it by hitting its target (win) or its stop (loss) `afterMs` later. */
async function demoTrade(kind: 'win' | 'loss', candleTime: number, afterMs = 5 * MIN) {
  h.feed.push(2999.95, 3000.05);
  const d = await h.rt.demo.tryEnter(signalAt(candleTime), h.feed.getQuote()!, ctx());
  expect(d.allowed, JSON.stringify(d.reasons)).toBe(true);
  const pos = h.rt.demo.openPosition!;
  h.clock.t += afterMs;
  await h.rt.demo.onQuote(demoQuote(h.clock.t, kind === 'win' ? pos.targetPrice + 0.3 : pos.stopPrice - 0.6));
  expect(h.rt.demo.openPosition).toBeNull();
  return (await h.rt.repos.listTrades('demo'))[0];
}

describe('IST day helpers', () => {
  it('the IST day starts at 18:30 UTC and is labelled by its IST calendar date', () => {
    const justBefore = Date.UTC(2026, 4, 31, 18, 29, 59, 999); // 23:59:59.999 IST on 31 May
    const start = Date.UTC(2026, 4, 31, 18, 30, 0, 0); //          00:00:00.000 IST on 1 June
    expect(istDayLabel(justBefore)).toBe('2026-05-31');
    expect(istDayLabel(start)).toBe('2026-06-01');
    expect(istDayStart(start)).toBe(start);
    expect(istDayStart(start + 23 * 3_600_000 + 59 * MIN)).toBe(start);
    expect(istDayStart(start + 24 * 3_600_000)).toBe(start + 24 * 3_600_000);
    expect(IST_OFFSET_MS).toBe(5.5 * 3_600_000);
    // UTC midnight is 05:30 IST of the same date
    expect(istDayLabel(Date.UTC(2026, 5, 1, 0, 0, 0))).toBe('2026-06-01');
  });

  it('summariseToday counts only trades closed inside the IST day of "now" (start inclusive, end exclusive)', () => {
    const dayStart = Date.UTC(2026, 4, 31, 18, 30);
    const trade = (exitTs: number, netPnl: number) => ({ exitTs, netPnl, netPnlInr: netPnl * 85, fees: 0.8 });
    const s = summariseToday(
      [trade(dayStart - 1, 1.2), trade(dayStart, 1.2), trade(dayStart + 5 * 3_600_000, -2.1), trade(dayStart + 86_400_000 - 1, 1.2), trade(dayStart + 86_400_000, 1.2), trade(dayStart + 3_600_000, 0)],
      dayStart + 10 * 3_600_000,
      500,
      10,
    );
    expect(s).toEqual({ day: '2026-06-01', trades: 4, wins: 2, losses: 1, netPnlUsd: 0.3, netPnlInr: 25.5, feesUsd: 3.2, goalInr: 500, tradesLimit: 10 });
    expect(summariseToday([], dayStart, 500, 10)).toMatchObject({ trades: 0, wins: 0, losses: 0, netPnlUsd: 0, netPnlInr: 0, feesUsd: 0 });
  });
});

describe('state.demo.today', () => {
  it('a demo trade closed today appears with its net USD and INR, fees and the goal / limit from the settings', async () => {
    h = await boot({ startClock: T });
    expect(snapshot().demo.today).toEqual({ day: '2026-06-01', trades: 0, wins: 0, losses: 0, netPnlUsd: 0, netPnlInr: 0, feesUsd: 0, goalInr: 500, tradesLimit: 10 });

    const t = await demoTrade('win', T);
    expect(t.netPnl!).toBeGreaterThan(0);
    const today = snapshot().demo.today;
    const rate = h.rt.getSettings().execution.usdInrRate;
    expect(today.day).toBe('2026-06-01');
    expect(today).toMatchObject({ trades: 1, wins: 1, losses: 0, goalInr: 500, tradesLimit: 10 });
    expect(today.netPnlUsd).toBeCloseTo(t.netPnl!, 4);
    expect(today.netPnlInr).toBeCloseTo(t.netPnl! * rate, 3);
    expect(today.feesUsd).toBeCloseTo(t.fees!, 4);
    expect(t.exitFee!).toBeGreaterThan(0.1); // brokerage is paid on both legs: the exit was not free
    expect(today.feesUsd).toBeCloseTo(t.entryFee! + t.exitFee!, 4);
    // the goal and the limit follow the settings
    await h.rt.updateSettings({ goals: { dailyProfitInr: 750 }, limits: { maxTradesPer24h: 7 } }, 'a', 'admin');
    expect(snapshot().demo.today).toMatchObject({ goalInr: 750, tradesLimit: 7 });
  });

  it('wins, losses and the total add up; INR follows the configured rate', async () => {
    h = await boot({ startClock: T });
    await h.rt.updateSettings({ limits: { maxConsecutiveLosses: 50, cooldownMinutesAfterLoss: 0 }, execution: { usdInrRate: 90 } }, 'a', 'admin');
    const a = await demoTrade('win', T);
    h.clock.t += MIN;
    const b = await demoTrade('loss', T + 20 * MIN);
    h.clock.t += MIN;
    const c = await demoTrade('win', T + 40 * MIN);
    const today = snapshot().demo.today;
    expect(today).toMatchObject({ trades: 3, wins: 2, losses: 1 });
    expect(today.netPnlUsd).toBeCloseTo(a.netPnl! + b.netPnl! + c.netPnl!, 3);
    expect(today.netPnlInr).toBeCloseTo((a.netPnl! + b.netPnl! + c.netPnl!) * 90, 2);
    expect(b.netPnl!).toBeLessThan(0);
  });

  it('the day rolls over at IST midnight: a trade closed at 23:40 IST is not part of the next day', async () => {
    h = await boot({ startClock: T });
    await h.rt.updateSettings({ limits: { maxConsecutiveLosses: 50, cooldownMinutesAfterLoss: 0 } }, 'a', 'admin');
    const first = await demoTrade('win', T, 10 * MIN); // closed 23:40 IST on 1 June
    expect(snapshot().demo.today).toMatchObject({ day: '2026-06-01', trades: 1, wins: 1 });

    h.clock.t = T + 32 * MIN; // 00:02 IST on 2 June
    const second = await demoTrade('loss', T + 32 * MIN, 3 * MIN); // closed 00:05 IST on 2 June
    expect(second.netPnl!).toBeLessThan(0);
    h.clock.t = T + 40 * MIN; // 00:10 IST
    const today = snapshot().demo.today;
    expect(today.day).toBe('2026-06-02');
    expect(today).toMatchObject({ trades: 1, wins: 0, losses: 1 });
    expect(today.netPnlUsd).toBeCloseTo(second.netPnl!, 4);
    expect(today.netPnlUsd).not.toBeCloseTo(first.netPnl! + second.netPnl!, 2);
    // a quiet new day starts at zero
    h.clock.t = T + 30 * 3_600_000; // 05:30 IST on 3 June
    expect(snapshot().demo.today).toMatchObject({ day: '2026-06-03', trades: 0, netPnlUsd: 0 });
  });

  it('only the CURRENT demo epoch counts: a reset clears today, a restart reloads it from the database', async () => {
    h = await boot({ startClock: T });
    await h.rt.updateSettings({ limits: { maxConsecutiveLosses: 50, cooldownMinutesAfterLoss: 0 } }, 'a', 'admin');
    await demoTrade('win', T);
    expect(snapshot().demo.today.trades).toBe(1);

    // a restart (new runtime over the same database) sees the same day
    h = await h.restart();
    await h.rt.bot.init();
    expect(snapshot().demo.today).toMatchObject({ day: '2026-06-01', trades: 1, wins: 1 });

    // the old epoch's trade stays in the history but no longer counts for the new simulated account
    h.clock.t += MIN;
    await h.rt.demo.reset(500);
    expect(snapshot().demo.today).toMatchObject({ trades: 0, wins: 0, netPnlUsd: 0, feesUsd: 0 });
    expect((await h.rt.repos.listTrades('demo', { since: 0 })).length).toBe(1);
    h = await h.restart();
    await h.rt.bot.init();
    expect(snapshot().demo.today.trades).toBe(0);

    h.clock.t += 10 * MIN;
    await demoTrade('loss', T + 60 * MIN);
    expect(snapshot().demo.today).toMatchObject({ trades: 1, losses: 1 });
  });

  it('an open trade is not a closed trade: it does not count until it ends', async () => {
    h = await boot({ startClock: T });
    await h.rt.demo.tryEnter(signalAt(T), h.feed.getQuote()!, ctx());
    expect(h.rt.demo.openPosition).not.toBeNull();
    expect(snapshot().demo.today).toMatchObject({ trades: 0, netPnlUsd: 0 });
  });
});

describe('state.market', () => {
  const candles = (n: number, endBucket: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const t = endBucket - (n - i) * MIN;
      const c = 3000 + i * 0.01;
      return { t, o: c - 0.02, h: c + 0.5, l: c - 0.5, c, v: 10 + i };
    });

  it('carries the quote and at most 180 closed 1m candles, oldest first, in the web contract shape', async () => {
    h = await boot({ startClock: T });
    const bucket = Math.floor(T / MIN) * MIN;
    h.feed.candles = candles(600, bucket);
    const m = snapshot().market;
    expect(MARKET_CANDLES).toBe(180);
    expect(m.candles).toHaveLength(180);
    expect(m.candles[0].t).toBe(h.feed.candles[600 - 180].t);
    expect(m.candles[179]).toEqual({ t: bucket - MIN, o: expect.any(Number), h: expect.any(Number), l: expect.any(Number), c: h.feed.candles[599].c, v: h.feed.candles[599].v });
    for (let i = 1; i < m.candles.length; i++) expect(m.candles[i].t).toBe(m.candles[i - 1].t + MIN); // strictly ascending, one minute apart
    expect(Object.keys(m.candles[0]).sort()).toEqual(['c', 'h', 'l', 'o', 't', 'v']);
    expect(m.quote).toMatchObject({ bid: 2999.95, ask: 3000.05, last: 3000 });
    expect(m.forming).toBeUndefined();
  });

  it('fewer than 180 candles are all returned; none is fine too', async () => {
    h = await boot({ startClock: T });
    expect(snapshot().market.candles).toEqual([]);
    const bucket = Math.floor(T / MIN) * MIN;
    h.feed.candles = candles(42, bucket);
    expect(snapshot().market.candles).toHaveLength(42);
    h.feed.candles = candles(180, bucket);
    expect(snapshot().market.candles).toHaveLength(180);
    h.feed.candles = candles(181, bucket);
    expect(snapshot().market.candles).toHaveLength(180);
    expect(snapshot().market.candles[0].t).toBe(h.feed.candles[1].t);
  });

  it('a newly closed candle shows up at once (the cached array is rebuilt when the minute rolls)', async () => {
    h = await boot({ startClock: T });
    const bucket = Math.floor(T / MIN) * MIN;
    h.feed.candles = candles(60, bucket);
    const before = snapshot().market.candles;
    expect(snapshot().market.candles).toBe(before); // unchanged minute: the very same array, nothing rebuilt per poll
    h.feed.candles = [...h.feed.candles, { t: bucket, o: 3001, h: 3002, l: 3000, c: 3001.5, v: 5 }];
    const after = snapshot().market.candles;
    expect(after).toHaveLength(61);
    expect(after[60]).toEqual({ t: bucket, o: 3001, h: 3002, l: 3000, c: 3001.5, v: 5 });
  });

  it('the forming candle follows the newest quote inside its own minute and is left alone otherwise', async () => {
    h = await boot({ startClock: T + 20_000 });
    const bucket = Math.floor(h.clock.t / MIN) * MIN;
    h.feed.candles = candles(10, bucket);
    h.feed.forming = { t: bucket, o: 3000, h: 3001, l: 2999, c: 3000.5, v: 7 };
    h.feed.push(3010.95, 3011.05); // last = 3011
    const m = snapshot().market;
    expect(m.forming).toEqual({ t: bucket, o: 3000, h: 3011, l: 2999, c: 3011, v: 7 });
    expect(h.feed.forming.c).toBe(3000.5); // the feed's own object is not mutated

    h.feed.forming = { t: bucket - MIN, o: 3000, h: 3001, l: 2999, c: 3000.5, v: 7 }; // a quote from another minute does not move it
    expect(snapshot().market.forming).toEqual({ t: bucket - MIN, o: 3000, h: 3001, l: 2999, c: 3000.5, v: 7 });
  });

  it('survives JSON: forming is absent (not null) without a forming candle', async () => {
    h = await boot({ startClock: T });
    h.feed.candles = candles(5, Math.floor(T / MIN) * MIN);
    const wire = JSON.parse(JSON.stringify(snapshot())) as any;
    expect(Object.keys(wire.market).sort()).toEqual(['candles', 'quote']);
    expect(wire.market.candles).toHaveLength(5);
  });
});

describe('state.economics.roundTrip', () => {
  it('is the plain taker + taker brokerage with GST at the current price: ~0.80 USD for 0.20 ETH at ETH 3,390', async () => {
    h = await boot({ startClock: T });
    h.feed.push(3389.95, 3390.05);
    const e = snapshot().economics;
    const spec = h.rt.getSpec();
    const gst = h.rt.getSettings().execution.gstRate;
    const rt = e.roundTrip;
    expect(Object.keys(rt).sort()).toEqual(['entryFeeUsd', 'exitFeeUsd', 'notionalUsd', 'priceUsd', 'qtyEth', 'totalFeeUsd']);
    expect(rt.priceUsd).toBeCloseTo(3390, 6);
    expect(rt.qtyEth).toBeCloseTo(0.2, 9);
    expect(rt.notionalUsd).toBeCloseTo(678, 6);
    const leg = 678 * (h.rt.getSettings().execution.takerFeeRate ?? spec.takerFeeRate) * (1 + gst);
    expect(rt.entryFeeUsd).toBeCloseTo(leg, 6);
    expect(rt.exitFeeUsd).toBeCloseTo(leg, 6); // the closing leg is NOT free
    expect(rt.totalFeeUsd).toBeCloseTo(2 * leg, 6);
    expect(rt.totalFeeUsd).toBeCloseTo(0.8, 2); // the operator's figure; it follows the fee rates, nothing is hard-coded
  });

  it('is the same with the dormant Scalper Offer switched on (the waiver is never applied to this figure)', async () => {
    h = await boot({ startClock: T, seedSettings: LEGACY_SCALPER });
    h.feed.push(3389.95, 3390.05);
    const rt = snapshot().economics.roundTrip;
    expect(rt.exitFeeUsd).toBeGreaterThan(0.39);
    expect(rt.totalFeeUsd).toBeCloseTo(0.8, 2);
  });

  it('economics (and so roundTrip) is null while there is no quote; it never carries NaN', async () => {
    h = await boot({ startClock: T });
    h.feed.q = null;
    expect(snapshot().economics).toBeNull();
  });

  it('the main fee tables use full brokerage by default and ignore a waiver that a missing time limit cannot guarantee', async () => {
    h = await boot({ startClock: T });
    const e = snapshot().economics;
    expect(e.scalper).toMatchObject({ assumed: false, effective: false, effectiveMaxHoldMinutes: null });
    expect(e.makerTarget).toEqual(e.makerTargetNoWaiver);
    // waiver switched on but still no time limit: estimates keep the full closing fee
    await h.rt.updateSettings({ execution: { exitFeeWaiver: { enabled: true } } }, 'a', 'admin');
    const e2 = snapshot().economics;
    expect(e2.scalper).toMatchObject({ assumed: true, effective: false, effectiveMaxHoldMinutes: null });
    expect(e2.takerTarget).toEqual(e2.takerTargetNoWaiver);
  });
});

describe('JSON safety of "no time limit" (null, never Infinity or NaN)', () => {
  it('the default snapshot holds only finite numbers and reports the missing limit as null', async () => {
    h = await boot({ startClock: T });
    h.feed.candles = Array.from({ length: 30 }, (_, i) => ({ t: Math.floor(T / MIN) * MIN - (30 - i) * MIN, o: 3000, h: 3001, l: 2999, c: 3000, v: 1 }));
    const s = snapshot();
    expect(nonFinite(s)).toEqual([]);
    expect(s.settings.exits.maxHoldMinutes).toBeNull();
    expect(s.settings.exits.timeExitPolicy).toBe('none');
    expect(s.settings.execution.exitFeeWaiver.enabled).toBe(false);
    expect(s.economics.scalper.effectiveMaxHoldMinutes).toBeNull();
    expect(s.live.scalper.effectiveMaxHoldMinutes).toBeNull();
    const wire = JSON.parse(JSON.stringify(s));
    expect(wire.settings.exits.maxHoldMinutes).toBeNull();
    expect(wire.economics.scalper.effectiveMaxHoldMinutes).toBeNull();
  });

  it('a configured limit is a plain number, with and without the waiver clamp; the activation summary follows', async () => {
    h = await boot({ startClock: T, seedSettings: LEGACY_SCALPER });
    const s = snapshot();
    expect(nonFinite(s)).toEqual([]);
    expect(s.economics.scalper.effectiveMaxHoldMinutes).toBe(28.5);
    expect(s.live.scalper.effectiveMaxHoldMinutes).toBe(28.5);
    const pre = await h.rt.activation.preflight('admin');
    expect(nonFinite(pre.summary)).toEqual([]);
    expect(pre.summary.maxHoldMinutes).toBe(30);
    expect(pre.summary.scalperOffer.effectiveMaxHoldMinutes).toBe(28.5);
  });

  it('the activation summary of the default settings carries null and says there is no time limit', async () => {
    h = await boot({ startClock: T });
    const pre = await h.rt.activation.preflight('admin');
    expect(nonFinite(pre)).toEqual([]);
    expect(pre.summary.maxHoldMinutes).toBeNull();
    expect(pre.summary.scalperOffer.effectiveMaxHoldMinutes).toBeNull();
    expect(pre.summary.holdNote).toMatch(/no time limit.*funding payments/i);
  });
});

describe('backtest notes with no time limit', () => {
  it('say brokerage is paid on both legs and that there is no time limit; the limit is null and every number is finite', async () => {
    h = await boot({ startClock: T });
    const candles = await loadCandles('synthetic', 14, null, 'ETHUSD');
    const r = runBacktestJob(candles, h.rt.getSettings(), h.rt.getSpec(), { kind: 'backtest', days: 14 }, 'synthetic') as any;
    expect(r.summary.scalperOffer).toEqual({ enabled: false, windowMinutes: 30, effectiveMaxHoldMinutes: null });
    const text = r.summary.assumptions.join(' ');
    expect(text).toMatch(/paid on BOTH legs/);
    expect(text).toMatch(/no time limit/i);
    expect(text).toMatch(/Funding payments are not modelled/);
    expect(text).not.toMatch(/Scalper Offer ASSUMED|only the entry fee is paid/);
    expect(r.summary.costNote.exitFeeWaived).toBe(false);
    // taker + taker at the reference price, nothing waived: about twice the entry fee
    expect(r.summary.costNote.roundTripFeeUsd).toBeCloseTo(2 * r.summary.costNote.entryFeeUsd, 4);
    expect(nonFinite(r.summary.scalperOffer)).toEqual([]);
    expect(nonFinite(r.summary.costNote)).toEqual([]);
    expect(r.result.trades.length).toBeGreaterThan(0);
    expect(r.result.trades.every((t: any) => t.exitReason !== 'time_exit')).toBe(true); // nothing is closed for time
    expect(r.result.trades.every((t: any) => t.exitFee > 0 && t.exitFeeSaved === 0)).toBe(true); // every exit paid its fee
  }, 60_000);

  it('a configured limit is still honoured by the backtest and named in the notes', async () => {
    h = await boot({ startClock: T });
    const candles = await loadCandles('synthetic', 14, null, 'ETHUSD');
    const r = runBacktestJob(candles, h.rt.getSettings(), h.rt.getSpec(), { kind: 'backtest', days: 14, settingsPatch: { exits: { maxHoldMinutes: 20, timeExitPolicy: 'close_at_market' } } }, 'synthetic') as any;
    expect(r.summary.scalperOffer.effectiveMaxHoldMinutes).toBe(20);
    expect(r.summary.assumptions.join(' ')).toMatch(/after 20\.0 minutes is closed at the market price/);
    expect(r.result.trades.every((t: any) => t.holdMs <= 20 * MIN + MIN)).toBe(true);
  }, 60_000);
});

describe('read endpoints can be polled every second by several open tabs (S4)', () => {
  async function login(app: Awaited<ReturnType<typeof buildApi>>, ip = '10.7.0.1') {
    return ((await app.auth.login('admin', 'correct horse battery', ip)) as any).token as string;
  }

  it('2 tabs polling state + trades every second (7200 reads an hour) from ONE shared IP are never limited', async () => {
    h = await boot({ startClock: T });
    const app = await buildApi(h.rt);
    apps.push(app);
    const token = await login(app);
    const get = (url: string, ip = '203.0.113.7') => app.inject({ method: 'GET', url, remoteAddress: ip, headers: { authorization: `Bearer ${token}` } });
    // 1500 reads inside the same minute are well above two tabs polling at 1 Hz (240/min); the old global limit was 600/min
    const codes = new Set<number>();
    for (let i = 0; i < 1500; i++) codes.add((await get(i % 2 ? '/api/state' : '/api/trades?mode=demo&limit=20')).statusCode);
    expect([...codes]).toEqual([200]);
  }, 60_000);

  it('anonymous or invalid-token callers stay on a small per-IP limit; a signed-in user on another IP is unaffected', async () => {
    h = await boot({ startClock: T });
    const app = await buildApi(h.rt);
    apps.push(app);
    const token = await login(app);
    const anon = (ip: string, auth?: string) => app.inject({ method: 'GET', url: '/api/state', remoteAddress: ip, headers: auth ? { authorization: auth } : {} });
    let limited = 0;
    for (let i = 0; i < 160; i++) if ((await anon('198.51.100.9')).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(30); // 120 per minute, the rest are refused
    let forged = 0;
    for (let i = 0; i < 160; i++) if ((await anon('198.51.100.10', 'Bearer not.a.real.token')).statusCode === 429) forged++;
    expect(forged).toBeGreaterThan(30);
    expect((await app.inject({ method: 'GET', url: '/api/state', remoteAddress: '198.51.100.11', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  }, 60_000);

  it('login and state-changing routes keep their strict limits', async () => {
    h = await boot({ startClock: T });
    const app = await buildApi(h.rt);
    apps.push(app);
    const token = await login(app);
    h.rt.bot.workerActive = true;
    // the login route: at most 10 attempts a minute per IP, even with a valid user
    let loginLimited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery' }, remoteAddress: '198.51.100.20' });
      if (r.statusCode === 429) loginLimited++;
    }
    expect(loginLimited).toBeGreaterThan(0);
    // settings writes: 30 a minute
    let putLimited = 0;
    for (let i = 0; i < 45; i++) {
      const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { goals: { dailyProfitInr: 500 } }, remoteAddress: '198.51.100.21', headers: { authorization: `Bearer ${token}` } });
      if (r.statusCode === 429) putLimited++;
    }
    expect(putLimited).toBeGreaterThan(0);
  }, 60_000);

  it('trades are served from a 1 second shared answer and a trade written by this process drops it at once', async () => {
    h = await boot({ startClock: T });
    const app = await buildApi(h.rt);
    apps.push(app);
    const token = await login(app);
    const trades = async () => ((await app.inject({ method: 'GET', url: '/api/trades?mode=demo', remoteAddress: '10.7.0.5', headers: { authorization: `Bearer ${token}` } })).json() as any).trades as unknown[];
    let reads = 0;
    const orig = h.rt.repos.listTrades.bind(h.rt.repos);
    h.rt.repos.listTrades = ((...a: Parameters<typeof orig>) => {
      reads++;
      return orig(...a);
    }) as typeof orig;
    expect(await trades()).toHaveLength(0);
    await Promise.all([trades(), trades(), trades()]);
    expect(reads).toBe(1); // four pollers, one database read
    await demoTrade('win', T);
    expect(await trades()).toHaveLength(1); // fresh immediately after a write by this process
  });

  it('GET /api/state?slim=1 leaves out only the bulky chart series, for a poll every second', async () => {
    h = await boot({ startClock: T });
    const bucket = Math.floor(T / MIN) * MIN;
    h.feed.candles = Array.from({ length: 200 }, (_, i) => ({ t: bucket - (200 - i) * MIN, o: 3000, h: 3001, l: 2999, c: 3000 + (i % 7), v: 1 }));
    h.feed.forming = { t: bucket, o: 3000, h: 3001, l: 2999, c: 3000.4, v: 3 };
    const app = await buildApi(h.rt);
    apps.push(app);
    const token = await login(app, '10.7.1.1');
    const get = async (url: string) => (await app.inject({ method: 'GET', url, remoteAddress: '10.7.1.1', headers: { authorization: `Bearer ${token}` } })).json() as any;
    const full = await get('/api/state');
    const slim = await get('/api/state?slim=1');
    expect(full.market.candles).toHaveLength(180);
    expect(full.spark.length).toBeGreaterThan(0);
    expect(full.slim).toBeUndefined();
    expect(slim.slim).toBe(true);
    expect(slim.market.candles).toEqual([]);
    expect(slim.spark).toEqual([]);
    expect(slim.market.quote).toEqual(full.market.quote);
    expect(slim.market.forming).toEqual(full.market.forming);
    const strip = (s: any) => {
      const { serverTime: _t, now: _n, slim: _s, spark: _p, market: _m, ...rest } = s;
      return rest;
    };
    expect(strip(slim)).toEqual(strip(full)); // everything else is the same
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(full).length * 0.6);
    expect((await get('/api/state?slim=0')).market.candles).toHaveLength(180);
  });

  it('BENCHMARK: building the snapshot and serving GET /api/state', async () => {
    h = await boot({ startClock: T });
    const bucket = Math.floor(T / MIN) * MIN;
    h.feed.candles = Array.from({ length: 600 }, (_, i) => ({ t: bucket - (600 - i) * MIN, o: 3000, h: 3001, l: 2999, c: 3000 + Math.sin(i / 7), v: 10 }));
    h.feed.forming = { t: bucket, o: 3000, h: 3001, l: 2999, c: 3000.4, v: 3 };
    await demoTrade('win', T);
    h.rt.bot.snapshot(); // warm up

    const N = 2000;
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      h.rt.bot.snapshot();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / N;
    const p99 = times[Math.floor(N * 0.99)];

    const body = JSON.stringify({ ...h.rt.bot.snapshot(), serverTime: Date.now() });
    const S = 500;
    const t1 = performance.now();
    for (let i = 0; i < S; i++) JSON.stringify({ ...h.rt.bot.snapshot(), serverTime: Date.now() });
    const buildAndSerialize = (performance.now() - t1) / S;

    const app = await buildApi(h.rt);
    apps.push(app);
    const token = ((await app.auth.login('admin', 'correct horse battery', '10.7.0.9')) as any).token as string;
    const R = 300;
    const t2 = performance.now();
    for (let i = 0; i < R; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/state', remoteAddress: '10.7.0.9', headers: { authorization: `Bearer ${token}` } });
      if (r.statusCode !== 200) throw new Error(`state ${r.statusCode}`);
    }
    const perRequest = (performance.now() - t2) / R;

    console.log(
      `[bench] snapshot build: avg ${avg.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms (${N} runs); build + JSON.stringify: ${buildAndSerialize.toFixed(3)} ms; ` +
        `GET /api/state in-process (auth + build + serialize): ${perRequest.toFixed(3)} ms; body ${(body.length / 1024).toFixed(1)} KiB`,
    );
    // a regression guard with a wide margin, not a performance claim: a poll every second per tab must stay negligible
    expect(avg).toBeLessThan(25);
    expect(perRequest).toBeLessThan(60);
    expect(body.length).toBeLessThan(200 * 1024);
  }, 120_000);
});
