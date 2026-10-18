import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MockDeltaExchange } from '@cryptoalgo/delta/mock';
import { reduceOnlyMarket } from '@cryptoalgo/delta';
import { buildApi } from '../src/api';
import { loadCandles, runBacktestJob } from '../src/services/backtestService';
import { arm, closeSharedDb, makeHarness, signalAt, type Harness } from './harness';

/**
 * Delta "Scalper Offer": no closing fee when a position is closed within 30 minutes.
 * Everything here runs against the LOCAL mock exchange (which models the offer when asked to) and the demo
 * simulator. Nothing is verified against the real exchange.
 */

const MIN = 60_000;
const T = Date.UTC(2026, 5, 1, 10, 0, 0);
let h: Harness;
let apps: Awaited<ReturnType<typeof buildApi>>[] = [];
let ip = 0;
const nextIp = () => `10.9.${(ip >> 8) & 255}.${(ip++ & 255) || 1}`;

/** Boot a harness whose mock exchange does / does not model the offer, with the mock clock tied to the fake clock. */
async function boot(offer: boolean, opts: Parameters<typeof makeHarness>[0] = {}) {
  const ex = new MockDeltaExchange({ heartbeatMs: 100, scalperOffer: { enabled: offer, windowMs: 30 * MIN } });
  await ex.start();
  h = await makeHarness({ ex, ...opts });
  h.ex.setClock(() => h.clock.t);
  return h;
}

/** Settings that isolate the net-reward gates (no loss streak / cooldown interference from earlier trades). */
const isolate = (limits: Record<string, number> = {}) => ({ limits: { maxConsecutiveLosses: 50, cooldownMinutesAfterLoss: 0, ...limits } });

const enter = (candleTime = T, side: 'long' | 'short' = 'long') => h.rt.live.tryEnter(signalAt(candleTime, side), h.feed.getQuote()!);
const advance = (ms: number) => {
  h.clock.t += ms;
  h.feed.push(2999.95, 3000.05); // fresh quote at the new time (stale-data guard)
};
const monitorQuote = () => ({ ts: h.clock.t, bid: 3000, ask: 3000.1, last: 3000.05 });
const lastTrade = async () => (await h.rt.repos.listTrades('live'))[0];
const attention = async () => (await h.rt.repos.getBotState(true)).attention.join(' | ');

async function adminApi() {
  const app = await buildApi(h.rt);
  apps.push(app);
  h.rt.bot.workerActive = true;
  const token = ((await app.auth.login('admin', 'correct horse battery', nextIp())) as any).token as string;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress: nextIp() });
  return { app, call };
}

afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await h?.stop();
});
afterAll(closeSharedDb);

