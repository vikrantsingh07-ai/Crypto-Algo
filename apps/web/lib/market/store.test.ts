import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketStore, type StoreConfig, type StoreEnv } from './store';
import { FakeExchange, FakeWs } from './testkit';
import type { WsCtor } from './feed';

const M = 60_000;
const T0 = Math.floor(1_775_800_000_000 / M) * M;

interface Rig {
  store: MarketStore;
  ex: FakeExchange;
  hidden: { value: boolean };
  fireVisibility: () => void;
  notifications: { count: number };
  unsubscribe: () => void;
}

function rig(cfg: Partial<StoreConfig> = {}, env: Partial<StoreEnv> = {}): Rig {
  const hidden = { value: false };
  let visCb: (() => void) | null = null;
  const ex = new FakeExchange('ETHUSD', () => Date.now());
  ex.seed(3390, 40);
  const store = new MarketStore(
    {
      symbol: 'ETHUSD',
      contractValue: 0.01,
      levels: 10,
      wsUrl: 'wss://test.invalid',
      seedQuote: { bid: 3389.9, ask: 3390.1, last: 3390, ts: Date.now() },
      seedCandles: [{ t: Math.floor(Date.now() / M) * M - M, o: 3380, h: 3392, l: 3378, c: 3385, v: 1 }],
      ...cfg,
    },
    {
      WebSocketCtor: FakeWs as unknown as WsCtor,
      random: () => 1,
      raf: (cb) => setTimeout(() => cb(Date.now()), 16),
      cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      isHidden: () => hidden.value,
      onVisibilityChange: (cb) => {
        visCb = cb;
        return () => {
          visCb = null;
        };
      },
      ...env,
    },
  );
  const notifications = { count: 0 };
  const unsubscribe = store.subscribe(() => notifications.count++);
  return { store, ex, hidden, fireVisibility: () => visCb?.(), notifications, unsubscribe };
}

/** start deferred timer, open the socket, deliver snapshot + first trade, flush */
async function goLive(r: Rig) {
  await vi.advanceTimersByTimeAsync(1);
  const ws = FakeWs.last;
  ws.open();
  ws.emit(r.ex.snapshot());
  ws.emit(r.ex.trade(3391.25));
  await vi.advanceTimersByTimeAsync(100);
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 + 5_000 });
  FakeWs.reset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('MarketStore: connection lifecycle', () => {
  it('opens one socket after mount, sends heartbeat then the documented subscriptions', async () => {
    const r = rig();
    expect(FakeWs.instances).toHaveLength(0); // never during render / before the deferred start
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWs.instances).toHaveLength(1);
    const ws = FakeWs.last;
    expect(ws.url).toBe('wss://test.invalid');
    ws.open();
    expect(ws.sentTypes).toEqual(['enable_heartbeat', 'subscribe']);
    const names = ws.sent[1].payload.channels.map((c: { name: string }) => c.name);
    expect(names).toEqual(['ob_l1', 'ob_l2', 'ob_updates', 'trades', 'candlestick_1m', 'mark_price', 'ticker']);
    r.unsubscribe();
  });

  it('React StrictMode (mount, unmount, mount) opens exactly one socket and leaves nothing running', async () => {
    const store = new MarketStore({ symbol: 'ETHUSD', contractValue: 0.01, levels: 10, wsUrl: 'wss://test.invalid' }, { WebSocketCtor: FakeWs as unknown as WsCtor, raf: (cb) => setTimeout(() => cb(Date.now()), 16), cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), isHidden: () => false, onVisibilityChange: () => () => {} });
    const un1 = store.subscribe(() => {});
    un1();
    const un2 = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(5);
    expect(FakeWs.instances).toHaveLength(1);
    un2();
    expect(FakeWs.last.closedByClient).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWs.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleanup on unmount closes the socket, stops reconnecting and clears every timer', async () => {
    const r = rig();
    const ws = await goLive(r);
    r.unsubscribe();
    expect(ws.closedByClient).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes connecting -> live -> fallback -> live through a stale connection', async () => {
    const r = rig();
    expect(r.store.getSnapshot().status).toBe('connecting');
    const ws = await goLive(r);
    expect(r.store.getSnapshot()).toMatchObject({ status: 'live', source: 'delta-ws', price: 3391.25 });

    // silence: the feed must notice within ~10 s, drop the link and show the backend quote
    r.store.setSeed({ bid: 3400.9, ask: 3401.1, last: 3401, ts: Date.now() }, undefined);
    await vi.advanceTimersByTimeAsync(11_500);
    expect(ws.closedByClient).toBe(true);
    const s = r.store.getSnapshot();
    expect(s.status).toBe('fallback');
    expect(s.source).toBe('backend');
    expect(s.price).toBe(3401);

    // back-off (random()=1 => full 1 s for the first retry) then a new socket, subscriptions replayed
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeWs.instances).toHaveLength(2);
    const ws2 = FakeWs.last;
    ws2.open();
    expect(ws2.sent.map((m) => m.type)).toEqual(['enable_heartbeat', 'subscribe']);
    ws2.emit(r.ex.snapshot());
    ws2.emit(r.ex.trade(3402));
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.getSnapshot()).toMatchObject({ status: 'live', price: 3402, source: 'delta-ws' });
    r.unsubscribe();
  });

  it('a server-side close reconnects with growing back-off (1 s, 2 s, 4 s ... capped), and a healthy connection resets it', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(1);
    const delays: number[] = [];
    let before = Date.now();
    for (let i = 0; i < 5; i++) {
      const ws = FakeWs.last;
      ws.serverClose();
      const n = FakeWs.instances.length;
      let waited = 0;
      while (FakeWs.instances.length === n && waited < 200_000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      delays.push(waited);
      before = Date.now();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    // a connection that survives 15 s resets the back-off
    const ws = FakeWs.last;
    ws.open();
    ws.emit(r.ex.trade(3390));
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      ws.emit({ type: 'heartbeat' });
    }
    ws.serverClose();
    const n = FakeWs.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWs.instances.length).toBe(n + 1);
    void before;
    r.unsubscribe();
  });

  it('a constructor that throws (blocked / unsupported) never crashes; it backs off and keeps the backend quote', async () => {
    FakeWs.failConstruct = true;
    const r = rig();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.store.getSnapshot().price).toBe(3390);
    expect(['connecting', 'fallback']).toContain(r.store.getSnapshot().status);
    FakeWs.failConstruct = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWs.instances.length).toBeGreaterThan(0);
    r.unsubscribe();
  });

  it('events from a superseded socket are ignored', async () => {
    const r = rig();
    const old = await goLive(r);
    r.store.setSeed({ bid: 1, ask: 2, last: 3500, ts: Date.now() }, undefined);
    await vi.advanceTimersByTimeAsync(11_500); // stale -> reconnect
    old.emit(r.ex.trade(9999));
    old.onclose?.({});
    await vi.advanceTimersByTimeAsync(200);
    expect(r.store.getSnapshot().price).not.toBe(9999);
    r.unsubscribe();
  });

  it('enabled=false never opens a socket and shows the backend quote', async () => {
    const r = rig({ enabled: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeWs.instances).toHaveLength(0);
    expect(r.store.getSnapshot()).toMatchObject({ status: 'fallback', source: 'backend', price: 3390 });
    r.unsubscribe();
  });

  it('a handshake that never completes is abandoned after 10 s and retried', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWs.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(FakeWs.instances[0].closedByClient).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeWs.instances.length).toBeGreaterThanOrEqual(2);
    r.unsubscribe();
  });
});

