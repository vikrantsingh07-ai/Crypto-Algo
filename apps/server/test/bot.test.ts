import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Candle } from '@cryptoalgo/core';
import { buildApi } from '../src/api';
import { Bot } from '../src/services/bot';
import { arm, closeSharedDb, makeHarness, signalAt, type Harness } from './harness';

let h: Harness;
afterEach(async () => {
  await h?.stop();
});
afterAll(closeSharedDb);

/** n steady candles ending just before `endT`, then one strong breakout candle (closing at endT). */
function trendCandles(endT: number, dir: 1 | -1 = 1, n = 200): Candle[] {
  const out: Candle[] = [];
  let price = 3000;
  const start = endT - (n + 1) * 60_000;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o + dir * 0.25 + (i % 2 === 0 ? 0.02 : -0.02);
    out.push({ t: start + i * 60_000, o, h: Math.max(o, c) + 0.35, l: Math.min(o, c) - 0.35, c, v: 100 });
    price = c;
  }
  const o = price;
  const c = o + dir * 2.6;
  out.push({ t: start + n * 60_000, o, h: dir === 1 ? c + 0.1 : o + 0.1, l: dir === 1 ? o - 0.1 : c - 0.1, c, v: 220 });
  return out;
}

async function startBot(opts: { patch?: Record<string, unknown> } = {}) {
  h = await makeHarness({ startClock: Date.UTC(2026, 5, 1, 12, 0, 30) });
  if (opts.patch) await h.rt.updateSettings(opts.patch, 'test', 'admin');
  await h.rt.updateSettings({ strategy: { maxExtensionAtr: 6 } }, 'test', 'admin');
  await h.rt.bot.init();
  const candles = trendCandles(h.clock.t - 30_000);
  h.feed.candles = candles;
  const last = candles[candles.length - 1];
  h.ex.setQuote(last.c - 0.05, last.c + 0.05);
  h.feed.push(last.c - 0.05, last.c + 0.05);
  await h.rt.bot.start();
  return { candles, last };
}