describe('live: a close inside the window under the offer (S1/S2)', () => {
  it('(a) pays only the entry fee, books exchange-reported P&L, and CONFIRMS the offer', async () => {
    await boot(true);
    await arm(h);
    expect((await enter()).allowed).toBe(true);
    expect(h.rt.live.waiver.status).toBe('unverified');
    advance(10 * MIN);
    await h.rt.live.closeNow('manual');

    const t = await lastTrade();
    expect(t.status).toBe('closed');
    expect(t.exitFee).toBe(0);
    expect(t.exitFeeSaved).toBeGreaterThan(0.3); // ~ the taker fee a normal close would have cost
    expect(t.netPnl).toBeCloseTo(t.grossPnl! - t.entryFee! + t.funding!, 8);
    expect(t.fees).toBeCloseTo(t.entryFee!, 8);
    expect(h.ex.balance).toBeCloseTo(1000 + t.netPnl!, 6); // the exchange agrees with the reported P&L
    expect(h.rt.live.waiver).toMatchObject({ status: 'confirmed', confirmedCount: 1 });
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ tradeId: t.id, expectedWaived: true, exitFeeUsd: 0 });
    expect(h.rt.live.waiver.lastCheck!.holdMs).toBeCloseTo(10 * MIN, -3);
    expect(h.rt.live.waiverEffective()).toBe(true);
    expect((await h.rt.repos.listAudit(10, 'scalper_offer_confirmed')).length).toBe(1);
    expect(await attention()).not.toMatch(/closing fee/i);
    // the doc is persisted
    expect(await h.rt.repos.getDoc('live_waiver')).toMatchObject({ status: 'confirmed', confirmedCount: 1 });
  });

  it('an exchange-side take-profit inside the window (found by reconcile) is verified the same way', async () => {
    await boot(true);
    await arm(h);
    await enter();
    const pos = h.rt.live.position!;
    h.clock.t += 6 * MIN;
    h.ex.setQuote(pos.targetPrice + 0.1, pos.targetPrice + 0.2);
    await h.rt.live.reconcile();
    const t = await lastTrade();
    expect(t.exitReason).toBe('take_profit');
    expect(t.exitFee).toBe(0);
    expect(t.exitFeeSaved).toBeGreaterThan(0);
    expect(t.netPnl).toBeCloseTo((pos.targetPrice - pos.entryPrice) * 0.2 - t.entryFee!, 6);
    expect(h.rt.live.waiver.status).toBe('confirmed');
  });

  it('(b) a closing fee on an eligible trade => not_applied, audited, flagged, and entries now need full-fee economics', async () => {
    await boot(false); // this mock does NOT model the offer: it charges the closing fee
    await arm(h);
    // gates chosen so a signal passes only with the waiver: net reward 0.63 (waiver) vs 0.48 (full fees), net R:R 0.61 vs 0.35
    await h.rt.updateSettings(isolate({ minExpectedNetRewardUsd: 0.55, minNetRewardRisk: 0.5 }), 'test', 'admin');
    const first = await enter(T);
    expect(first.allowed, JSON.stringify(first)).toBe(true); // passes while the waiver is merely assumed
    advance(5 * MIN);
    await h.rt.live.closeNow('manual');

    const t = await lastTrade();
    expect(t.exitFee).toBeGreaterThan(0.1); // the exchange charged it
    expect(t.exitFeeSaved).toBe(0);
    expect(t.netPnl).toBeCloseTo(t.grossPnl! - t.entryFee! - t.exitFee!, 8);
    expect(h.rt.live.waiver.status).toBe('not_applied');
    expect(h.rt.live.waiver.confirmedCount).toBe(0);
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ tradeId: t.id, expectedWaived: true });
    expect(h.rt.live.waiver.lastCheck!.exitFeeUsd).toBeCloseTo(t.exitFee!, 8);
    expect(h.rt.live.waiverEffective()).toBe(false);

    const audit = await h.rt.repos.listAudit(10, 'scalper_offer_not_applied');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ tradeId: t.id, windowMinutes: 30, previousStatus: 'unverified' });
    expect(await attention()).toMatch(/Delta charged a closing fee.*full-fee economics/);
    expect(h.logs.join('\n')).not.toContain('test-secret');

    // the same kind of signal is now rejected on the net-reward gates (live fails toward fewer trades)
    const second = await enter(T + MIN);
    expect(second.allowed).toBe(false);
    expect(second.reasons.join(' ')).toMatch(/NET_REWARD/);
    expect(second.reasons.join(' ')).toMatch(/NET_REWARD_RISK/);
    expect(h.rt.live.lastDecision!.checks.find((c) => c.code === 'NET_REWARD')!.value).toBeLessThan(0.55);
    const placed = h.ex.placedOrderRequests.length;
    expect(placed).toBeGreaterThan(0);

    // demo/backtest economics are untouched by the live observation
    expect(h.rt.getSettings().execution.exitFeeWaiver.enabled).toBe(true);

    // admin re-check (reset endpoint) puts it back to "unverified" and the same signal passes again
    const { call } = await adminApi();
    const r = await call('POST', '/api/live/waiver/reset');
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as any).scalper).toMatchObject({ status: 'unverified', confirmedCount: 0, lastCheck: null, effective: true });
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0, lastCheck: null });
    expect((await h.rt.repos.listAudit(10, 'scalper_offer_status_reset')).length).toBe(1);
    const third = await enter(T + MIN);
    expect(third.allowed, JSON.stringify(third)).toBe(true);
    expect(h.ex.placedOrderRequests.length).toBeGreaterThan(placed);
  });

  it('(c) the live time exit fires at 28.5 min (window - safety margin), not at 30', async () => {
    await boot(true);
    await arm(h);
    await enter();
    const t0 = h.clock.t;
    h.clock.t = t0 + 28.4 * MIN;
    await h.rt.live.monitor(monitorQuote());
    expect(h.ex.position.size).toBe(20); // still open 6 s before the clamped limit

    h.clock.t = t0 + 28.5 * MIN + 1000;
    await h.rt.live.monitor(monitorQuote());
    expect(h.ex.position.size).toBe(0); // closed ~90 s BEFORE the 30 minute cut-off
    const t = await lastTrade();
    expect(t.exitReason).toBe('time_exit');
    expect(t.holdMs!).toBeGreaterThan(28.4 * MIN);
    expect(t.holdMs!).toBeLessThan(30 * MIN);
    expect(t.exitFee).toBe(0); // and so it was a free exit
    expect(h.rt.live.waiver.status).toBe('confirmed');
    expect(h.rt.live.scalperView().effectiveMaxHoldMinutes).toBe(28.5);
  });

  it('(d) a close AFTER the window is never counted either way, and is flagged', async () => {
    await boot(true);
    await arm(h);
    await enter();
    advance(31 * MIN); // the close failed / was slow: well past the window
    await h.rt.live.closeNow('manual');
    const t = await lastTrade();
    expect(t.exitFee).toBeGreaterThan(0.1); // the closing fee applies after the window
    expect(t.exitFeeSaved).toBe(0);
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0 });
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ tradeId: t.id, expectedWaived: false });
    expect(await h.rt.repos.listAudit(10, 'scalper_offer_not_applied')).toHaveLength(0);
    expect(await h.rt.repos.listAudit(10, 'scalper_offer_confirmed')).toHaveLength(0);
    expect(await attention()).toMatch(/closed after the Scalper window - closing fee will apply/);
    expect(await attention()).not.toMatch(/Delta charged a closing fee/);
    expect(h.rt.live.waiverEffective()).toBe(true); // economics are not downgraded by a late close
  });

  it('(d) a close that fails at the time exit keeps being retried, and the late close is flagged and not counted', async () => {
    await boot(true);
    await arm(h);
    await enter();
    const t0 = h.clock.t;
    h.clock.t = t0 + 28.6 * MIN;
    h.ex.failNext(/POST \/v2\/orders/, 'http500', 2); // the exit order is rejected twice
    await expect(h.rt.live.monitor(monitorQuote())).rejects.toThrow();
    expect(h.ex.position.size).toBe(20); // still open: a failed close is never silently dropped
    expect(h.rt.live.position).not.toBeNull();

    h.clock.t = t0 + 31 * MIN; // next monitor tick closes it, now too late for the offer
    await h.rt.live.monitor(monitorQuote());
    expect(h.ex.position.size).toBe(0);
    const t = await lastTrade();
    expect(t.exitReason).toBe('time_exit');
    expect(t.exitFee).toBeGreaterThan(0.1);
    expect(await attention()).toMatch(/closed after the Scalper window - closing fee will apply/);
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0 });
  });

  it('a liquidation is never eligible: a closing fee on it does not flip the status', async () => {
    await boot(false);
    await arm(h);
    await enter();
    advance(2 * MIN);
    // the exchange closes the position and reports the fill as a liquidation
    await h.rt.client.placeOrder(reduceOnlyMarket({ productId: 3136, positionSide: 'long', contracts: 20, clientOrderId: 'liq-test' }));
    (h.ex.fills.at(-1) as any).fill_type = 'liquidation';
    await h.rt.live.reconcile();
    const t = await lastTrade();
    expect(t.exitReason).toBe('liquidation');
    expect(t.exitFee).toBeGreaterThan(0.1);
    expect(h.rt.live.waiver.status).toBe('unverified');
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ tradeId: t.id, expectedWaived: false });
    expect(await h.rt.repos.listAudit(10, 'scalper_offer_not_applied')).toHaveLength(0);
  });

  it('Delta discontinuing the offer later is caught: confirmed -> not_applied on the next eligible close', async () => {
    await boot(true);
    await arm(h);
    await h.rt.updateSettings(isolate(), 'test', 'admin');
    await enter(T);
    advance(3 * MIN);
    await h.rt.live.closeNow('manual');
    expect(h.rt.live.waiver).toMatchObject({ status: 'confirmed', confirmedCount: 1 });

    h.ex.opts.scalperOffer = { enabled: false, windowMs: 30 * MIN }; // the offer ends without notice
    advance(MIN);
    expect((await enter(T + 5 * MIN)).allowed).toBe(true);
    advance(3 * MIN);
    await h.rt.live.closeNow('manual');
    expect((await lastTrade()).exitFee).toBeGreaterThan(0.1);
    expect(h.rt.live.waiver).toMatchObject({ status: 'not_applied', confirmedCount: 1 }); // history kept, status flipped
    const audit = await h.rt.repos.listAudit(10, 'scalper_offer_not_applied');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ previousStatus: 'confirmed', confirmedCount: 1 });
    expect(await attention()).toMatch(/Delta charged a closing fee/);
  });

  it('a waived close while status is not_applied is recorded but does not silently re-enable the waiver', async () => {
    await boot(true);
    await arm(h);
    h.rt.live.waiver = { status: 'not_applied', confirmedCount: 0, lastCheck: null, since: h.clock.t };
    await enter();
    advance(3 * MIN);
    await h.rt.live.closeNow('manual');
    expect((await lastTrade()).exitFee).toBe(0);
    expect(h.rt.live.waiver.status).toBe('not_applied'); // only an explicit reset / settings change restores it
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ expectedWaived: true, exitFeeUsd: 0 });
    expect(h.rt.live.waiver.confirmedCount).toBe(0);
  });
});

