import type { MarketCandle } from './types';

/**
 * Delta Exchange PUBLIC WebSocket protocol: constants, outgoing message builders and a tolerant parser.
 * Pure functions, no I/O. Field names and semantics are documented in PROTOCOL.md (with what is inferred).
 */

export const DEFAULT_WS_URL = 'wss://public-socket.india.delta.exchange';
export const TESTNET_WS_URL = 'wss://socket-ind-pub.testnet.deltaex.org';

export const CHANNEL = {
  l1: 'ob_l1',
  l2: 'ob_l2',
  book: 'ob_updates',
  trades: 'trades',
  candle1m: 'candlestick_1m',
  mark: 'mark_price',
  ticker: 'ticker',
} as const;

/** Hard limits that keep one hostile or buggy frame from costing real work. */
export const MAX_FRAME_CHARS = 2_000_000;
export const MAX_ROWS_PER_SIDE = 5_000;

export const markSymbol = (symbol: string): string => `MARK:${symbol}`;

interface ChannelSub {
  name: string;
  symbols: string[];
}

export function subscribeChannels(symbol: string): ChannelSub[] {
  return [
    { name: CHANNEL.l1, symbols: [symbol] },
    { name: CHANNEL.l2, symbols: [symbol] },
    { name: CHANNEL.book, symbols: [symbol] },
    { name: CHANNEL.trades, symbols: [symbol] },
    { name: CHANNEL.candle1m, symbols: [symbol] },
    { name: CHANNEL.mark, symbols: [markSymbol(symbol)] },
    { name: CHANNEL.ticker, symbols: [symbol] },
  ];
}

export const buildEnableHeartbeat = () => ({ type: 'enable_heartbeat' });
export const buildSubscribeAll = (symbol: string) => ({ type: 'subscribe', payload: { channels: subscribeChannels(symbol) } });
export const buildSubscribeBook = (symbol: string) => ({ type: 'subscribe', payload: { channels: [{ name: CHANNEL.book, symbols: [symbol] }] } });
export const buildUnsubscribeBook = (symbol: string) => ({ type: 'unsubscribe', payload: { channels: [{ name: CHANNEL.book, symbols: [symbol] }] } });

/** A price/size row exactly as the exchange sent it (the strings feed the checksum) plus the parsed numbers. */
export interface RawLevel {
  price: number;
  priceStr: string;
  /** contracts */
  size: number;
  sizeStr: string;
}

export type FeedEvent =
  | { kind: 'heartbeat' }
  | { kind: 'other'; type: string }
  | { kind: 'subscriptions'; channels: { name: string; symbols: string[]; error?: string }[] }
  | { kind: 'l1'; symbol: string; bid: number | null; bidSize: number | null; ask: number | null; askSize: number | null; tsMs: number | null }
  | { kind: 'l2'; symbol: string; bids: RawLevel[]; asks: RawLevel[]; tsMs: number | null }
  | { kind: 'book'; action: 'snapshot' | 'update'; symbol: string; bids: RawLevel[]; asks: RawLevel[]; seq: number; checksum: number | null; tsMs: number | null }
  | { kind: 'book-error'; symbol: string; message: string }
  | { kind: 'trade'; symbol: string; price: number; size: number; takerSide: 'buy' | 'sell' | null; tsMs: number | null }
  | { kind: 'candle'; symbol: string; candle: MarketCandle; tsMs: number | null }
  | { kind: 'mark'; symbol: string; price: number; tsMs: number | null }
  | { kind: 'ticker'; symbol: string; open24h: number | null; mark: number | null; tsMs: number | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** number or numeric string -> finite number, otherwise null */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** exchange microseconds -> ms (tolerates ms input) */
function toMs(v: unknown): number | null {
  const n = toNum(v);
  if (n === null || n <= 0) return null;
  return n > 1e14 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Parses `[price, size]` rows; one bad row invalidates the whole side so a half-applied update can never happen. */
function parseRows(v: unknown): RawLevel[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ROWS_PER_SIDE) return null;
  const out: RawLevel[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const r = v[i];
    if (!Array.isArray(r) || r.length < 2) return null;
    const price = toNum(r[0]);
    const size = toNum(r[1]);
    if (price === null || size === null || price <= 0 || size < 0) return null;
    out[i] = { price, priceStr: String(r[0]), size, sizeStr: String(r[1]) };
  }
  return out;
}

function symbolOf(m: Record<string, unknown>): string | null {
  const s = m.sy ?? m.symbol ?? m.s;
  return typeof s === 'string' && s.length > 0 && s.length < 64 ? s : null;
}

const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : toNum(v));

/**
 * Parses one inbound text frame. Never throws. Returns null for anything that is not a recognisable message
 * (malformed JSON, wrong shape, impossible numbers) so callers can simply skip it.
 */