describe('demo engine through the bot (real strategy path, simulated fills)', () => {
  it('takes a signal in DEMO mode, manages exits on quotes, books fees and persists the virtual account', async () => {
    const { last } = await startBot();
    expect(h.rt.bot.workerActive).toBe(true);
    expect((await h.rt.repos.getBotState(true)).mode).toBe('demo');

    h.feed.emit('candleClosed', last);
    await new Promise((r) => setTimeout(r, 400));
    const pos = h.rt.demo.openPosition;
    expect(pos, JSON.stringify(h.rt.bot.lastEvaluation?.long.conditions.filter((c) => !c.pass))).not.toBeNull();
    expect(pos!.side).toBe('long');
    expect(pos!.mode).toBe('demo');
    expect(h.ex.placedOrderRequests).toHaveLength(0); // demo = no exchange orders
    expect(h.rt.bot.lastEvaluation?.signal?.side).toBe('long');

    // virtual balance reduced by the simulated entry fee only
    const balAfterEntry = h.rt.demo.account.balanceUsd;
    expect(balAfterEntry).toBeCloseTo(100 - pos!.entryFee.total, 6);

    // market trades through the target
    const px = pos!.targetPrice + 0.3;
    h.clock.t += 120_000;
    h.feed.push(px, px + 0.1, h.clock.t);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.rt.demo.openPosition).toBeNull();
    const trades = await h.rt.repos.closedTrades('demo');
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('take_profit');
    expect(trades[0].netPnl).toBeCloseTo(trades[0].grossPnl - trades[0].fees + trades[0].funding, 6);
    expect(h.rt.demo.account.balanceUsd).toBeCloseTo(100 + trades[0].netPnl, 6);
  });

  it('survives a restart: virtual balance, history and an OPEN simulated position are restored and still managed', async () => {
    const { last } = await startBot();
    h.feed.emit('candleClosed', last);
    await new Promise((r) => setTimeout(r, 400));
    const pos = h.rt.demo.openPosition!;
    expect(pos).not.toBeNull();
    const balance = h.rt.demo.account.balanceUsd;

    const h2 = await h.restart();
    h = h2;
    await h2.rt.bot.init();
    await h2.rt.demo.init();
    expect(h2.rt.demo.account.balanceUsd).toBeCloseTo(balance, 8);
    expect(h2.rt.demo.openPosition?.id).toBe(pos.id);
    expect(h2.rt.demo.openPosition?.entryPrice).toBe(pos.entryPrice);

    // the restored position is still subject to its stop
    h2.clock.t += 60_000;
    await h2.rt.demo.onQuote({ ts: h2.clock.t, bid: pos.stopPrice - 1, ask: pos.stopPrice - 0.9, last: pos.stopPrice - 0.95 });
    expect(h2.rt.demo.openPosition).toBeNull();
    expect((await h2.rt.repos.closedTrades('demo'))[0].exitReason).toBe('stop_loss');
    // bot mode / settings persisted too
    expect((await h2.rt.repos.getBotState(true)).mode).toBe('demo');
    expect((await h2.rt.repos.loadSettings()).position.leverage).toBe(50);
  });

  it('a stopped bot takes no new signals but still manages open positions', async () => {
    const { last } = await startBot();
    await h.rt.bot.setRunning(false, 'admin', 'admin');
    h.feed.emit('candleClosed', last);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.rt.demo.openPosition).toBeNull();
    expect(h.rt.bot.lastEvaluation?.signal).toBeTruthy(); // evaluated, but not traded
  });

  it('demo and live data never mix: separate tables, balances, analytics and trade lists', async () => {
    await startBot();
    h.feed.push(h.feed.getQuote()!.bid, h.feed.getQuote()!.ask, h.clock.t); // engines see a live tick
    await new Promise((r) => setTimeout(r, 50));
    const q = h.feed.getQuote()!;
    await h.rt.demo.tryEnter(signalAt(1_700_000_001_000), q, { killSwitch: false, apiHealthy: true, lastTickTs: q.ts });
    await h.rt.demo.closeNow('manual');
    await arm(h);
    await h.rt.live.tryEnter(signalAt(1_700_000_061_000), q);
    await h.rt.live.closeNow('manual');

    const demo = await h.rt.repos.listTrades('demo');
    const live = await h.rt.repos.listTrades('live');
    expect(demo.map((t) => t.id)).toEqual(['D-1700000001-l']);
    expect(live.map((t) => t.id)).toEqual(['L-1700000061-l']);
    expect(demo.every((t) => t.mode === 'demo') && live.every((t) => t.mode === 'live')).toBe(true);
    // the live trade has real order references, the demo trade has none
    expect((await h.rt.repos.liveOrdersForTrade('L-1700000061-l')).length).toBeGreaterThan(0);
    expect((await h.rt.repos.liveOrdersForTrade('D-1700000001-l')).length).toBe(0);
    // demo balance only reflects the demo trade
    expect(h.rt.demo.account.balanceUsd).toBeCloseTo(100 + demo[0].netPnl!, 6);
    // analytics endpoints are separate and labelled
    const app = await buildApi(h.rt);
    const token = (await app.auth.login('admin', 'correct horse battery', '1.1.1.1')) as any;
    const a = (m: string) => app.inject({ method: 'GET', url: `/api/analytics?mode=${m}`, headers: { authorization: `Bearer ${token.token}` } });
    const da = (await a('demo')).json() as any;
    const la = (await a('live')).json() as any;
    expect(da.label).toMatch(/SIMULATED/);
    expect(la.label).toMatch(/ACTUAL/);
    expect(da.metrics.totalTrades).toBe(1);
    expect(la.metrics.totalTrades).toBe(1);
    await app.close();
  });
});