describe('live: persistence and settings (S1/S2 e, f)', () => {
  it('(e) the waiver state survives a restart (not_applied stays not_applied)', async () => {
    await boot(false);
    await arm(h);
    await enter();
    advance(4 * MIN);
    await h.rt.live.closeNow('manual');
    const before = JSON.parse(JSON.stringify(h.rt.live.waiver));
    expect(before.status).toBe('not_applied');

    const h2 = await h.restart();
    h = h2;
    h2.ex.setClock(() => h2.clock.t);
    expect(JSON.parse(JSON.stringify(h2.rt.live.waiver))).toEqual(before);
    expect(h2.rt.live.waiverEffective()).toBe(false);
    await h2.rt.bot.init();
    expect((h2.rt.bot.snapshot() as any).live.scalper).toMatchObject({ status: 'not_applied', effective: false, assumed: true, effectiveMaxHoldMinutes: 30 });
  });

  it('(e) a confirmed offer also survives a restart', async () => {
    await boot(true);
    await arm(h);
    await enter();
    advance(4 * MIN);
    await h.rt.live.closeNow('manual');
    const before = JSON.parse(JSON.stringify(h.rt.live.waiver));
    expect(before).toMatchObject({ status: 'confirmed', confirmedCount: 1 });
    const h2 = await h.restart();
    h = h2;
    expect(JSON.parse(JSON.stringify(h2.rt.live.waiver))).toEqual(before);
    expect(h2.rt.live.waiverEffective()).toBe(true);
  });

  it('changing any exitFeeWaiver setting resets the status (and audits it); unrelated settings do not', async () => {
    await boot(false);
    await arm(h);
    await enter();
    advance(4 * MIN);
    await h.rt.live.closeNow('manual');
    expect(h.rt.live.waiver.status).toBe('not_applied');

    await h.rt.updateSettings({ limits: { dailyLossLimitUsd: 90 } }, 'a', 'admin');
    expect(h.rt.live.waiver.status).toBe('not_applied');

    await h.rt.updateSettings({ execution: { exitFeeWaiver: { safetyMarginSeconds: 60 } } }, 'a', 'admin');
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0, lastCheck: null });
    expect(h.rt.live.scalperView().effectiveMaxHoldMinutes).toBe(29);
    const audit = await h.rt.repos.listAudit(10, 'scalper_offer_status_reset');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ reason: 'waiver settings changed', previous: { status: 'not_applied' } });
    expect(await h.rt.repos.getDoc('live_waiver')).toMatchObject({ status: 'unverified' });
  });

  it('(f) waiver disabled in settings: no verification, no override, time exit at the configured 30 min', async () => {
    await boot(false);
    await arm(h);
    await h.rt.updateSettings({ execution: { exitFeeWaiver: { enabled: false } } }, 'a', 'admin');
    expect(h.rt.live.waiverEffective()).toBe(false);
    expect(h.rt.live.scalperView()).toMatchObject({ assumed: false, effective: false, status: 'unverified', effectiveMaxHoldMinutes: 30 });

    await enter();
    const t0 = h.clock.t;
    h.clock.t = t0 + 29 * MIN;
    await h.rt.live.monitor(monitorQuote());
    expect(h.ex.position.size).toBe(20); // the clamp is off: 28.5 min does not close it
    h.clock.t = t0 + 30 * MIN + 1000;
    await h.rt.live.monitor(monitorQuote());
    expect(h.ex.position.size).toBe(0);

    const t = await lastTrade();
    expect(t.exitFee).toBeGreaterThan(0.1); // full closing fee, booked from the fill
    expect(t.exitFeeSaved).toBe(0);
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0 }); // nothing was verified
    expect(h.rt.live.waiver.lastCheck).toMatchObject({ expectedWaived: false });
    expect(await h.rt.repos.listAudit(10, 'scalper_offer_not_applied')).toHaveLength(0);
    expect(await attention()).not.toMatch(/Scalper|closing fee/i);
  });

  it('(f) with the waiver disabled the entry gates use full-fee economics from the start', async () => {
    await boot(true);
    await arm(h);
    await h.rt.updateSettings({ ...isolate({ minExpectedNetRewardUsd: 0.55, minNetRewardRisk: 0.5 }), execution: { exitFeeWaiver: { enabled: false } } }, 'a', 'admin');
    const r = await enter();
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/NET_REWARD/);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
  });
});

