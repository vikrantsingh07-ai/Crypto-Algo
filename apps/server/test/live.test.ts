import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TIME_EXIT_30, arm, closeSharedDb, makeHarness, signalAt, type Harness } from './harness';
import { EntryRefusedError } from '../src/services/liveExecutor';
import { entryOrder } from '@cryptoalgo/delta';

let h: Harness;
const T = Date.UTC(2026, 5, 1, 10, 0, 0);

async function enter(side: 'long' | 'short' = 'long', candleTime = T, over = {}) {
  const q = h.feed.getQuote()!;
  return h.rt.live.tryEnter(signalAt(candleTime, side, over), q);
}
const openOrders = () => [...h.ex.orders.values()].filter((o) => o.state === 'open' || o.state === 'pending');

beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.stop();
});
afterAll(closeSharedDb);

describe('fresh installation is DEMO with live disabled', () => {
  it('defaults: mode demo, live not armed, kill switch released, initial config as specified', async () => {
    const bot = await h.rt.repos.getBotState(true);
    expect(bot.mode).toBe('demo');
    expect(bot.liveArmed).toBe(false);
    expect(bot.killSwitch).toBe(false);
    const s = h.rt.getSettings();
    expect(s.instrument.symbol).toBe('ETHUSD');
    expect(s.position.leverage).toBe(50);
    expect(s.position.quantityEth).toBe(0.2);
    // v2 defaults: a fixed $10 move, a $5-$8 stop, NO time limit, brokerage on both legs (the Scalper Offer is dormant)
    expect(s.version).toBe(2);
    expect(s.targets.targetMoveMinUsd).toBe(10);
    expect(s.targets.targetMoveMaxUsd).toBe(10);
    expect(s.targets.stopLossMinUsd).toBe(5);
    expect(s.targets.stopLossMaxUsd).toBe(8);
    expect(s.exits.maxHoldMinutes).toBeNull();
    expect(s.exits.timeExitPolicy).toBe('none');
    expect(s.limits.maxTradesPer24h).toBe(10);
    expect(s.goals.dailyProfitInr).toBe(500);
    expect(s.execution.exitFeeWaiver).toEqual({ enabled: false, withinMinutes: 30, safetyMarginSeconds: 90, clampTimeExit: true });
    expect(h.rt.live.waiver).toMatchObject({ status: 'unverified', confirmedCount: 0, lastCheck: null });
    expect(h.rt.live.scalperView()).toMatchObject({ assumed: false, effective: false, effectiveMaxHoldMinutes: null });
    expect(JSON.stringify(h.rt.live.scalperView())).not.toMatch(/Infinity|NaN/);
  });

  it('cannot place a real order while disarmed: entry refused and ZERO orders reach the exchange', async () => {
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/not armed|mode is not live/);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
    expect(h.rt.live.ordersSubmitted).toBe(0);
  });

  it('the order choke point itself refuses opening orders unless mode=live AND armed AND running AND no kill switch', async () => {
    const live: any = h.rt.live;
    const req = entryOrder({ productId: 3136, side: 'long', contracts: 20, limitPrice: 3001, tickSize: 0.05, clientOrderId: 'direct-1' });

    await expect(live.submit(req, 'entry', 'T1')).rejects.toBeInstanceOf(EntryRefusedError); // demo, disarmed

    const s = await h.rt.repos.getBotState(true);
    await h.rt.bot.save({ ...s, mode: 'live' }); // live but not armed
    await expect(live.submit(req, 'entry', 'T1')).rejects.toThrow(/not armed/);

    await h.rt.bot.save({ ...s, mode: 'demo', liveArmed: true }); // armed but demo mode
    await expect(live.submit(req, 'entry', 'T1')).rejects.toThrow(/mode is not live/);

    await h.rt.bot.save({ ...s, mode: 'live', liveArmed: true, killSwitch: true });
    await expect(live.submit(req, 'entry', 'T1')).rejects.toThrow(/kill switch/);

    await h.rt.bot.save({ ...s, mode: 'live', liveArmed: true, running: false });
    await expect(live.submit(req, 'entry', 'T1')).rejects.toThrow(/not running/);

    expect(h.ex.placedOrderRequests).toHaveLength(0);
  });

  it('demo trading uses the virtual account and never contacts the exchange order API', async () => {
    const before = h.ex.requestLog.length;
    h.rt.getSettings();
    const d = await h.rt.demo.tryEnter(signalAt(T), h.feed.getQuote()!, { killSwitch: false, apiHealthy: true, lastTickTs: h.clock.t });
    expect(d.allowed).toBe(true);
    expect(h.rt.demo.openPosition).not.toBeNull();
    expect(h.ex.requestLog.slice(before).filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
    const demoRows = await h.rt.repos.listTrades('demo');
    const liveRows = await h.rt.repos.listTrades('live');
    expect(demoRows).toHaveLength(1);
    expect(liveRows).toHaveLength(0);
  });
});

