import { crc32 } from './crc32';
import type { RawLevel } from './protocol';

/**
 * Local copy of Delta's order book maintained from the `ob_updates` channel (snapshot + incremental updates).
 * Algorithm exactly as documented (PROTOCOL.md): sequence must be +1, size 0 deletes, otherwise replace/insert,
 * CRC32 over the best 10 levels per side. Display-only: nothing trades from this data.
 */

export type BookApply =
  | { status: 'applied' }
  | { status: 'ignored'; reason: 'not-synced' | 'old-seq' }
  | { status: 'resync'; reason: 'gap' | 'checksum' | 'depth' };

export interface BookMessage {
  action: 'snapshot' | 'update';
  asks: RawLevel[];
  bids: RawLevel[];
  seq: number;
  checksum: number | null;
}

export interface OrderBookOptions {
  /** levels kept per side (the far end is dropped); default 400 */
  maxKeep?: number;
  /** if a trimmed side shrinks below this many levels the book asks for a fresh snapshot; default 10 */
  minDepth?: number;
  /** verify `cs`; default true */
  verifyChecksum?: boolean;
  /** consecutive checksum failures after which verification is switched off (the live exchange could not be reached to confirm our reading); default 3 */
  checksumGiveUpAfter?: number;
}

class Side {
  /** best first */
  levels: RawLevel[] = [];
  trimmed = false;
  constructor(private readonly isBid: boolean) {}

  /** first index whose level is not strictly better than `price` */
  private bound(price: number): number {
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.levels[mid].price;
      if (this.isBid ? p > price : p < price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  upsert(l: RawLevel) {
    const i = this.bound(l.price);
    const cur = this.levels[i];
    const exists = cur !== undefined && cur.price === l.price;
    if (l.size === 0) {
      if (exists) this.levels.splice(i, 1);
      return;
    }
    if (exists) this.levels[i] = l;
    else this.levels.splice(i, 0, l);
  }

  replace(rows: RawLevel[], maxKeep: number) {
    const sorted = rows.filter((r) => r.size > 0);
    let ordered = true;
    for (let i = 1; i < sorted.length && ordered; i++) ordered = this.isBid ? sorted[i - 1].price > sorted[i].price : sorted[i - 1].price < sorted[i].price;
    if (!ordered) {
      sorted.sort((a, b) => (this.isBid ? b.price - a.price : a.price - b.price));
      // a duplicated price keeps its last occurrence
      const dedup: RawLevel[] = [];
      for (const r of sorted) {
        if (dedup.length && dedup[dedup.length - 1].price === r.price) dedup[dedup.length - 1] = r;
        else dedup.push(r);
      }
      this.levels = dedup;
    } else this.levels = sorted;
    this.trimmed = false;
    this.trim(maxKeep);
  }

  trim(maxKeep: number) {
    if (this.levels.length > maxKeep) {
      this.levels.length = maxKeep;
      this.trimmed = true;
    }
  }
}

export function bookChecksum(asks: RawLevel[], bids: RawLevel[]): number {
  const part = (levels: RawLevel[]) => {
    const n = Math.min(10, levels.length);
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = `${levels[i].priceStr}:${levels[i].sizeStr}`;
    return out.join(',');
  };
  return crc32(`${part(asks)}|${part(bids)}`);
}

export class OrderBook {
  private readonly asksSide = new Side(false);
  private readonly bidsSide = new Side(true);
  private seq: number | null = null;
  private verify: boolean;
  private streak = 0;
  private readonly maxKeep: number;
  private readonly minDepth: number;
  private readonly giveUpAfter: number;

  synced = false;
  checksumsOk = 0;
  checksumFailures = 0;
  checksumDisabled = false;
  resyncs = 0;

  constructor(opts: OrderBookOptions = {}) {
    this.maxKeep = Math.max(20, opts.maxKeep ?? 400);
    this.minDepth = opts.minDepth ?? 10;
    this.verify = opts.verifyChecksum ?? true;
    this.giveUpAfter = opts.checksumGiveUpAfter ?? 3;
  }

  get asks(): readonly RawLevel[] {
    return this.asksSide.levels;
  }
  get bids(): readonly RawLevel[] {
    return this.bidsSide.levels;
  }
  get lastSeq(): number | null {
    return this.seq;
  }

  /** Forget everything (new connection, or the caller is about to resubscribe). */
  reset() {
    this.asksSide.levels = [];
    this.bidsSide.levels = [];
    this.asksSide.trimmed = false;
    this.bidsSide.trimmed = false;
    this.seq = null;
    this.synced = false;
  }

  private invalidate() {
    this.resyncs++;
    this.reset();
  }

  apply(msg: BookMessage): BookApply {
    if (msg.action === 'snapshot') {
      this.asksSide.replace(msg.asks, this.maxKeep);
      this.bidsSide.replace(msg.bids, this.maxKeep);
      this.seq = msg.seq;
      this.synced = true;
      return this.check(msg.checksum);
    }
    if (!this.synced || this.seq === null) return { status: 'ignored', reason: 'not-synced' };
    if (msg.seq <= this.seq) return { status: 'ignored', reason: 'old-seq' };
    if (msg.seq !== this.seq + 1) {
      this.invalidate();
      return { status: 'resync', reason: 'gap' };
    }
    for (const r of msg.asks) this.asksSide.upsert(r);
    for (const r of msg.bids) this.bidsSide.upsert(r);
    this.asksSide.trim(this.maxKeep);
    this.bidsSide.trim(this.maxKeep);
    this.seq = msg.seq;
    if ((this.asksSide.trimmed && this.asksSide.levels.length < this.minDepth) || (this.bidsSide.trimmed && this.bidsSide.levels.length < this.minDepth)) {
      this.invalidate();
      return { status: 'resync', reason: 'depth' };
    }
    return this.check(msg.checksum);
  }

  private check(cs: number | null): BookApply {
    if (cs === null || !this.verify) return { status: 'applied' };
    if (bookChecksum(this.asksSide.levels, this.bidsSide.levels) === cs) {
      this.streak = 0;
      this.checksumsOk++;
      return { status: 'applied' };
    }
    this.checksumFailures++;
    this.streak++;
    if (this.streak >= this.giveUpAfter) {
      // Could not be confirmed against the real exchange: stop second-guessing a stream whose sequence numbers are intact.
      this.verify = false;
      this.checksumDisabled = true;
      return { status: 'applied' };
    }
    this.invalidate();
    return { status: 'resync', reason: 'checksum' };
  }

  /** best-first copy of the top `n` levels (contracts) */
  top(side: 'bids' | 'asks', n: number): RawLevel[] {
    return (side === 'bids' ? this.bidsSide.levels : this.asksSide.levels).slice(0, n);
  }
}
