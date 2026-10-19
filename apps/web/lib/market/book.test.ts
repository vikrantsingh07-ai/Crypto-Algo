import { describe, expect, it } from 'vitest';
import { bookChecksum, OrderBook, type BookMessage } from './book';
import type { RawLevel } from './protocol';

const lv = (price: string, size: string): RawLevel => ({ price: Number(price), priceStr: price, size: Number(size), sizeStr: size });
const rows = (r: [string, string][]) => r.map(([p, s]) => lv(p, s));
const msg = (action: 'snapshot' | 'update', seq: number, a: [string, string][], b: [string, string][], checksum: number | null = null): BookMessage => ({ action, seq, asks: rows(a), bids: rows(b), checksum });

// The documentation's own examples (slate _websocket_api.md, ob_updates): snapshot seq 6199 then update seq 6200.
const DOC_SNAPSHOT = msg('snapshot', 6199, [['16919.0', '1087'], ['16919.5', '1193'], ['16920.0', '510']], [['16918.0', '602'], ['16917.5', '1792'], ['16917.0', '2039']], 2178756498);
const DOC_UPDATE = msg('update', 6200, [['16919.0', '0'], ['16919.5', '710']], [['16918.5', '304']], 3409694612);

describe('OrderBook: the documented algorithm and checksum', () => {
  it('reproduces the checksums printed in the official docs (snapshot and update)', () => {
    const b = new OrderBook();
    expect(b.apply(DOC_SNAPSHOT)).toEqual({ status: 'applied' });
    expect(b.checksumsOk).toBe(1);
    expect(b.apply(DOC_UPDATE)).toEqual({ status: 'applied' });
    expect(b.checksumsOk).toBe(2);
    expect(b.checksumFailures).toBe(0);
  });

  it('applies the documented example: delete 16919.0, replace 16919.5 with 710, insert bid 16918.5', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    b.apply(DOC_UPDATE);
    expect(b.asks.map((l) => [l.price, l.size])).toEqual([[16919.5, 710], [16920, 510]]);
    expect(b.bids.map((l) => [l.price, l.size])).toEqual([[16918.5, 304], [16918, 602], [16917.5, 1792], [16917, 2039]]);
  });

  it('checksum string format from the docs example', () => {
    const asks = rows([['100.00', '23'], ['100.05', '34']]);
    const bids = rows([['99.04', '87'], ['98.65', '102'], ['98.30', '16']]);
    // "100.00:23,100.05:34|99.04:87,98.65:102,98.30:16"
    expect(bookChecksum(asks, bids)).toBe(3599895312);
  });

  it('only the best 10 levels per side enter the checksum', () => {
    const many = Array.from({ length: 30 }, (_, i) => lv(String(100 + i), '1'));
    const ten = many.slice(0, 10);
    expect(bookChecksum(many, [])).toBe(bookChecksum(ten, []));
  });
});

describe('OrderBook: sequence handling', () => {
  it('ignores updates before the first snapshot', () => {
    const b = new OrderBook();
    expect(b.apply(DOC_UPDATE)).toEqual({ status: 'ignored', reason: 'not-synced' });
    expect(b.synced).toBe(false);
  });

  it('a gap (seq jumps) asks for a resync and drops the stale book', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    const r = b.apply({ ...DOC_UPDATE, seq: 6202 });
    expect(r).toEqual({ status: 'resync', reason: 'gap' });
    expect(b.synced).toBe(false);
    expect(b.asks).toHaveLength(0);
    // updates keep being ignored until the next snapshot arrives
    expect(b.apply({ ...DOC_UPDATE, seq: 6203 })).toEqual({ status: 'ignored', reason: 'not-synced' });
  });

  it('a duplicate or older frame is ignored and does not corrupt or resync the book', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    b.apply(DOC_UPDATE);
    const before = JSON.stringify([b.asks, b.bids]);
    expect(b.apply(DOC_UPDATE)).toEqual({ status: 'ignored', reason: 'old-seq' });
    expect(b.apply({ ...DOC_UPDATE, seq: 6100 })).toEqual({ status: 'ignored', reason: 'old-seq' });
    expect(JSON.stringify([b.asks, b.bids])).toBe(before);
    expect(b.synced).toBe(true);
  });

  it('out-of-order delivery (6202 before 6201) triggers a resync, then the late 6201 is ignored', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    b.apply(DOC_UPDATE);
    expect(b.apply(msg('update', 6202, [], [['16918.5', '1']]))).toEqual({ status: 'resync', reason: 'gap' });
    expect(b.apply(msg('update', 6201, [], [['16918.5', '2']]))).toEqual({ status: 'ignored', reason: 'not-synced' });
  });

  it('a fresh snapshot after a resync restores a consistent book (reconnect replay)', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    b.apply({ ...DOC_UPDATE, seq: 9999 });
    expect(b.synced).toBe(false);
    expect(b.apply(msg('snapshot', 7000, [['17000.0', '5']], [['16999.5', '6']]))).toEqual({ status: 'applied' });
    expect(b.synced).toBe(true);
    expect(b.lastSeq).toBe(7000);
    expect(b.apply(msg('update', 7001, [['17000.0', '0']], []))).toEqual({ status: 'applied' });
    expect(b.asks).toHaveLength(0);
    expect(b.bids.map((l) => l.price)).toEqual([16999.5]);
  });

  it('reset() (new connection) forgets the book and the sequence', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    b.reset();
    expect(b.synced).toBe(false);
    expect(b.lastSeq).toBeNull();
    expect(b.apply(DOC_UPDATE)).toEqual({ status: 'ignored', reason: 'not-synced' });
  });
});