describe('armed live execution', () => {
  beforeEach(async () => {
    await arm(h);
  });

  it('places an IOC entry, an exchange-side stop and a reduce-only target, and records everything', async () => {
    const res = await enter();
    expect(res, JSON.stringify(res)).toMatchObject({ allowed: true });
    const pos = h.rt.live.position!;
    expect(pos.contracts).toBe(20);
    expect(pos.entryPrice).toBeCloseTo(3000.05, 2);
    expect(h.ex.position.size).toBe(20);
    expect(h.ex.leverage).toBe(50); // leverage set to the configured 50x
    const resting = openOrders();
    expect(resting.map((o) => o.reduce_only)).toEqual([true, true]);
    expect(resting.find((o) => o.stop_order_type === 'stop_loss_order')!.stop_price).toBe(String(pos.stopPrice));
    expect(resting.find((o) => !o.stop_order_type)!.limit_price).toBe(String(pos.targetPrice));
    // entry request shape
    const entryReq = h.ex.placedOrderRequests[0];
    expect(entryReq).toMatchObject({ side: 'buy', size: 20, order_type: 'limit_order', time_in_force: 'ioc', reduce_only: false });
    expect(Number(entryReq.limit_price)).toBeCloseTo(3000.05 + 0.6, 2); // ask + maxSlippage cap
    // persistence
    const rows = await h.rt.repos.listTrades('live');
    expect(rows[0]).toMatchObject({ status: 'open', mode: 'live', contracts: 20 });
    const orders = await h.rt.repos.liveOrdersForTrade(rows[0].id);
    expect(orders.map((o) => o.purpose).sort()).toEqual(['entry', 'stop', 'target']);
    expect(rows[0].entryFee).toBeCloseTo(20 * 0.01 * 3000.05 * 0.0005, 6); // fee comes from the exchange fill
  });

  it('refuses a second entry for the same signal candle (duplicate-order protection) — only one entry is ever sent', async () => {
    await enter();
    const again = await enter();
    expect(again.allowed).toBe(false);
    expect(again.reasons.join(' ')).toMatch(/MAX_OPEN_POSITIONS|DUPLICATE_SIGNAL/);
    expect(h.ex.placedOrderRequests.filter((r) => r.reduce_only === false)).toHaveLength(1);
  });

  it('after the position closes, the SAME signal candle still cannot be traded twice', async () => {
    await enter();
    await h.rt.live.closeNow('manual');
    expect(h.ex.position.size).toBe(0);
    const again = await enter();
    expect(again.allowed).toBe(false);
    expect(again.reasons.join(' ')).toMatch(/DUPLICATE_SIGNAL/);
    expect(h.ex.placedOrderRequests.filter((r) => r.reduce_only === false)).toHaveLength(1);
  });

  it('short entries mirror: sell IOC at bid - cap, stop above, target below', async () => {
    const res = await enter('short');
    expect(res.allowed).toBe(true);
    const pos = h.rt.live.position!;
    expect(h.ex.position.size).toBe(-20);
    expect(pos.stopPrice).toBeGreaterThan(pos.entryPrice);
    expect(pos.targetPrice).toBeLessThan(pos.entryPrice);
    expect(h.ex.placedOrderRequests[0]).toMatchObject({ side: 'sell', time_in_force: 'ioc' });
  });

  it('handles partial fills: protection is sized to what actually filled', async () => {
    h.ex.opts.partialFillRatio = 0.5;
    const res = await enter();
    expect(res.allowed).toBe(true);
    expect(h.ex.position.size).toBe(10);
    expect(h.rt.live.position!.contracts).toBe(10);
    for (const o of openOrders()) expect(o.size).toBe(10);
  });

  it('the risk manager blocks an under-funded entry before any order is built (free-margin check)', async () => {
    h.ex.balance = 1;
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/FREE_MARGIN|MIN_BALANCE/);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
    expect(h.ex.position.size).toBe(0);
  });

  it('an exchange-side rejection (insufficient_margin) leaves no position and marks the trade failed', async () => {
    const { DeltaApiError } = await import('@cryptoalgo/delta');
    (h.rt.client as any).placeOrder = async () => {
      throw new DeltaApiError('rejected', 400, 'insufficient_margin', {}, 'POST /v2/orders', false);
    };
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/ORDER_REJECTED/);
    expect(h.ex.position.size).toBe(0);
    expect((await h.rt.repos.listTrades('live'))[0].status).toBe('failed');
    expect(h.rt.live.position).toBeNull();
  });

  it('IOC that cannot fill inside the slippage cap does nothing', async () => {
    h.ex.setQuote(2999.95, 3000.05);
    h.feed.push(2999.95, 3000.05);
    // exchange moves up right before the order lands: ask beyond our limit cap
    const origPlace = (h.rt.client as any).placeOrder.bind(h.rt.client);
    (h.rt.client as any).placeOrder = async (req: any, p: any) => {
      h.ex.setQuote(3003, 3003.1);
      return origPlace(req, p);
    };
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/NO_FILL/);
    expect(h.ex.position.size).toBe(0);
  });

  it('flattens immediately if the protective stop cannot be placed', async () => {
    h.ex.failNext(/POST \/v2\/orders/, 'http500', 0); // no-op safety
    const origPlace = (h.rt.client as any).placeOrder.bind(h.rt.client);
    let n = 0;
    (h.rt.client as any).placeOrder = async (req: any, p: any) => {
      n++;
      if (req.stop_order_type === 'stop_loss_order') throw new Error('boom: exchange refused stop');
      return origPlace(req, p);
    };
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/STOP_FAILED/);
    expect(h.ex.position.size).toBe(0); // flattened, never left unprotected
    expect(n).toBeGreaterThanOrEqual(3);
    const state = await h.rt.repos.getBotState(true);
    expect(state.attention.join(' ')).toMatch(/Protective stop/);
  });

  it('ambiguous network failure on the entry is resolved by client_order_id lookup — never re-sent', async () => {
    h.ex.failNext(/POST \/v2\/orders/, 'drop-after-process');
    const res = await enter();
    expect(res.allowed).toBe(true); // the order DID execute; we found it, then protected it
    expect(h.ex.placedOrderRequests.filter((r) => r.reduce_only === false)).toHaveLength(1);
    expect(h.ex.position.size).toBe(20);
    expect(openOrders().length).toBe(2);
  });

  it('unknown outcome (request never reached the exchange) blocks trading until reconciliation, without double-submitting', async () => {
    h.ex.failNext(/POST \/v2\/orders/, 'drop-before-process');
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
    expect(h.rt.live.reconciled).toBe(false);
    // reconcile resolves the pending entry: it never reached the exchange => failed, trading resumes
    await h.rt.live.reconcile();
    expect(h.rt.live.reconciled).toBe(true);
    const rows = await h.rt.repos.listTrades('live');
    expect(rows[0].status).toBe('failed');
  });

  it('monitor: with a 30 minute time limit configured, a time exit closes with a reduce-only market order', async () => {
    await h.rt.updateSettings(TIME_EXIT_30, 'a', 'admin');
    await enter();
    h.clock.t += 31 * 60_000;
    h.ex.setClock(() => h.clock.t);
    await h.rt.live.monitor({ ts: h.clock.t, bid: 3001, ask: 3001.1, last: 3001.05 });
    expect(h.ex.position.size).toBe(0);
    const t = (await h.rt.repos.listTrades('live'))[0];
    expect(t.status).toBe('closed');
    expect(t.exitReason).toBe('time_exit');
    expect(openOrders()).toHaveLength(0);
    const exitReq = h.ex.placedOrderRequests.at(-1);
    expect(exitReq).toMatchObject({ reduce_only: true, order_type: 'market_order', side: 'sell' });
  });

  it('default settings have NO time limit: neither the quote monitor nor the quote-independent backstop ever closes for time, the stop still works', async () => {
    h.ex.setClock(() => h.clock.t);
    await enter();
    const pos = h.rt.live.position!;
    expect(h.ex.position.size).toBe(20);
    for (const hours of [1, 3, 5, 30]) {
      h.clock.t += hours * 3_600_000;
      await h.rt.live.timeBackstop();
      await h.rt.live.monitor({ ts: h.clock.t, bid: pos.entryPrice + 0.5, ask: pos.entryPrice + 0.6, last: pos.entryPrice + 0.55 });
      expect(h.rt.live.position, `still open after ${hours} more hours`).not.toBeNull();
      expect(h.ex.position.size).toBe(20);
    }
    // the protective stop is untouched by the missing time limit: price beyond it closes the trade
    await h.rt.live.monitor({ ts: h.clock.t, bid: pos.stopPrice - 2, ask: pos.stopPrice - 1.9, last: pos.stopPrice - 1.95 });
    expect(h.rt.live.position).toBeNull();
    const t = (await h.rt.repos.listTrades('live'))[0];
    expect(t.exitReason).toBe('stop_loss');
    expect(t.holdMs!).toBeGreaterThan(30 * 3_600_000);
  });

  it('exchange-side take-profit fill is detected on reconcile; fees and P&L come from the fills', async () => {
    await enter();
    const pos = h.rt.live.position!;
    h.ex.setQuote(pos.targetPrice + 0.1, pos.targetPrice + 0.2);
    expect(h.ex.position.size).toBe(0);
    await h.rt.live.reconcile();
    const t = (await h.rt.repos.listTrades('live'))[0];
    expect(t.status).toBe('closed');
    expect(t.exitReason).toBe('take_profit');
    const gross = (pos.targetPrice - pos.entryPrice) * 0.2;
    expect(t.grossPnl).toBeCloseTo(gross, 4);
    const entryFee = 20 * 0.01 * pos.entryPrice * 0.0005;
    const exitFee = 20 * 0.01 * pos.targetPrice * 0.0002; // maker
    expect(t.fees).toBeCloseTo(entryFee + exitFee, 5);
    expect(t.netPnl).toBeCloseTo(gross - entryFee - exitFee, 4);
    expect(h.rt.live.position).toBeNull();
    expect(h.rt.live.reconciled).toBe(true);
  });

  it('exchange-side stop fill is detected on reconcile as a stop_loss', async () => {
    await enter();
    const pos = h.rt.live.position!;
    h.ex.setQuote(pos.stopPrice - 0.5, pos.stopPrice - 0.4);
    await h.rt.live.reconcile();
    const t = (await h.rt.repos.listTrades('live'))[0];
    expect(t.exitReason).toBe('stop_loss');
    expect(t.netPnl!).toBeLessThan(0);
  });

  it('tightens to a break-even stop (new stop placed BEFORE the old one is cancelled)', async () => {
    await h.rt.updateSettings({ exits: { maxHoldMinutes: 30, timeExitPolicy: 'breakeven_then_close', breakevenAfterMinutes: 15 } }, 'a', 'admin');
    await enter();
    const pos = h.rt.live.position!;
    h.clock.t += 16 * 60_000;
    const ordersBefore = h.ex.placedOrderRequests.length;
    await h.rt.live.monitor({ ts: h.clock.t, bid: pos.entryPrice + 4.3, ask: pos.entryPrice + 4.4, last: pos.entryPrice + 4.35 });
    const stops = [...h.ex.orders.values()].filter((o) => o.stop_order_type === 'stop_loss_order');
    expect(stops).toHaveLength(2);
    expect(stops.filter((o) => o.state === 'pending')).toHaveLength(1); // only the new one still pending
    expect(h.rt.live.position!.stopPrice).toBeGreaterThan(pos.entryPrice);
    expect(h.ex.placedOrderRequests.length).toBe(ordersBefore + 1);
  });

  it('enforces max 10 entries per rolling 24h on the LIVE path', async () => {
    // isolate this limit from the (separately tested) loss circuit-breaker and cooldown
    await h.rt.updateSettings({ limits: { maxConsecutiveLosses: 50, cooldownMinutesAfterLoss: 0 } }, 'a', 'admin');
    for (let i = 0; i < 10; i++) {
      const r = await enter('long', T + i * 3_600_000 / 4 + i);
      expect(r.allowed, JSON.stringify(r)).toBe(true);
      await h.rt.live.closeNow('manual');
      h.clock.t += 6 * 60_000; // advance past the post-loss cooldown, staying inside 24h
      h.feed.push(2999.95, 3000.05); // fresh quote at the new time (stale-data guard is active)
    }
    const eleventh = await enter('long', T + 99_000_000);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.reasons.join(' ')).toMatch(/MAX_TRADES_24H/);
  });
});