describe('demo: simulated Scalper Offer (g)', () => {
  const ctx = () => ({ killSwitch: false, apiHealthy: true, lastTickTs: h.clock.t });
  const demoQuote = (ts: number, bid: number, ask = bid + 0.1) => ({ ts, bid, ask, last: (bid + ask) / 2 });

  it('a take-profit inside 30 min pays only the entry fee: exit fee 0, exitFeeSaved > 0, balance = start - entry fee + gross', async () => {
    h = await makeHarness({ startClock: T });
    const d = await h.rt.demo.tryEnter(signalAt(T), h.feed.getQuote()!, ctx());
    expect(d.allowed, JSON.stringify(d.reasons)).toBe(true);
    const pos = h.rt.demo.openPosition!;
    const start = h.rt.demo.account.startingBalanceUsd;
    h.clock.t += 7 * MIN;
    await h.rt.demo.onQuote(demoQuote(h.clock.t, pos.targetPrice + 0.3));
    expect(h.rt.demo.openPosition).toBeNull();

    const t = (await h.rt.repos.listTrades('demo'))[0];
    expect(t.exitReason).toBe('take_profit');
    expect(t.exitFee).toBe(0);
    expect(t.exitFeeSaved).toBeGreaterThan(0.1); // the maker closing fee that was waived
    expect(t.holdMs).toBe(7 * MIN);
    expect(h.rt.demo.account.balanceUsd).toBeCloseTo(start - t.entryFee! + t.grossPnl! + t.funding!, 8);
    expect(t.netPnl).toBeCloseTo(t.grossPnl! - t.entryFee! + t.funding!, 8);
    expect(h.rt.demo.account.totalFeesUsd).toBeCloseTo(t.entryFee!, 8);
  });

  it('a demo time exit lands at 28.5 min and is free; analytics report the fees saved', async () => {
    h = await makeHarness({ startClock: T });
    await h.rt.demo.tryEnter(signalAt(T), h.feed.getQuote()!, ctx());
    const pos = h.rt.demo.openPosition!;
    const start = h.rt.demo.account.startingBalanceUsd;
    await h.rt.demo.onQuote(demoQuote(T + 28.4 * MIN, 3000));
    expect(h.rt.demo.openPosition).not.toBeNull(); // not yet
    await h.rt.demo.onQuote(demoQuote(T + 28.5 * MIN + 1000, 3000));
    expect(h.rt.demo.openPosition).toBeNull();

    const t = (await h.rt.repos.listTrades('demo'))[0];
    expect(t.exitReason).toBe('time_exit');
    expect(t.holdMs!).toBeCloseTo(28.5 * MIN + 1000, -2);
    expect(t.holdMs!).toBeLessThan(30 * MIN);
    expect(t.exitFee).toBe(0);
    expect(t.exitFeeSaved).toBeGreaterThan(0.3); // the taker closing fee
    expect(h.rt.demo.account.balanceUsd).toBeCloseTo(start - pos.entryFee.total + t.grossPnl! + t.funding!, 8);

    const { call } = await adminApi();
    const a = (await call('GET', '/api/analytics?mode=demo')).json() as any;
    expect(a.metrics.feesSavedUsd).toBeCloseTo(t.exitFeeSaved!, 5); // metrics round to 6 dp
    expect(a.recent[0]).toMatchObject({ exitFee: 0 });
    expect(a.recent[0].exitFeeSaved).toBeGreaterThan(0);
    const trades = (await call('GET', '/api/trades?mode=demo')).json() as any;
    expect(trades.trades[0]).toMatchObject({ exitFee: 0 });
    expect(trades.trades[0].exitFeeSaved).toBeGreaterThan(0);
  });

  it('waiver off: the demo exit pays its full fee and the time exit waits for the configured 30 min', async () => {
    h = await makeHarness({ startClock: T });
    await h.rt.updateSettings({ execution: { exitFeeWaiver: { enabled: false } } }, 'a', 'admin');
    await h.rt.demo.tryEnter(signalAt(T), h.feed.getQuote()!, ctx());
    await h.rt.demo.onQuote(demoQuote(T + 29 * MIN, 3000));
    expect(h.rt.demo.openPosition).not.toBeNull();
    await h.rt.demo.onQuote(demoQuote(T + 30 * MIN + 1000, 3000));
    const t = (await h.rt.repos.listTrades('demo'))[0];
    expect(t.exitReason).toBe('time_exit');
    expect(t.exitFee).toBeGreaterThan(0.3);
    expect(t.exitFeeSaved).toBe(0);
  });
});

