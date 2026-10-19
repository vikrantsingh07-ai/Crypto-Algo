import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { buildSubscribeAll, buildSubscribeBook, buildUnsubscribeBook, DEFAULT_WS_URL, parseFeedMessage, subscribeChannels, toNum } from './protocol';

const j = (o: unknown) => JSON.stringify(o);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });
  it('agrees with Node zlib.crc32 on ASCII and on UTF-8 input', () => {
    const samples = ['100.00:23,100.05:34|99.04:87,98.65:102,98.30:16', 'é', 'price:size|x', '0', 'a'.repeat(1000)];
    for (let i = 0; i < 50; i++) samples.push(Array.from({ length: 1 + (i * 7) % 90 }, (_, k) => String.fromCharCode(32 + ((i * 31 + k * 17) % 90))).join(''));
    for (const t of samples) expect(crc32(t)).toBe(zlibCrc32(t));
  });
});

describe('outgoing messages', () => {
  it('uses the documented public endpoint, not the private one', () => {
    expect(DEFAULT_WS_URL).toBe('wss://public-socket.india.delta.exchange');
  });
  it('subscribes to the current (non-deprecated) channels only, with MARK: prefix for the mark price', () => {
    const msg = buildSubscribeAll('ETHUSD') as { type: string; payload: { channels: { name: string; symbols: string[] }[] } };
    expect(msg.type).toBe('subscribe');
    const names = msg.payload.channels.map((c) => c.name);
    expect(names).toEqual(['ob_l1', 'ob_l2', 'ob_updates', 'trades', 'candlestick_1m', 'mark_price', 'ticker']);
    for (const legacy of ['l1_orderbook', 'l2_orderbook', 'l2_updates', 'v2/ticker', 'all_trades']) expect(names).not.toContain(legacy);
    expect(msg.payload.channels.find((c) => c.name === 'mark_price')?.symbols).toEqual(['MARK:ETHUSD']);
    expect(subscribeChannels('ETHUSD').every((c) => c.symbols.length === 1)).toBe(true);
  });
  it('builds the book resubscribe pair', () => {
    expect(buildUnsubscribeBook('ETHUSD')).toEqual({ type: 'unsubscribe', payload: { channels: [{ name: 'ob_updates', symbols: ['ETHUSD'] }] } });
    expect(buildSubscribeBook('ETHUSD')).toEqual({ type: 'subscribe', payload: { channels: [{ name: 'ob_updates', symbols: ['ETHUSD'] }] } });
  });
});