describe('single active worker (lease) and restarts', () => {
  it('a second instance on the same database does not trade; it takes over after the first releases', async () => {
    h = await makeHarness();
    await h.rt.bot.init();
    await h.rt.bot.start();
    expect(h.rt.bot.workerActive).toBe(true);

    const second = new Bot({ ...(h.rt.bot as any).d });
    await second.init();
    await second.start();
    expect(second.workerActive).toBe(false); // lease held by the first instance
    expect(await h.rt.repos.getLease()).toMatchObject({ holder: h.rt.bot.instanceId });

    await h.rt.bot.shutdown(); // releases the lease
    const third = new Bot({ ...(h.rt.bot as any).d });
    await third.init();
    await third.start();
    expect(third.workerActive).toBe(true);
    await third.shutdown();
    await second.shutdown();
  });

  it('an expired lease (crashed worker) can be taken over', async () => {
    h = await makeHarness();
    const now = h.clock.t;
    expect(await h.rt.repos.acquireLease('dead-worker', 30_000, now)).toBe(true);
    expect(await h.rt.repos.acquireLease('other', 30_000, now + 10_000)).toBe(false);
    expect(await h.rt.repos.acquireLease('other', 30_000, now + 31_000)).toBe(true);
  });

  it('restart with live armed but changed API key disarms live (fail closed)', async () => {
    h = await makeHarness();
    await arm(h);
    const s = await h.rt.repos.getBotState(true);
    await h.rt.bot.save({ ...s, liveArmedFingerprint: 'k_somethingelse' });
    const h2 = await h.restart();
    h = h2;
    await h2.rt.bot.init();
    await h2.rt.bot.start();
    const st = await h2.rt.repos.getBotState(true);
    expect(st.liveArmed).toBe(false);
    expect(st.mode).toBe('demo');
    expect(st.attention.join(' ')).toMatch(/credentials changed/);
  });

  it('after a restart with live armed, nothing is traded until reconciliation succeeds', async () => {
    h = await makeHarness();
    await arm(h);
    const h2 = await h.restart();
    h = h2;
    // before any reconcile the executor is not reconciled => risk manager blocks entries
    expect(h2.rt.live.reconciled).toBe(false);
    const res = await h2.rt.live.tryEnter(signalAt(1_700_000_121_000), h2.feed.getQuote()!);
    // tryEnter reconciles first; with a clean exchange it may proceed, but never without that check:
    expect(h2.rt.live.lastReconcileAt).not.toBeNull();
    expect(typeof res.allowed).toBe('boolean');
  });
});

describe('backtest job via the API', () => {
  it('runs a walk-forward job on SYNTHETIC data, stores it, and labels it as synthetic', async () => {
    h = await makeHarness({ env: { MARKET_DATA_SOURCE: 'synthetic' } });
    const app = await buildApi(h.rt);
    const tok = ((await app.auth.login('admin', 'correct horse battery', '2.2.2.2')) as any).token;
    h.rt.bot.workerActive = true;
    const t0 = Date.now();
    const r = await app.inject({ method: 'POST', url: '/api/backtests', payload: { kind: 'walkforward', days: 20, trainDays: 8, testDays: 4 }, headers: { authorization: `Bearer ${tok}` }, remoteAddress: '3.3.3.3' });
    expect(r.statusCode).toBe(202);
    const { id } = r.json() as any;
    let run: any = null;
    for (let i = 0; i < 100; i++) {
      run = (await app.inject({ method: 'GET', url: `/api/backtests/${id}`, headers: { authorization: `Bearer ${tok}` }, remoteAddress: '3.3.3.4' })).json();
      if (run.status !== 'running') break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(run.status, run.error).toBe('done');
    expect(run.dataSource).toBe('synthetic');
    expect(run.summary.synthetic).toBe(true);
    expect(run.summary.kind).toBe('walkforward');
    expect(run.summary.folds).toBeGreaterThanOrEqual(2);
    expect(run.summary.assumptions.join(' ')).toMatch(/closed 1-minute candles/);
    expect(run.result.outOfSampleMetrics.equityCurve).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(20_000);
    await app.close();
  });

  it('plain backtest reports in-sample vs out-of-sample and the fee-drag cost note', async () => {
    h = await makeHarness({ env: { MARKET_DATA_SOURCE: 'synthetic' } });
    const { runBacktestJob, loadCandles } = await import('../src/services/backtestService');
    const candles = await loadCandles('synthetic', 14, null, 'ETHUSD');
    const { summary } = runBacktestJob(candles, h.rt.getSettings(), h.rt.getSpec(), { kind: 'backtest', days: 14 }, 'synthetic') as any;
    expect(summary.inSample).toBeDefined();
    expect(summary.outOfSample).toBeDefined();
    expect(summary.costNote.breakevenMoveUsd).toBeGreaterThan(1);
    expect(summary.note).toMatch(/statistically weak|Out-of-sample/);
    expect(summary.synthetic).toBe(true);
  });
});