describe('OrderBook: checksum failures', () => {
  it('a wrong checksum on an update triggers a resync', () => {
    const b = new OrderBook();
    b.apply(DOC_SNAPSHOT);
    const r = b.apply({ ...DOC_UPDATE, checksum: 12345 });
    expect(r).toEqual({ status: 'resync', reason: 'checksum' });
    expect(b.synced).toBe(false);
  });

  it('a wrong checksum on a snapshot triggers a resync', () => {
    const b = new OrderBook();
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: 1 })).toEqual({ status: 'resync', reason: 'checksum' });
    expect(b.synced).toBe(false);
  });

  it('gives up verifying after 3 consecutive failures (cannot be confirmed against the live exchange) but keeps the sequence check', () => {
    const b = new OrderBook();
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: 1 }).status).toBe('resync');
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: 1 }).status).toBe('resync');
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: 1 })).toEqual({ status: 'applied' });
    expect(b.checksumDisabled).toBe(true);
    expect(b.synced).toBe(true);
    // verification is off now, a mismatching cs no longer matters...
    expect(b.apply({ ...DOC_UPDATE, checksum: 1 })).toEqual({ status: 'applied' });
    // ...but a gap still does
    expect(b.apply(msg('update', 9000, [], []))).toEqual({ status: 'resync', reason: 'gap' });
  });

  it('a success in between resets the failure streak', () => {
    const b = new OrderBook();
    b.apply({ ...DOC_SNAPSHOT, checksum: 1 });
    b.apply({ ...DOC_SNAPSHOT, checksum: 1 });
    expect(b.apply(DOC_SNAPSHOT)).toEqual({ status: 'applied' });
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: 1 }).status).toBe('resync');
    expect(b.checksumDisabled).toBe(false);
  });

  it('no checksum in the message means nothing to verify', () => {
    const b = new OrderBook();
    expect(b.apply({ ...DOC_SNAPSHOT, checksum: null })).toEqual({ status: 'applied' });
  });
});

describe('OrderBook: structure', () => {
  it('keeps both sides sorted best-first whatever order rows arrive in', () => {
    const b = new OrderBook({ verifyChecksum: false });
    b.apply(msg('snapshot', 1, [['103', '1'], ['101', '1'], ['102', '1']], [['98', '1'], ['100', '1'], ['99', '1']]));
    expect(b.asks.map((l) => l.price)).toEqual([101, 102, 103]);
    expect(b.bids.map((l) => l.price)).toEqual([100, 99, 98]);
    b.apply(msg('update', 2, [['100.5', '4'], ['104', '4']], [['99.5', '7'], ['97', '7']]));
    expect(b.asks.map((l) => l.price)).toEqual([100.5, 101, 102, 103, 104]);
    expect(b.bids.map((l) => l.price)).toEqual([100, 99.5, 99, 98, 97]);
  });

  it('deleting an unknown price is a harmless no-op, size 0 rows in a snapshot are dropped, duplicates keep the last', () => {
    const b = new OrderBook({ verifyChecksum: false });
    b.apply(msg('snapshot', 1, [['101', '0'], ['102', '5'], ['102', '9']], [['100', '1']]));
    expect(b.asks.map((l) => [l.price, l.size])).toEqual([[102, 9]]);
    expect(b.apply(msg('update', 2, [['555', '0']], []))).toEqual({ status: 'applied' });
    expect(b.asks).toHaveLength(1);
  });

  it('top(n) returns a best-first copy', () => {
    const b = new OrderBook({ verifyChecksum: false });
    b.apply(msg('snapshot', 1, Array.from({ length: 30 }, (_, i) => [String(100 + i), '1'] as [string, string]), []));
    const t = b.top('asks', 10);
    expect(t).toHaveLength(10);
    expect(t[0].price).toBe(100);
    t.length = 0;
    expect(b.asks).toHaveLength(30);
  });

  it('trims the far end to maxKeep and asks for a fresh snapshot if the kept depth runs dry', () => {
    const b = new OrderBook({ verifyChecksum: false, maxKeep: 20, minDepth: 10 });
    const asks = Array.from({ length: 40 }, (_, i) => [String(100 + i), '1'] as [string, string]);
    b.apply(msg('snapshot', 1, asks, [['99', '1']]));
    expect(b.asks).toHaveLength(20);
    // delete best levels until fewer than 10 remain
    const del = Array.from({ length: 11 }, (_, i) => [String(100 + i), '0'] as [string, string]);
    expect(b.apply(msg('update', 2, del, []))).toEqual({ status: 'resync', reason: 'depth' });
  });

  it('a book with fewer than minDepth levels that was never trimmed is fine', () => {
    const b = new OrderBook({ verifyChecksum: false, minDepth: 10 });
    b.apply(msg('snapshot', 1, [['100', '1'], ['101', '1']], [['99', '1']]));
    expect(b.apply(msg('update', 2, [['100', '0']], []))).toEqual({ status: 'applied' });
  });

  it('applies realistic bursts quickly (10k updates on a 400-level book)', () => {
    const b = new OrderBook({ verifyChecksum: false });
    const asks = Array.from({ length: 400 }, (_, i) => [(3390 + i * 0.05).toFixed(2), '100'] as [string, string]);
    const bids = Array.from({ length: 400 }, (_, i) => [(3389.95 - i * 0.05).toFixed(2), '100'] as [string, string]);
    b.apply(msg('snapshot', 1, asks, bids));
    const t0 = performance.now();
    for (let s = 2; s < 10_002; s++) {
      const i = s % 40;
      b.apply(msg('update', s, [[(3390 + i * 0.05).toFixed(2), String(50 + (s % 70))]], [[(3389.95 - i * 0.05).toFixed(2), String(40 + (s % 90))]]));
    }
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(b.synced).toBe(true);
  });
});
