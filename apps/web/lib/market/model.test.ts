import { describe, expect, it } from 'vitest';
import { MarketModel } from './model';
import { parseFeedMessage } from './protocol';
import { FakeExchange } from './testkit';
import type { MarketCandle } from './types';

const M = 60_000;
const T0 = Math.floor(1_775_800_000_000 / M) * M;

function setup(opts: { seed?: boolean; now?: number } = {}) {
  let now = opts.now ?? T0 + 10_000;
  const ex = new FakeExchange('ETHUSD', () => now);
  ex.seed(3390, 40);
  const model = new MarketModel({ symbol: 'ETHUSD', contractValue: 0.01, levels: 10 });
  const history: MarketCandle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 - (60 - i) * M, o: 3380, h: 3392, l: 3378, c: 3385 + i * 0.1, v: 5 }));
  if (opts.seed !== false) model.setSeed({ bid: 3389.9, ask: 3390.1, last: 3390, ts: now - 2000 }, history, now);
  const feed = (obj: unknown) => {
    model.noteMessage(now);
    const ev = parseFeedMessage(JSON.stringify(obj));
    return ev ? model.ingest(ev, now) : null;
  };
  return {
    model,
    ex,
    feed,
    history,
    get now() {
      return now;
    },
    advance: (ms: number) => {
      now += ms;
    },
    open: () => {
      model.feedStarted(now);
      model.setConnection('connecting', now);
      model.setConnection('open', now);
    },
  };
}

describe('MarketModel: statuses and the backend fallback', () => {
  it('starts as "connecting" showing the backend quote (never an empty price)', () => {
    const t = setup();
    const s = t.model.snapshot(t.now);
    expect(s.status).toBe('connecting');
    expect(s.source).toBe('backend');
    expect(s.price).toBe(3390);
    expect(s.bid).toBe(3389.9);
    expect(s.ask).toBe(3390.1);
    expect(s.candles).toHaveLength(60);
    expect(s.bids).toEqual([]);
  });

  it('with no seed at all, nothing is shown but nothing is NaN either', () => {
    const t = setup({ seed: false });
    const s = t.model.snapshot(t.now);
    expect(s).toMatchObject({ status: 'connecting', price: null, source: 'none', candles: [] });
  });

  it('connecting -> live on the first data message, source delta-ws', () => {
    const t = setup();
    t.open();
    expect(t.model.snapshot(t.now).status).toBe('connecting'); // open but no data yet
    t.feed(t.ex.trade(3391.25, 't'));
    const s = t.model.snapshot(t.now);
    expect(s.status).toBe('live');
    expect(s.source).toBe('delta-ws');
    expect(s.price).toBe(3391.25);
    expect(s.lastTradeSide).toBe('buy');
  });

  it('live -> fallback after 10 s of silence, showing the backend quote again, and back to live on new data', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.trade(3391.25));
    t.advance(9_000);
    expect(t.model.snapshot(t.now).status).toBe('live');
    t.advance(1_500);
    // the dashboard keeps feeding the backend quote while the browser feed is silent
    t.model.setSeed({ bid: 3395.9, ask: 3396.1, last: 3396, ts: t.now }, undefined, t.now);
    const s = t.model.snapshot(t.now);
    expect(s.status).toBe('fallback');
    expect(s.source).toBe('backend');
    expect(s.price).toBe(3396);
    expect(s.bids).toEqual([]);
    t.feed(t.ex.trade(3396.5, 'm'));
    const back = t.model.snapshot(t.now);
    expect(back.status).toBe('live');
    expect(back.price).toBe(3396.5);
    expect(back.lastTradeSide).toBe('sell');
  });

  it('closing the socket makes the status fall back immediately; reopening waits for data again', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.trade(3391));
    t.model.setConnection('backoff', t.now);
    expect(t.model.snapshot(t.now).status).toBe('fallback');
    t.advance(1000);
    t.model.setConnection('connecting', t.now);
    t.model.setConnection('open', t.now);
    expect(t.model.snapshot(t.now).status).toBe('fallback');
    t.feed(t.ex.trade(3392));
    expect(t.model.snapshot(t.now).status).toBe('live');
  });

  it('after the connect grace period without data the status is fallback (or down without a backend quote)', () => {
    const t = setup();
    t.model.feedStarted(t.now);
    t.advance(7_000);
    expect(t.model.snapshot(t.now).status).toBe('connecting');
    t.advance(2_000);
    t.model.setSeed({ bid: 3389.9, ask: 3390.1, last: 3390.5, ts: t.now }, undefined, t.now);
    expect(t.model.snapshot(t.now).status).toBe('fallback');
    const none = setup({ seed: false });
    none.model.feedStarted(none.now);
    none.advance(9_000);
    expect(none.model.snapshot(none.now)).toMatchObject({ status: 'down', price: null, source: 'none' });
  });

  it('a backend quote that stopped changing for 2 minutes is no longer trusted ("down")', () => {
    const t = setup();
    t.model.feedStarted(t.now);
    t.advance(9_000);
    expect(t.model.snapshot(t.now).status).toBe('fallback');
    t.advance(125_000);
    expect(t.model.snapshot(t.now).status).toBe('down');
  });

  it('feed disabled: the backend quote is all there is', () => {
    const m = new MarketModel({ symbol: 'ETHUSD', contractValue: 0.01, levels: 10, feedEnabled: false });
    m.setSeed({ bid: 1, ask: 2, last: 1.5 }, [], 1000);
    expect(m.snapshot(1000)).toMatchObject({ status: 'fallback', source: 'backend', price: 1.5 });
  });
});

