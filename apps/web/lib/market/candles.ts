import type { MarketCandle } from './types';

export const MAX_CANDLES = 300;
const MINUTE = 60_000;
/** a closing update for minute N that the exchange publishes this soon after the boundary is folded back into N */
const LATE_UPDATE_WINDOW_MS = 1_500;

export const minuteStart = (ms: number): number => Math.floor(ms / MINUTE) * MINUTE;

/** Accepts anything shaped like a candle (seconds or ms timestamps), returns a clean candle or null. */
export function sanitizeCandle(raw: unknown): MarketCandle | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const t = Number(r.t);
  const o = Number(r.o);
  const h = Number(r.h);
  const l = Number(r.l);
  const c = Number(r.c);
  const v = Number(r.v ?? 0);
  if (![t, o, h, l, c].every((n) => Number.isFinite(n)) || t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  const tMs = t < 1e11 ? t * 1000 : t;
  return { t: minuteStart(tMs), o, h: Math.max(h, o, c, l), l: Math.min(l, o, c, h), c, v: Number.isFinite(v) && v >= 0 ? v : 0 };
}

const sameCandle = (a: MarketCandle, b: MarketCandle) => a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

/**
 * 1-minute candles, oldest first, one per minute. History comes from the backend seed; the live feed then replaces
 * candles by minute and nudges the forming one with every trade. Closed candles are never mutated in place.
 */
export class CandleSeries {
  private list: MarketCandle[] = [];
  /** minute -> exchange timestamp (ms) of the last live candle message applied; presence means "owned by the live feed" */
  private live = new Map<number, number>();

  get length(): number {
    return this.list.length;
  }

  last(): MarketCandle | undefined {
    return this.list[this.list.length - 1];
  }

  /** copy for emitting as state */
  toArray(): MarketCandle[] {
    return this.list.slice();
  }

  private indexOf(t: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.list[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private put(c: MarketCandle) {
    const n = this.list.length;
    if (n === 0 || c.t > this.list[n - 1].t) this.list.push(c);
    else {
      const i = this.indexOf(c.t);
      if (this.list[i] && this.list[i].t === c.t) this.list[i] = c;
      else this.list.splice(i, 0, c);
    }
    if (this.list.length > MAX_CANDLES) {
      const dropped = this.list.splice(0, this.list.length - MAX_CANDLES);
      for (const d of dropped) this.live.delete(d.t);
    }
  }

  /**
   * Merge backend candles. While the live feed is healthy it keeps the candles it owns (`overrideLive` false);
   * when the feed is down the backend is authoritative for every minute it provides.
   * Returns true if anything changed.
   */
  mergeSeed(seed: readonly unknown[] | undefined | null, overrideLive: boolean): boolean {
    if (!seed || seed.length === 0) return false;
    let changed = false;
    for (const raw of seed) {
      const c = sanitizeCandle(raw);
      if (!c) continue;
      if (this.live.has(c.t) && !overrideLive) continue;
      const i = this.indexOf(c.t);
      const cur = this.list[i];
      if (cur && cur.t === c.t) {
        if (!sameCandle(cur, c)) {
          this.list[i] = c;
          changed = true;
        }
        if (overrideLive) this.live.delete(c.t);
      } else {
        this.put(c);
        changed = true;
      }
    }
    return changed;
  }

  /** A `candlestick_1m` message. tsMs = exchange timestamp of the message. */
  applyLive(c: MarketCandle, tsMs: number | null): boolean {
    const prevTs = this.live.get(c.t);
    if (prevTs !== undefined && tsMs !== null && tsMs < prevTs) return false; // older message arriving late
    // A closing update of the previous minute that the exchange stamps just after the rollover: same open, never a narrower range.
    if (tsMs !== null && prevTs === undefined && tsMs - c.t >= 0 && tsMs - c.t < LATE_UPDATE_WINDOW_MS) {
      const pi = this.indexOf(c.t - MINUTE);
      const prev = this.list[pi];
      if (prev && prev.t === c.t - MINUTE && c.o === prev.o && c.h >= prev.h && c.l <= prev.l) {
        const merged: MarketCandle = { t: prev.t, o: prev.o, h: c.h, l: c.l, c: c.c, v: c.v >= prev.v ? c.v : prev.v };
        this.list[pi] = merged;
        this.live.set(prev.t, tsMs);
        return true;
      }
    }
    const i = this.indexOf(c.t);
    const cur = this.list[i];
    if (cur && cur.t === c.t && sameCandle(cur, c)) {
      if (tsMs !== null) this.live.set(c.t, tsMs);
      else if (!this.live.has(c.t)) this.live.set(c.t, 0);
      return false;
    }
    this.put(c);
    this.live.set(c.t, tsMs ?? 0);
    return true;
  }

  /** A trade price at exchange time tsMs: moves the forming candle's close/high/low (volume only comes from candle messages). */
  applyTick(price: number, tsMs: number): boolean {
    if (!(price > 0) || !(tsMs > 0)) return false;
    const key = minuteStart(tsMs);
    const n = this.list.length;
    const last = this.list[n - 1];
    if (!last || key > last.t) {
      this.put({ t: key, o: price, h: price, l: price, c: price, v: 0 });
      return true;
    }
    if (key < last.t) return false;
    if (price === last.c && price <= last.h && price >= last.l) return false;
    this.list[n - 1] = { t: last.t, o: last.o, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, v: last.v };
    return true;
  }

  /** % change from the oldest loaded candle's open to `price`, with a label like "3h" or "45m"; needs a few candles. */
  windowChange(price: number): { pct: number; label: string } | null {
    const first = this.list[0];
    const last = this.list[this.list.length - 1];
    if (!first || !last || this.list.length < 5 || !(price > 0) || !(first.o > 0)) return null;
    const minutes = Math.max(1, Math.round((last.t - first.t) / MINUTE) + 1);
    const label = minutes >= 120 ? `${Math.round(minutes / 60)}h` : minutes >= 60 ? `${(minutes / 60).toFixed(1).replace(/\.0$/, '')}h` : `${minutes}m`;
    return { pct: (price / first.o - 1) * 100, label };
  }
}