describe('snapshot and API shapes (S4, i)', () => {
  it('(i) economics carries the scalper block and the no-waiver tables; live.scalper follows the live status', async () => {
    await boot(false);
    await h.rt.bot.init();
    const { call } = await adminApi();
    const s = (await call('GET', '/api/state')).json() as any;
    const e = s.economics;

    // pre-existing keys are all still there
    for (const k of ['referencePrice', 'contracts', 'stopUsd', 'makerTarget', 'takerTarget', 'breakevenMoveMakerExitUsd', 'breakevenMoveTakerExitUsd', 'rates', 'verifiedSpec']) expect(e, k).toHaveProperty(k);
    expect(e.scalper).toEqual({ assumed: true, effective: true, liveEffective: true, windowMinutes: 30, safetyMarginSeconds: 90, effectiveMaxHoldMinutes: 28.5 });
    expect(e.makerTargetNoWaiver).toHaveLength(3);
    expect(e.takerTargetNoWaiver).toHaveLength(3);
    for (const row of [...e.makerTarget, ...e.makerTargetNoWaiver, ...e.takerTarget, ...e.takerTargetNoWaiver]) {
      expect(Object.keys(row).sort()).toEqual(['fees', 'grossReward', 'moveUsd', 'netReward', 'netRewardRisk', 'requiredWinRate']);
    }
    // $5 target at ~$3000, 0.20 ETH: taker entry fee ~0.354 only (waived) vs + closing fee (no waiver)
    const mid = 1;
    expect(e.takerTarget[mid].fees).toBeCloseTo(0.354, 2);
    expect(e.takerTarget[mid].netReward).toBeCloseTo(0.646, 2);
    expect(e.makerTargetNoWaiver[mid].fees).toBeCloseTo(0.354 + 0.1416, 2);
    expect(e.takerTargetNoWaiver[mid].fees).toBeCloseTo(0.708, 2);
    for (let i = 0; i < 3; i++) {
      expect(e.makerTarget[i].netReward).toBeGreaterThan(e.makerTargetNoWaiver[i].netReward);
      expect(e.takerTarget[i].netReward).toBeGreaterThan(e.takerTargetNoWaiver[i].netReward);
    }
    expect(e.breakevenMoveWaivedUsd).toBeCloseTo(1.77, 2);
    expect(e.breakevenMoveNoWaiverMakerExitUsd).toBeCloseTo(2.48, 2);
    expect(e.breakevenMoveTakerExitUsd).toBeCloseTo(e.breakevenMoveWaivedUsd, 6); // follows the (waived) demo config
    expect(e.breakevenMoveMakerExitUsd).toBeCloseTo(e.breakevenMoveWaivedUsd, 6);

    expect(Object.keys(s.live.scalper).sort()).toEqual(['assumed', 'confirmedCount', 'effective', 'effectiveMaxHoldMinutes', 'lastCheck', 'note', 'safetyMarginSeconds', 'status', 'windowMinutes']);
    expect(s.live.scalper).toMatchObject({ assumed: true, effective: true, status: 'unverified', confirmedCount: 0, lastCheck: null, windowMinutes: 30, safetyMarginSeconds: 90, effectiveMaxHoldMinutes: 28.5 });
    expect(s.live.scalper.note).toMatch(/not yet verified/);
    expect(s.live.scalper.note).toMatch(/Diwali/);

    // after the exchange contradicts the assumption: live gates on full fees, demo/backtest keep the assumption
    await arm(h);
    await enter();
    advance(5 * MIN);
    await h.rt.live.closeNow('manual');
    const s2 = (await call('GET', '/api/state')).json() as any;
    expect(s2.live.scalper).toMatchObject({ assumed: true, effective: false, status: 'not_applied', effectiveMaxHoldMinutes: 30 });
    expect(s2.live.scalper.lastCheck).toMatchObject({ expectedWaived: true });
    expect(s2.live.scalper.note).toMatch(/closing fee/);
    expect(s2.economics.scalper).toMatchObject({ assumed: true, effective: true, liveEffective: false, effectiveMaxHoldMinutes: 28.5 });
    expect(s2.economics.takerTarget[mid].fees).toBeCloseTo(0.354, 2); // main tables = demo config
    expect(s2.attention.join(' ')).toMatch(/Delta charged a closing fee/);

    // trades carry exitFee and exitFeeSaved
    const trades = (await call('GET', '/api/trades?mode=live')).json() as any;
    expect(trades.trades[0]).toHaveProperty('exitFee');
    expect(trades.trades[0]).toHaveProperty('exitFeeSaved');
  });

  it('economics switch with the waiver setting: off => main tables equal the no-waiver tables', async () => {
    await boot(false);
    await h.rt.bot.init();
    await h.rt.updateSettings({ execution: { exitFeeWaiver: { enabled: false } } }, 'a', 'admin');
    const e = h.rt.bot.snapshot().economics as any;
    expect(e.scalper).toEqual({ assumed: false, effective: false, liveEffective: false, windowMinutes: 30, safetyMarginSeconds: 90, effectiveMaxHoldMinutes: 30 });
    expect(e.makerTarget).toEqual(e.makerTargetNoWaiver);
    expect(e.takerTarget).toEqual(e.takerTargetNoWaiver);
    expect(e.breakevenMoveMakerExitUsd).toBeCloseTo(e.breakevenMoveNoWaiverMakerExitUsd, 6);
    expect((h.rt.bot.snapshot().live as any).scalper.note).toMatch(/switched off/);
  });

  it('old trade rows without exit_fee_saved still load (null in the API, 0 in the analytics)', async () => {
    await boot(false);
    const now = h.clock.t;
    await h.db.query(
      `INSERT INTO trades (id, mode, status, side, contracts, qty_eth, leverage, entry_ts, exit_ts, entry_price, exit_price, exit_reason, gross_pnl, entry_fee, exit_fee, fees, net_pnl, net_pnl_inr, hold_ms, regime)
       VALUES ('L-old-l','live','closed','long',20,0.2,50,$1,$2,3000,3001,'take_profit',0.2,0.35,0.14,0.49,-0.29,-25,600000,'range')`,
      [now - 3_600_000, now - 3_000_000],
    );
    const { call } = await adminApi();
    const trades = (await call('GET', '/api/trades?mode=live')).json() as any;
    expect(trades.trades[0]).toMatchObject({ id: 'L-old-l', exitFee: 0.14, exitFeeSaved: null });
    const a = (await call('GET', '/api/analytics?mode=live')).json() as any;
    expect(a.metrics.totalTrades).toBe(1);
    expect(a.metrics.feesSavedUsd).toBe(0);
    // and a closed row is rewritten without losing anything when saved again
    const closed = await h.rt.repos.closedTrades('live');
    expect(closed[0].exitFeeSaved).toBe(0);
  });
});