export function parseFeedMessage(data: unknown): FeedEvent | null {
  try {
    let m: unknown = data;
    if (typeof data === 'string') {
      if (data.length === 0 || data.length > MAX_FRAME_CHARS) return null;
      m = JSON.parse(data);
    }
    if (!isObj(m)) return null;
    const type = typeof m.type === 'string' ? m.type : '';
    if (type === '') return null;
    switch (type) {
      case 'heartbeat':
        return { kind: 'heartbeat' };
      case 'subscriptions': {
        const chans = Array.isArray(m.channels) ? m.channels : [];
        const channels = chans.filter(isObj).map((c) => ({
          name: typeof c.name === 'string' ? c.name : '',
          symbols: Array.isArray(c.symbols) ? c.symbols.filter((s): s is string => typeof s === 'string') : [],
          ...(typeof c.error === 'string' ? { error: c.error } : {}),
        }));
        return { kind: 'subscriptions', channels };
      }
      case 'ob_l1': {
        const symbol = symbolOf(m);
        if (!symbol) return null;
        const bid = optNum(m.bp);
        const ask = optNum(m.ap);
        if ((bid !== null && bid <= 0) || (ask !== null && ask <= 0)) return null;
        return { kind: 'l1', symbol, bid, bidSize: optNum(m.bs), ask, askSize: optNum(m.as), tsMs: toMs(m.lts) ?? toMs(m.ts) };
      }
      case 'ob_l2': {
        const symbol = symbolOf(m);
        const bids = parseRows(m.b);
        const asks = parseRows(m.a);
        if (!symbol || !bids || !asks) return null;
        return { kind: 'l2', symbol, bids, asks, tsMs: toMs(m.lts) ?? toMs(m.ts) };
      }
      case 'ob_updates': {
        const action = m.action;
        const symbol = symbolOf(m);
        if (action === 'error') return { kind: 'book-error', symbol: symbol ?? '', message: typeof m.msg === 'string' ? m.msg : 'order book error' };
        if (action !== 'snapshot' && action !== 'update') return null;
        const bids = parseRows(m.b);
        const asks = parseRows(m.a);
        const seq = toNum(m.seq);
        if (!symbol || !bids || !asks || seq === null || !Number.isInteger(seq) || seq < 0) return null;
        const cs = toNum(m.cs);
        return { kind: 'book', action, symbol, bids, asks, seq, checksum: cs !== null && Number.isInteger(cs) && cs >= 0 ? cs : null, tsMs: toMs(m.ts) };
      }
      case 'trades': {
        const symbol = symbolOf(m);
        const price = toNum(m.p);
        const size = toNum(m.s);
        if (!symbol || price === null || price <= 0) return null;
        // r is the BUYER's role: a taker buyer means the aggressor bought.
        const takerSide = m.r === 't' ? 'buy' : m.r === 'm' ? 'sell' : null;
        return { kind: 'trade', symbol, price, size: size !== null && size >= 0 ? size : 0, takerSide, tsMs: toMs(m.t) ?? toMs(m.ts) };
      }
      case 'mark_price': {
        const symbol = symbolOf(m);
        const price = toNum(m.p);
        if (!symbol || price === null || price <= 0) return null;
        return { kind: 'mark', symbol, price, tsMs: toMs(m.ts) };
      }
      case 'ticker': {
        const symbol = symbolOf(m);
        if (!symbol) return null;
        // The documented sample nests the per-product fields inside `d`; accept both layouts.
        const d = Array.isArray(m.d) ? m.d.find(isObj) : isObj(m.d) ? m.d : undefined;
        const src: Record<string, unknown> = isObj(d) ? { ...m, ...d } : m;
        const ohlc = Array.isArray(src.ohlc) ? src.ohlc : null;
        const open = ohlc ? toNum(ohlc[0]) : null;
        return { kind: 'ticker', symbol, open24h: open !== null && open > 0 ? open : null, mark: optNum(src.m) ?? optNum(src.mark_price), tsMs: toMs(m.ts) };
      }
      default: {
        if (type.startsWith('candlestick_')) {
          const symbol = symbolOf(m);
          if (!symbol) return null;
          if (type !== 'candlestick_1m') return { kind: 'other', type };
          const o = toNum(m.o);
          const h = toNum(m.h);
          const l = toNum(m.l);
          const c = toNum(m.c);
          if (o === null || h === null || l === null || c === null || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) return null;
          const tsMs = toMs(m.ts);
          const explicitStart = toMs(m.candle_start_time);
          const basis = explicitStart ?? tsMs;
          if (basis === null) return null;
          const v = toNum(m.v);
          return { kind: 'candle', symbol, candle: { t: Math.floor(basis / 60_000) * 60_000, o, h, l, c, v: v !== null && v >= 0 ? v : 0 }, tsMs };
        }
        return { kind: 'other', type };
      }
    }
  } catch {
    return null;
  }
}