describe('MarketStore: robustness', () => {
  it('malformed frames never throw and never disturb the state', async () => {
    const r = rig();
    const ws = await goLive(r);
    for (const junk of ['{', 'null', '[]', '"x"', JSON.stringify({ type: 'trades', p: 'NaN', sy: 'ETHUSD' }), JSON.stringify({ type: 'ob_updates', action: 'update', seq: 'x', a: 1, b: 2 })]) {
      expect(() => ws.emit(junk)).not.toThrow();
    }
    ws.onmessage?.({ data: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.getSnapshot()).toMatchObject({ status: 'live', price: 3391.25 });
    r.unsubscribe();
  });

  it('a throwing React listener does not break the store', async () => {
    const r = rig();
    r.store.subscribe(() => {
      throw new Error('boom');
    });
    const ws = await goLive(r);
    ws.emit(r.ex.trade(3392));
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.getSnapshot().price).toBe(3392);
    r.unsubscribe();
  });
});

describe('MarketStore: render throttle', () => {
  it('delivers at most ~20 state updates per second under a 500 msg/s burst, and ends on the latest value', async () => {
    const r = rig();
    const ws = await goLive(r);
    const start = r.notifications.count;
    const t0 = Date.now();
    // 2 seconds, 500 messages per second: trades + l1 + book updates
    for (let ms = 0; ms < 2_000; ms += 2) {
      ws.emit(r.ex.trade(3391 + (ms % 7) * 0.05));
      if (ms % 10 === 0) ws.emit(r.ex.update([['b', [...r.ex.bids.keys()][0], String(100 + (ms % 50))]]));
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(100);
    const elapsed = (Date.now() - t0) / 1000;
    const updates = r.notifications.count - start;
    expect(updates / elapsed).toBeLessThanOrEqual(21);
    expect(updates / elapsed).toBeGreaterThan(8);
    const last = 3391 + ((1998 % 7) * 0.05);
    expect(r.store.getSnapshot().price).toBeCloseTo(last, 6);
    r.unsubscribe();
  });

  it('does no React work while the tab is hidden, flushes immediately on return, and verifies the link', async () => {
    const r = rig();
    const ws = await goLive(r);
    r.hidden.value = true;
    r.fireVisibility();
    const before = r.notifications.count;
    for (let i = 0; i < 100; i++) {
      ws.emit(r.ex.trade(3400 + i * 0.05));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(r.notifications.count).toBe(before);
    r.hidden.value = false;
    r.fireVisibility();
    await vi.advanceTimersByTimeAsync(60);
    expect(r.notifications.count).toBeGreaterThan(before);
    expect(r.store.getSnapshot().price).toBeCloseTo(3404.95, 6);
    r.unsubscribe();
  });

  it('after a long time hidden (> 20 s) the order book is resynchronised with unsubscribe + subscribe', async () => {
    const r = rig();
    const ws = await goLive(r);
    r.hidden.value = true;
    r.fireVisibility();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      ws.emit({ type: 'heartbeat' });
      ws.emit(r.ex.trade(3392 + i * 0.05));
    }
    const sentBefore = ws.sent.length;
    r.hidden.value = false;
    r.fireVisibility();
    await vi.advanceTimersByTimeAsync(50);
    const added = ws.sent.slice(sentBefore);
    expect(added.map((m) => m.type)).toEqual(['unsubscribe', 'subscribe']);
    expect(added[0].payload.channels[0]).toEqual({ name: 'ob_updates', symbols: ['ETHUSD'] });
    r.unsubscribe();
  });
});

describe('MarketStore: order-book maintenance over the socket', () => {
  it('a sequence gap triggers unsubscribe + subscribe of ob_updates, and the new snapshot repairs the book', async () => {
    const r = rig();
    const ws = await goLive(r);
    const before = ws.sent.length;
    ws.emit(r.ex.update([['a', '3390.05', '3']], { skipSeq: 5 }));
    await vi.advanceTimersByTimeAsync(50);
    const added = ws.sent.slice(before);
    expect(added.map((m) => m.type)).toEqual(['unsubscribe', 'subscribe']);
    expect(r.store.debug.model.book.synced).toBe(false);
    ws.emit(r.ex.snapshot());
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.debug.model.book.synced).toBe(true);
    expect(r.store.getSnapshot().bids).toHaveLength(10);
    r.unsubscribe();
  });

  it('keeps depth alive from ob_l2 while the incremental book is out of sync', async () => {
    const r = rig();
    const ws = await goLive(r);
    ws.emit(r.ex.update([['a', '3390.05', '3']], { skipSeq: 5 }));
    ws.emit(r.ex.l2());
    await vi.advanceTimersByTimeAsync(100);
    const s = r.store.getSnapshot();
    expect(s.status).toBe('live');
    expect(s.bids).toHaveLength(10);
    expect(s.asks).toHaveLength(10);
    r.unsubscribe();
  });

  it('a book that never delivers its snapshot is re-requested (watchdog), not left blank', async () => {
    const r = rig();
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWs.last;
    ws.open();
    ws.emit(r.ex.trade(3391)); // data flows, but no ob_updates snapshot
    const before = ws.sent.length;
    await vi.advanceTimersByTimeAsync(7_000);
    for (let i = 0; i < 7; i++) ws.emit(r.ex.trade(3391 + i * 0.05));
    const types = ws.sent.slice(before).map((m) => m.type);
    expect(types).toContain('unsubscribe');
    expect(types).toContain('subscribe');
    r.unsubscribe();
  });

  it('a book that keeps failing is rate-limited instead of hammering the server', async () => {
    const r = rig();
    const ws = await goLive(r);
    const before = ws.sent.length;
    for (let i = 0; i < 20; i++) {
      ws.emit(r.ex.update([['a', '3390.05', String(i + 1)]], { skipSeq: 9 }));
      await vi.advanceTimersByTimeAsync(1_100);
      ws.emit(r.ex.snapshot()); // snapshot arrives but the next update is again out of sequence
    }
    const resubs = ws.sent.slice(before).filter((m) => m.type === 'unsubscribe').length;
    expect(resubs).toBeLessThanOrEqual(8);
    r.unsubscribe();
  });
});

describe('MarketStore: seeds from the dashboard', () => {
  it('a new backend quote while not live updates the state; identical polls cause no update', async () => {
    const r = rig({ enabled: false });
    await vi.advanceTimersByTimeAsync(100);
    const n = r.notifications.count;
    r.store.setSeed({ bid: 3389.9, ask: 3390.1, last: 3390, ts: Date.now() }, undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.notifications.count).toBe(n);
    r.store.setSeed({ bid: 3390.9, ask: 3391.1, last: 3391, ts: Date.now() }, undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.notifications.count).toBe(n + 1);
    expect(r.store.getSnapshot().price).toBe(3391);
    r.unsubscribe();
  });

  it('server-render snapshot already shows the seed (no flash of an empty price)', () => {
    const store = new MarketStore({ symbol: 'ETHUSD', contractValue: 0.01, levels: 10, seedQuote: { bid: 1, ask: 2, last: 1.5 } });
    expect(store.getServerSnapshot()).toMatchObject({ status: 'connecting', price: 1.5, source: 'backend' });
  });
});