describe('backtest assumptions (S6)', () => {
  it('states the waiver assumption, the clamped hold, entry-fee-only, and that the Diwali offer is not modelled', async () => {
    h = await makeHarness();
    const candles = await loadCandles('synthetic', 14, null, 'ETHUSD');
    const on = runBacktestJob(candles, h.rt.getSettings(), h.rt.getSpec(), { kind: 'backtest', days: 14 }, 'synthetic') as any;
    expect(on.summary.scalperOffer).toEqual({ enabled: true, windowMinutes: 30, effectiveMaxHoldMinutes: 28.5 });
    expect(on.result.scalperOffer).toEqual(on.summary.scalperOffer);
    const text = on.summary.assumptions.join(' ');
    expect(text).toMatch(/Scalper Offer ASSUMED/);
    expect(text).toMatch(/only the entry fee is paid/);
    expect(text).toMatch(/28\.5 min/);
    expect(text).toMatch(/Diwali.*BTCUSD only.*not modelled/);
    expect(text).not.toMatch(/No exit-fee waiver is assumed/);
    expect(on.summary.costNote.exitFeeWaived).toBe(true);
    expect(on.summary.fullSample.feesSavedUsd).toBeGreaterThanOrEqual(0);
    expect(on.result.trades.every((t: any) => 'exitFee' in t && 'exitFeeSaved' in t)).toBe(true);

    const off = runBacktestJob(candles, h.rt.getSettings(), h.rt.getSpec(), { kind: 'backtest', days: 14, settingsPatch: { execution: { exitFeeWaiver: { enabled: false } } } }, 'synthetic') as any;
    expect(off.summary.scalperOffer).toEqual({ enabled: false, windowMinutes: 30, effectiveMaxHoldMinutes: 30 });
    expect(off.summary.assumptions.join(' ')).toMatch(/waiver is OFF/);
    expect(off.summary.costNote.exitFeeWaived).toBe(false);
    expect(off.summary.costNote.breakevenMoveUsd).toBeGreaterThan(on.summary.costNote.breakevenMoveUsd * 1.3); // entry-only vs entry + maker exit
    expect(off.summary.fullSample.feesSavedUsd).toBe(0);
    // the waiver makes the same strategy cheaper to run
    expect(on.summary.fullSample.fees).toBeLessThan(off.summary.fullSample.fees);
  });
});