describe('drawdown limit survives restarts', () => {
  it('a restart does not silently clear the live drawdown reference', async () => {
    await arm(h);
    await h.rt.updateSettings({ limits: { maxDrawdownPct: 15 } }, 'a', 'admin');
    await h.rt.live.reconcile(); // records baseline = peak = 1000
    expect(h.rt.live.peakEquityUsd).toBeCloseTo(1000, 2);
    h.ex.balance = 700; // equity fell 30% (limit is 15%)
    const h2 = await h.restart();
    h = h2;
    await h2.rt.live.reconcile();
    expect(h2.rt.live.peakEquityUsd).toBeCloseTo(1000, 2); // peak remembered
    const res = await h2.rt.live.tryEnter(signalAt(1_700_000_300_000), h2.feed.getQuote()!);
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/MAX_DRAWDOWN/);
    // explicit operator reset re-bases it and persists
    await arm(h2);
    await h2.rt.live.resetBaseline();
    const h3 = await h2.restart();
    h = h3;
    await h3.rt.live.loadHistory();
    expect(h3.rt.live.peakEquityUsd).toBeCloseTo(700, 2);
  });
});

describe('private stream and live funding', () => {
  it('account events on the authenticated websocket trigger a reconciliation (REST stays the source of truth)', async () => {
    const { PrivateStream } = await import('../src/services/privateStream');
    let events = 0;
    const ps = new PrivateStream({ endpoints: h.rt.endpoints, creds: h.rt.creds, symbol: () => 'ETHUSD', onEvent: () => events++, logger: h.rt.logger, now: () => Date.now(), minIntervalMs: 50 });
    ps.start();
    for (let i = 0; i < 100 && ps.status().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(ps.status().state).toBe('ready');
    await h.rt.client.placeOrder({ product_id: 3136, side: 'buy', size: 2, order_type: 'market_order', client_order_id: 'ps-1' });
    for (let i = 0; i < 100 && events === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(events).toBeGreaterThan(0);
    expect(ps.status().lastEventAt).not.toBeNull();
    ps.stop();
    expect(ps.status().enabled).toBe(false);
  });

  it('does not connect without credentials', async () => {
    const h2 = await makeHarness({ withCredentials: false, ex: undefined });
    try {
      const { PrivateStream } = await import('../src/services/privateStream');
      const ps = new PrivateStream({ endpoints: h2.rt.endpoints, creds: h2.rt.creds, symbol: () => 'ETHUSD', onEvent: () => {}, logger: h2.rt.logger, now: () => Date.now() });
      ps.start();
      expect(ps.status().enabled).toBe(false);
    } finally {
      await h2.stop();
    }
  });

  it('records realised funding paid while a live position is open into the final trade', async () => {
    await arm(h);
    await enter();
    h.ex.realizedFunding = -0.0123; // funding paid while holding
    await h.rt.live.reconcile();
    expect(h.rt.live.position!.fundingAccrued).toBeCloseTo(-0.0123, 6);
    await h.rt.live.closeNow('manual');
    const t = (await h.rt.repos.listTrades('live'))[0];
    expect(t.funding).toBeCloseTo(-0.0123, 6);
    expect(t.netPnl).toBeCloseTo(t.grossPnl! - t.fees! + t.funding!, 6);
  });
});

describe('restart & recovery', () => {
  it('worker restart adopts the open real position and its protective orders; no duplicate entry', async () => {
    await arm(h);
    await enter();
    const posBefore = h.rt.live.position!;
    const h2 = await h.restart();
    try {
      await h2.rt.live.reconcile();
      expect(h2.rt.live.reconciled).toBe(true);
      expect(h2.rt.live.position?.id).toBe(posBefore.id);
      expect(h2.rt.live.position?.contracts).toBe(20);
      // still exactly one stop and one target on the exchange
      expect([...h2.ex.orders.values()].filter((o) => o.state === 'open' || o.state === 'pending')).toHaveLength(2);
      // restarting did not submit any new opening order
      expect(h2.ex.placedOrderRequests.filter((r) => r.reduce_only === false)).toHaveLength(1);
    } finally {
      h = h2;
    }
  });

  it('restart re-creates a missing protective stop (or flattens) before allowing anything else', async () => {
    await arm(h);
    await enter();
    const stop = [...h.ex.orders.values()].find((o) => o.stop_order_type === 'stop_loss_order')!;
    stop.state = 'cancelled'; // someone cancelled it while we were down
    const h2 = await h.restart();
    try {
      await h2.rt.live.reconcile();
      const stops = [...h2.ex.orders.values()].filter((o) => o.stop_order_type === 'stop_loss_order' && o.state === 'pending');
      expect(stops).toHaveLength(1);
    } finally {
      h = h2;
    }
  });

  it('position closed on the exchange while the worker was down is finalised on restart', async () => {
    await arm(h);
    await enter();
    const pos = h.rt.live.position!;
    h.ex.setQuote(pos.targetPrice + 0.2, pos.targetPrice + 0.3);
    const h2 = await h.restart();
    try {
      await h2.rt.live.reconcile();
      expect(h2.rt.live.position).toBeNull();
      expect((await h2.rt.repos.listTrades('live'))[0].status).toBe('closed');
    } finally {
      h = h2;
    }
  });

  it('an UNTRACKED exchange position fails closed: entries are blocked until an operator resolves it', async () => {
    await arm(h);
    // a manual trade made on the exchange UI
    await h.rt.client.placeOrder({ product_id: 3136, side: 'buy', size: 5, order_type: 'market_order', client_order_id: 'manual-1' });
    await h.rt.live.reconcile();
    expect(h.rt.live.reconciled).toBe(false);
    expect(h.rt.live.reconcileReason).toMatch(/untracked/);
    const placedBefore = h.ex.placedOrderRequests.length;
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/NOT_RECONCILED/);
    expect(h.ex.placedOrderRequests.length).toBe(placedBefore);
    // operator closes the orphan (reduce-only) and trading becomes possible again
    await h.rt.live.closeNow('manual');
    await h.rt.live.reconcile();
    expect(h.rt.live.reconciled).toBe(true);
  });

  it('unreachable exchange => not reconciled => no entries (fail closed)', async () => {
    await arm(h);
    h.ex.failNext(/GET \/v2\/wallet\/balances/, 'http500', 10);
    h.ex.failNext(/GET \/v2\/positions/, 'http500', 10);
    await h.rt.live.reconcile();
    expect(h.rt.live.reconciled).toBe(false);
    const res = await enter();
    expect(res.allowed).toBe(false);
    expect(h.ex.placedOrderRequests.filter((r) => r.reduce_only === false)).toHaveLength(0);
  });
});

describe('kill switch and mode switching', () => {
  it('kill switch: blocks all entries, disarms live, flattens the real position (default policy) and is audited', async () => {
    await arm(h);
    await enter();
    expect(h.ex.position.size).toBe(20);
    const r = await h.rt.bot.engageKillSwitch('admin', 'admin', '1.2.3.4', 'test');
    expect(r.action).toMatch(/flattened/);
    expect(h.ex.position.size).toBe(0);
    const st = await h.rt.repos.getBotState(true);
    expect(st).toMatchObject({ killSwitch: true, liveArmed: false, mode: 'demo' });
    const audit = await h.rt.repos.listAudit(20, 'kill_switch_engaged');
    expect(audit[0]).toMatchObject({ actor: 'admin', success: true, ip: '1.2.3.4' });
    // neither engine will open anything now
    const demo = await h.rt.demo.tryEnter(signalAt(T + 5000), h.feed.getQuote()!, { killSwitch: true, apiHealthy: true, lastTickTs: h.clock.t });
    expect(demo.allowed).toBe(false);
    const live = await enter('long', T + 7000);
    expect(live.allowed).toBe(false);
    expect(h.ex.placedOrderRequests.filter((x) => x.reduce_only === false)).toHaveLength(1);
  });

  it('kill switch with keep_protective policy leaves the exchange-side stop in place', async () => {
    await arm(h);
    await h.rt.updateSettings({ live: { killSwitchAction: 'keep_protective' } }, 'a', 'admin');
    await enter();
    const r = await h.rt.bot.engageKillSwitch('admin', 'admin');
    expect(r.action).toMatch(/protective stop/);
    expect(h.ex.position.size).toBe(20);
    expect([...h.ex.orders.values()].filter((o) => o.state === 'pending' && o.reduce_only)).toHaveLength(1);
  });

  it('release does not re-arm live: activation must be repeated', async () => {
    await arm(h);
    await h.rt.bot.engageKillSwitch('admin', 'admin');
    await h.rt.bot.releaseKillSwitch('admin', 'admin');
    const st = await h.rt.repos.getBotState(true);
    expect(st).toMatchObject({ killSwitch: false, liveArmed: false, mode: 'demo' });
  });

  it('Live -> Demo (keep_managing): new live entries stop at once, open real position stays managed and is flagged', async () => {
    await arm(h);
    await h.rt.updateSettings(TIME_EXIT_30, 'a', 'admin');
    await enter();
    const r = await h.rt.bot.switchToDemo('admin', 'admin');
    expect(r).toMatchObject({ policy: 'keep_managing', livePositionOpen: true });
    expect(h.ex.position.size).toBe(20); // NOT silently abandoned, NOT silently closed
    expect(h.rt.live.position).not.toBeNull();
    const st = await h.rt.repos.getBotState(true);
    expect(st.attention.join(' ')).toMatch(/Live position still open/);
    const again = await enter('long', T + 9000);
    expect(again.allowed).toBe(false);
    // the open position's configured time exit still works
    h.clock.t += 31 * 60_000;
    await h.rt.live.monitor({ ts: h.clock.t, bid: 3001, ask: 3001.1, last: 3001 });
    expect(h.ex.position.size).toBe(0);
  });

  it('Live -> Demo (close_at_market): the real position is flattened with a reduce-only order', async () => {
    await arm(h);
    await h.rt.updateSettings({ live: { modeSwitchPolicy: 'close_at_market' } }, 'a', 'admin');
    await enter();
    const r = await h.rt.bot.switchToDemo('admin', 'admin');
    expect(r.action).toMatch(/closed at market/);
    expect(h.ex.position.size).toBe(0);
    expect((await h.rt.repos.listTrades('live'))[0].exitReason).toBe('mode_switch');
  });
});