describe('parseFeedMessage: documented shapes', () => {
  it('heartbeat and subscriptions (with a per-channel error)', () => {
    expect(parseFeedMessage(j({ type: 'heartbeat' }))).toEqual({ kind: 'heartbeat' });
    const s = parseFeedMessage(j({ type: 'subscriptions', channels: [{ name: 'ob_l1', symbols: ['ETHUSD'] }, { name: 'trading_notifications', error: 'subscription forbidden' }] }));
    expect(s).toEqual({
      kind: 'subscriptions',
      channels: [
        { name: 'ob_l1', symbols: ['ETHUSD'] },
        { name: 'trading_notifications', symbols: [], error: 'subscription forbidden' },
      ],
    });
  });

  it('ob_l1', () => {
    const e = parseFeedMessage(j({ ap: '68519.0', as: '285', bp: '68518.0', bs: '2452', lts: 1775037882675402, sy: 'BTCUSD', ts: 1775037882748105, type: 'ob_l1' }));
    expect(e).toEqual({ kind: 'l1', symbol: 'BTCUSD', bid: 68518, bidSize: 2452, ask: 68519, askSize: 285, tsMs: 1775037882675 });
  });
  it('ob_l1 with an empty side', () => {
    const e = parseFeedMessage(j({ ap: null, as: null, bp: '100', bs: '5', sy: 'ETHUSD', ts: 1775037882748105, type: 'ob_l1' }));
    expect(e).toMatchObject({ kind: 'l1', bid: 100, ask: null, askSize: null });
  });

  it('ob_l2', () => {
    const e = parseFeedMessage(j({ a: [['68525.0', '3313'], ['68525.5', '3009']], b: [['68524.0', '2452']], lts: 1775038313132415, sy: 'ETHUSD', ts: 1775038313632092, type: 'ob_l2' }));
    expect(e).toMatchObject({ kind: 'l2', symbol: 'ETHUSD' });
    if (e?.kind !== 'l2') throw new Error('wrong kind');
    expect(e.asks.map((l) => [l.price, l.size])).toEqual([[68525, 3313], [68525.5, 3009]]);
    expect(e.bids[0]).toEqual({ price: 68524, priceStr: '68524.0', size: 2452, sizeStr: '2452' });
  });

  it('ob_updates snapshot, update and error', () => {
    const snap = parseFeedMessage(j({ action: 'snapshot', a: [['16919.0', '1087']], b: [['16918.0', '602']], ts: 1671140718980723, seq: 6199, sy: 'BTCUSD', type: 'ob_updates', cs: 2178756498 }));
    expect(snap).toMatchObject({ kind: 'book', action: 'snapshot', seq: 6199, checksum: 2178756498, symbol: 'BTCUSD' });
    const upd = parseFeedMessage(j({ action: 'update', a: [['16919.0', '0']], b: [], seq: 6200, sy: 'BTCUSD', type: 'ob_updates', ts: 1671140769059031, cs: 5 }));
    expect(upd).toMatchObject({ kind: 'book', action: 'update', seq: 6200 });
    const err = parseFeedMessage(j({ action: 'error', symbol: 'BTCUSD', type: 'ob_updates', msg: 'Snapshot load failed. Verify if product is live and resubscribe after a few secs.' }));
    expect(err).toEqual({ kind: 'book-error', symbol: 'BTCUSD', message: 'Snapshot load failed. Verify if product is live and resubscribe after a few secs.' });
  });

  it('trades: r is the BUYER role, so a taker buyer means the aggressor bought', () => {
    const buy = parseFeedMessage(j({ p: '72141.5', r: 't', s: 1.0, sy: 'BTCUSD', t: 1775800366578410, ts: 1775800367003029, type: 'trades' }));
    expect(buy).toEqual({ kind: 'trade', symbol: 'BTCUSD', price: 72141.5, size: 1, takerSide: 'buy', tsMs: 1775800366578 });
    const sell = parseFeedMessage(j({ p: '72141.5', r: 'm', s: 3, sy: 'BTCUSD', t: 1775800366578410, type: 'trades' }));
    expect(sell).toMatchObject({ takerSide: 'sell' });
    expect(parseFeedMessage(j({ p: '1', s: 3, sy: 'X', type: 'trades' }))).toMatchObject({ takerSide: null });
  });

  it('mark_price', () => {
    expect(parseFeedMessage(j({ p: '2296.3486551', sy: 'MARK:ETHUSD', ts: 1775814170680883, type: 'mark_price' }))).toEqual({ kind: 'mark', symbol: 'MARK:ETHUSD', price: 2296.3486551, tsMs: 1775814170680 });
  });

  it('candlestick_1m: bucket is the minute of ts; an explicit start time wins; other resolutions are ignored', () => {
    const ts = 1775814834503627; // 2026-... :54.5 s into a minute
    const e = parseFeedMessage(j({ c: 71748.0, h: 71751.5, l: 71737.0, o: 71737.0, res: '1m', sy: 'BTCUSD', ts, type: 'candlestick_1m', v: 2826.0 }));
    if (e?.kind !== 'candle') throw new Error('wrong kind');
    expect(e.candle).toEqual({ t: Math.floor(1775814834503 / 60000) * 60000, o: 71737, h: 71751.5, l: 71737, c: 71748, v: 2826 });
    expect(e.candle.t % 60000).toBe(0);
    const explicit = parseFeedMessage(j({ c: 1, h: 2, l: 1, o: 1, sy: 'ETHUSD', ts, candle_start_time: 1775814780000000, type: 'candlestick_1m' }));
    if (explicit?.kind !== 'candle') throw new Error('wrong kind');
    expect(explicit.candle.t).toBe(1775814780000);
    expect(parseFeedMessage(j({ c: 1, h: 2, l: 1, o: 1, sy: 'ETHUSD', ts, type: 'candlestick_5m' }))).toEqual({ kind: 'other', type: 'candlestick_5m' });
  });

  it('ticker: 24h open from ohlc at top level or inside d (the doc sample nests it)', () => {
    const nested = parseFeedMessage(j({ d: [{ s: 'ETHUSD', m: '2300.1', ohlc: [2250.5, 2310, 2240, 2299] }], sy: 'ETHUSD', ts: 1775801092453559, type: 'ticker' }));
    expect(nested).toEqual({ kind: 'ticker', symbol: 'ETHUSD', open24h: 2250.5, mark: 2300.1, tsMs: 1775801092453 });
    const flat = parseFeedMessage(j({ ohlc: [2250.5, 2310, 2240, 2299], sy: 'ETHUSD', type: 'ticker' }));
    expect(flat).toMatchObject({ open24h: 2250.5 });
    expect(parseFeedMessage(j({ sy: 'ETHUSD', type: 'ticker' }))).toMatchObject({ open24h: null, mark: null });
  });
});