describe('MarketModel: prices, depth, change', () => {
  it('book sizes are contracts x contract value (ETH), best first, capped to `levels`', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    t.feed(t.ex.trade(3390));
    const s = t.model.snapshot(t.now);
    expect(s.bids).toHaveLength(10);
    expect(s.asks).toHaveLength(10);
    expect(s.bids[0].price).toBeGreaterThan(s.bids[9].price);
    expect(s.asks[0].price).toBeLessThan(s.asks[9].price);
    const rawBest = Number([...t.ex.bids.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))[0][1]);
    expect(s.bids[0].size).toBeCloseTo(rawBest * 0.01, 6);
    expect(s.bid).toBe(s.bids[0].price);
    expect(s.ask).toBe(s.asks[0].price);
    expect(s.bid!).toBeLessThan(s.ask!);
  });

  it('book updates change the levels live', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    t.feed(t.ex.trade(3390));
    const best = [...t.ex.bids.keys()].sort((a, b) => Number(b) - Number(a))[0];
    t.feed(t.ex.update([['b', best, '5000']]));
    expect(t.model.snapshot(t.now).bids[0].size).toBe(50);
    t.feed(t.ex.update([['b', best, '0']]));
    expect(t.model.snapshot(t.now).bids[0].price).toBeLessThan(Number(best));
  });

  it('a book gap asks for a resync and depth carries on from ob_l2 meanwhile', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    t.feed(t.ex.trade(3390));
    const gap = t.feed(t.ex.update([['a', '3390.05', '1']], { skipSeq: 3 }));
    expect(gap?.effects).toEqual([{ type: 'resync-book', delayMs: 0, reason: 'gap' }]);
    expect(t.model.book.synced).toBe(false);
    expect(t.model.bookWaitingSince).not.toBeNull();
    t.feed(t.ex.l2());
    const s = t.model.snapshot(t.now);
    expect(s.status).toBe('live');
    expect(s.bids.length).toBe(10);
    // a fresh snapshot ends the waiting state
    t.model.beginBookResync(t.now);
    t.feed(t.ex.snapshot());
    expect(t.model.bookWaitingSince).toBeNull();
    expect(t.model.book.synced).toBe(true);
  });

  it('holds the last depth for a moment during a resync with no ob_l2, then shows empty (skeleton) instead of stale bars', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    t.feed(t.ex.trade(3390));
    expect(t.model.snapshot(t.now).bids).toHaveLength(10);
    t.feed(t.ex.update([['a', '3390.05', '1']], { skipSeq: 2 }));
    t.advance(1_000);
    t.feed(t.ex.trade(3390.1));
    expect(t.model.snapshot(t.now).bids).toHaveLength(10);
    t.advance(2_500);
    t.feed(t.ex.trade(3390.2));
    expect(t.model.snapshot(t.now).bids).toHaveLength(0);
  });

  it('a book error message empties the book and requests a resync after 3 s', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    const r = t.feed({ action: 'error', symbol: 'ETHUSD', type: 'ob_updates', msg: 'Snapshot load failed' });
    expect(r?.effects).toEqual([{ type: 'resync-book', delayMs: 3000, reason: 'server-error' }]);
    expect(t.model.book.synced).toBe(false);
  });

  it('reconnect replay: a new connection starts from a new snapshot (even with a lower sequence number)', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.snapshot());
    t.feed(t.ex.update([['a', '3390.05', '7']]));
    t.model.setConnection('backoff', t.now);
    t.advance(2000);
    t.open();
    const fresh = new FakeExchange('ETHUSD', () => t.now);
    fresh.seed(3400, 30);
    fresh.seq = 5; // the server's sequence restarted
    t.feed(fresh.snapshot());
    const bestBid = [...fresh.bids.keys()].sort((a, b) => Number(b) - Number(a))[0];
    t.feed(fresh.update([['b', bestBid, '123']]));
    t.feed(fresh.trade(3400));
    const s = t.model.snapshot(t.now);
    expect(s.status).toBe('live');
    expect(s.bids[0].price).toBe(Math.max(...[...fresh.bids.keys()].map(Number)));
    expect(s.bids[0].size).toBeCloseTo(1.23, 6);
    expect(t.model.book.checksumFailures).toBe(0);
  });

  it('price: a trade wins; on a quiet tape the candle close, then the mid, take over', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.l1());
    t.feed(t.ex.trade(3390.45));
    expect(t.model.snapshot(t.now).price).toBe(3390.45);
    t.advance(2_500); // tape quiet for > 2 s, candle message arrives
    t.feed(t.ex.candle(3390, 3391, 3389, 3390.6, 10, t.now));
    expect(t.model.snapshot(t.now).price).toBe(3390.6);
    t.advance(6_000);
    t.feed(t.ex.l1());
    const mid = t.model.snapshot(t.now);
    expect(mid.price).toBeCloseTo(((mid.bid ?? 0) + (mid.ask ?? 0)) / 2, 6);
  });

  it('trades move the forming candle; candle messages then correct it', () => {
    const t = setup();
    t.open();
    const before = t.model.snapshot(t.now).candles.length;
    t.feed(t.ex.trade(3391));
    t.feed(t.ex.trade(3393));
    t.feed(t.ex.trade(3392));
    const s = t.model.snapshot(t.now);
    expect(s.candles.length).toBe(before + 1);
    expect(s.candles[s.candles.length - 1]).toMatchObject({ o: 3391, h: 3393, l: 3391, c: 3392 });
    t.feed(t.ex.candle(3390.9, 3393, 3390.9, 3392, 77, t.now));
    expect(t.model.snapshot(t.now).candles.at(-1)).toMatchObject({ o: 3390.9, v: 77 });
  });

  it('change %: window change first, the 24h ticker once it arrives', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.trade(3400));
    const w = t.model.snapshot(t.now);
    expect(w.changeLabel).toBe('1h');
    expect(w.changePct).toBeCloseTo((3400 / 3380 - 1) * 100, 6);
    t.feed(t.ex.ticker(3300));
    const d = t.model.snapshot(t.now);
    expect(d.changeLabel).toBe('24h');
    expect(d.changePct).toBeCloseTo((3400 / 3300 - 1) * 100, 6);
  });

  it('mark price comes from the MARK: channel only', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.trade(3390));
    t.feed({ type: 'mark_price', sy: 'ETHUSD', p: '1.0', ts: 1_775_800_000_000_000 }); // wrong symbol form: ignored
    expect(t.model.snapshot(t.now).mark).toBeNull();
    t.feed(t.ex.mark(3390.1234));
    expect(t.model.snapshot(t.now).mark).toBe(3390.1234);
  });

  it('ignores messages for other symbols', () => {
    const t = setup();
    t.open();
    t.feed({ ...t.ex.trade(99999), sy: 'BTCUSD' });
    t.feed({ ...t.ex.candle(1, 2, 1, 2), sy: 'BTCUSD' });
    expect(t.model.snapshot(t.now).status).toBe('connecting');
  });

  it('a replayed old trade (timestamp well behind the last one) does not move the price back', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.trade(3392));
    t.feed({ ...t.ex.trade(3300), t: (t.now - 30_000) * 1000 });
    expect(t.model.snapshot(t.now).price).toBe(3392);
  });

  it('malformed frames and channel errors do not break anything', () => {
    const t = setup();
    t.open();
    expect(t.feed('{not json')).toBeNull();
    expect(t.feed({ type: 'trades', sy: 'ETHUSD', p: 'abc' })).toBeNull();
    t.feed({ type: 'subscriptions', channels: [{ name: 'ob_updates', error: 'nope' }, { name: 'trades', symbols: ['ETHUSD'] }] });
    expect(t.model.channelErrors.get('ob_updates')).toBe('nope');
    t.feed(t.ex.trade(3390));
    expect(t.model.snapshot(t.now).status).toBe('live');
  });
});

describe('MarketModel: seeds', () => {
  it('while live the feed keeps its own candles; once not live, the backend candles are authoritative again', () => {
    const t = setup();
    t.open();
    t.feed(t.ex.candle(3390, 3395, 3389, 3394, 12, t.now));
    const liveMinute = Math.floor(t.now / M) * M;
    const stale: MarketCandle = { t: liveMinute, o: 1, h: 2, l: 1, c: 1.5, v: 1 };
    t.model.setSeed(null, [stale], t.now);
    expect(t.model.snapshot(t.now).candles.find((c) => c.t === liveMinute)?.c).toBe(3394);
    t.advance(11_000);
    t.model.setSeed(null, [stale], t.now);
    expect(t.model.snapshot(t.now).candles.find((c) => c.t === liveMinute)?.c).toBe(1.5);
  });

  it('setSeed reports whether anything changed (no pointless re-renders for identical polls)', () => {
    const t = setup();
    const q = { bid: 3389.9, ask: 3390.1, last: 3390, ts: t.now - 2000 };
    expect(t.model.setSeed(q, t.history, t.now)).toBe(false);
    expect(t.model.setSeed({ ...q, last: 3391 }, t.history, t.now)).toBe(true);
  });
});