describe('parseFeedMessage: hostile and malformed input never throws', () => {
  const cases: [string, unknown][] = [
    ['not json', '{oops'],
    ['empty string', ''],
    ['json null', 'null'],
    ['json array', '[1,2,3]'],
    ['json number', '42'],
    ['object without type', j({ hello: 1 })],
    ['book with a bad row', j({ action: 'update', a: [['1', 'x']], b: [], seq: 1, sy: 'ETHUSD', type: 'ob_updates' })],
    ['book with negative size', j({ action: 'update', a: [['10', '-1']], b: [], seq: 1, sy: 'ETHUSD', type: 'ob_updates' })],
    ['book with zero price', j({ action: 'update', a: [['0', '1']], b: [], seq: 1, sy: 'ETHUSD', type: 'ob_updates' })],
    ['book with fractional seq', j({ action: 'update', a: [], b: [], seq: 1.5, sy: 'ETHUSD', type: 'ob_updates' })],
    ['book with a string seq that is not a number', j({ action: 'update', a: [], b: [], seq: 'abc', sy: 'ETHUSD', type: 'ob_updates' })],
    ['book rows not arrays', j({ action: 'snapshot', a: 'x', b: {}, seq: 1, sy: 'ETHUSD', type: 'ob_updates' })],
    ['book with unknown action', j({ action: 'frobnicate', a: [], b: [], seq: 1, sy: 'ETHUSD', type: 'ob_updates' })],
    ['trade with NaN price', j({ p: 'NaN', sy: 'ETHUSD', type: 'trades' })],
    ['trade without symbol', j({ p: '1', type: 'trades' })],
    ['candle with high below low', j({ o: 1, h: 1, l: 2, c: 1, sy: 'ETHUSD', ts: 1775814834503627, type: 'candlestick_1m' })],
    ['candle without any timestamp', j({ o: 1, h: 2, l: 1, c: 1, sy: 'ETHUSD', type: 'candlestick_1m' })],
    ['mark with null price', j({ p: null, sy: 'MARK:ETHUSD', type: 'mark_price' })],
    ['l1 with a negative price', j({ bp: '-5', sy: 'ETHUSD', type: 'ob_l1' })],
  ];
  for (const [name, raw] of cases) {
    it(`ignores: ${name}`, () => {
      expect(() => parseFeedMessage(raw)).not.toThrow();
      expect(parseFeedMessage(raw)).toBeNull();
    });
  }
  it('unknown but well-formed types are reported as "other", never as data', () => {
    expect(parseFeedMessage(j({ type: 'success', message: 'Heartbeat set' }))).toEqual({ kind: 'other', type: 'success' });
  });
  it('rejects absurd frames and row counts', () => {
    expect(parseFeedMessage('x'.repeat(2_000_001))).toBeNull();
    const rows = Array.from({ length: 5001 }, (_, i) => [String(i + 1), '1']);
    expect(parseFeedMessage(j({ action: 'snapshot', a: rows, b: [], seq: 1, sy: 'ETHUSD', type: 'ob_updates' }))).toBeNull();
  });
  it('toNum', () => {
    expect(toNum('12.5')).toBe(12.5);
    expect(toNum('')).toBeNull();
    expect(toNum(' ')).toBeNull();
    expect(toNum(Infinity)).toBeNull();
    expect(toNum({})).toBeNull();
  });
});
