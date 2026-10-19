'use client';
import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { BookLevel, MarketState } from '../../lib/market/types';
import { fmtPrice, fmtSize, EM_DASH } from '../../lib/market/format';
import { useChangeFlash, useElementWidth, usePrefersReducedMotion } from './hooks';
import s from './market.module.css';

/**
 * ORDER FLOW: buyers (green) on the left, sellers (red) on the right, `levels` bars per side, best price at the top.
 * Each bar grows from the outer edge towards the price in the middle in proportion to its size; a thin thread runs from
 * the inner end of every bar to the price. Bar lengths and threads are animated imperatively (one rAF loop writing
 * transforms and path data), so 20 bars + 20 threads can follow 10-20 book updates a second without re-rendering React.
 */

const BAR_MIN = 0.02;
/** shown while there is no book yet (relative lengths only, shimmering) */
const SKELETON = [0.86, 0.72, 0.6, 0.68, 0.52, 0.42, 0.48, 0.36, 0.3, 0.22];
const TAU_MS = 110;
const FLASH_TAU_MS = 170;

interface Geo {
  compact: boolean;
  rowH: number;
  midW: number;
  plateW: number;
}

function geoFor(w: number): Geo {
  const compact = w > 0 && w < 400;
  const midW = w === 0 ? 140 : compact ? 92 : Math.round(Math.min(230, Math.max(150, w * 0.3)));
  return { compact, rowH: compact ? 24 : 26, midW, plateW: compact ? 78 : Math.min(132, midW - 26) };
}

/** Thread from the inner end of bar `i` (side 0 = buyers on the left, 1 = sellers on the right) to the price plate. */
function threadD(side: 0 | 1, i: number, f: number, w: number, n: number, g: Geo, labelEnd: number): string {
  const colW = (w - g.midW) / 2;
  const yRow = (i + 0.5) * g.rowH;
  const yC = (n * g.rowH) / 2;
  // the inner end of the bar; a bar shorter than its own label starts its thread where the label ends, so threads never cut through the numbers
  const inner = Math.min(colW, Math.max(colW * f, labelEnd));
  const xi = side === 0 ? inner : w - inner;
  const xe = side === 0 ? w / 2 - g.plateW / 2 : w / 2 + g.plateW / 2;
  const dx = xe - xi;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M${r(xi)} ${r(yRow)}C${r(xi + dx * 0.55)} ${r(yRow)} ${r(xe - dx * 0.45)} ${r(yC)} ${r(xe)} ${r(yC)}`;
}

const Row = memo(function Row({ side, price, size, placeholder }: { side: 'buy' | 'sell'; price: string; size: string; placeholder: boolean }) {
  return (
    <div className={`${s.row} ${side === 'buy' ? s.buy : s.sell}`}>
      <i className={s.bar} data-bar="" aria-hidden="true" />
      {side === 'buy' ? (
        <>
          <span className={s.rowPrice}>{placeholder ? EM_DASH : price}</span>
          <span className={s.rowSize}>{placeholder ? EM_DASH : size}</span>
        </>
      ) : (
        <>
          <span className={s.rowSize}>{placeholder ? EM_DASH : size}</span>
          <span className={s.rowPrice}>{placeholder ? EM_DASH : price}</span>
        </>
      )}
    </div>
  );
});

const plainPrice = (p: number) => p.toFixed(2);
const labelChars = (l: BookLevel, compact: boolean) => (compact ? plainPrice(l.price) : fmtPrice(l.price)).length + fmtSize(l.size).length;

export function OrderFlow({ market, levels = 10, positionPrice }: { market: MarketState; levels?: number; positionPrice?: number | null }) {
  const n = Math.max(1, Math.min(25, Math.floor(levels)));
  const reduced = usePrefersReducedMotion();
  const [bodyRef, w] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const geo = useMemo(() => geoFor(w), [w]);

  const bids = useMemo(() => market.bids.slice(0, n), [market.bids, n]);
  const asks = useMemo(() => market.asks.slice(0, n), [market.asks, n]);
  const empty = bids.length === 0 && asks.length === 0;

  const totals = useMemo(() => {
    const buy = bids.reduce((a, l) => a + l.size, 0);
    const sell = asks.reduce((a, l) => a + l.size, 0);
    const sum = buy + sell;
    const buyPct = sum > 0 ? Math.round((buy / sum) * 100) : 50;
    return { buy, sell, buyPct, sellPct: 100 - buyPct, has: sum > 0 };
  }, [bids, asks]);

  // ---- imperative animation engine ---------------------------------------------------------------------------
  const engine = useRef({
    n: 0,
    shown: new Float64Array(0),
    painted: new Float64Array(0),
    flash: new Float64Array(0),
    target: new Float64Array(0),
    lab: new Float64Array(0),
    bars: [] as (HTMLElement | null)[],
    paths: [] as (SVGPathElement | null)[],
    raf: 0,
    last: 0,
    threads: true,
    w: 0,
    geo: geoFor(0),
    reduced: false,
    prev: [new Map<number, number>(), new Map<number, number>()] as [Map<number, number>, Map<number, number>],
  });

  const paint = (k: number, force = false) => {
    const e = engine.current;
    const side = (k < e.n ? 0 : 1) as 0 | 1;
    const i = k % e.n;
    const f = e.shown[k];
    // a bar is at most a few hundred px long: changes under ~0.2px are invisible, skip the DOM writes
    if (!force && Math.abs(f - e.painted[k]) * 400 < 0.2 && f !== e.target[k]) return;
    e.painted[k] = f;
    const bar = e.bars[k];
    if (bar) bar.style.transform = `scaleX(${f.toFixed(4)})`;
    const path = e.paths[k];
    if (path) {
      if (e.w > 0 && e.threads) {
        path.setAttribute('d', threadD(side, i, f, e.w, e.n, e.geo, e.lab[k]));
        // opacity / width follow the size in coarse steps: they change rarely, so they cost nothing per frame
        const op = String(Math.round((0.2 + 0.62 * f) * 25) / 25);
        if (path.style.strokeOpacity !== op) path.style.strokeOpacity = op;
        const sw = String(Math.round((0.8 + 1.3 * f) * 5) / 5);
        if (path.style.strokeWidth !== sw) path.style.strokeWidth = sw;
      } else if (path.style.strokeOpacity !== '0') path.style.strokeOpacity = '0';
    }
  };

  const frame = (ts: number) => {
    const e = engine.current;
    // ~30 repaints/s is plenty for a 0.1-0.5 s ease and halves the main-thread cost of the animation
    if (e.last && ts - e.last < 28) {
      e.raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(96, e.last ? ts - e.last : 16);
    e.last = ts;
    const k = e.reduced ? 1 : 1 - Math.exp(-dt / TAU_MS);
    let moving = false;
    const fk = e.reduced ? 0 : Math.exp(-dt / FLASH_TAU_MS);
    for (let j = 0; j < e.shown.length; j++) {
      const fl = e.flash[j];
      if (fl > 0) {
        const nf = fl * fk < 0.03 ? 0 : fl * fk;
        e.flash[j] = nf;
        const bar = e.bars[j];
        if (bar) bar.style.opacity = nf === 0 ? '' : String(Math.round((0.3 + 0.55 * nf) * 50) / 50);
        if (nf > 0) moving = true;
      }
      const t = e.target[j];
      let v = e.shown[j];
      if (v === t) continue;
      v += (t - v) * k;
      if (Math.abs(t - v) < 0.002) v = t;
      e.shown[j] = v;
      paint(j);
      if (v !== t) moving = true;
    }
    e.raf = moving ? requestAnimationFrame(frame) : 0;
    if (!moving) e.last = 0;
  };

  const kick = () => {
    const e = engine.current;
    if (e.raf === 0 && typeof requestAnimationFrame === 'function') e.raf = requestAnimationFrame(frame);
  };

  // bind DOM nodes (once per row count) and stop the loop on unmount
  useEffect(() => {
    const e = engine.current;
    e.n = n;
    e.shown = new Float64Array(2 * n);
    e.painted = new Float64Array(2 * n).fill(-1);
    e.flash = new Float64Array(2 * n);
    e.target = new Float64Array(2 * n);
    e.lab = new Float64Array(2 * n);
    e.bars = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[data-bar]') ?? []);
    e.paths = Array.from(svgRef.current?.querySelectorAll<SVGPathElement>('path') ?? []);
    // DOM order is: all buyer rows, then all seller rows; paths likewise
    return () => {
      if (e.raf) cancelAnimationFrame(e.raf);
      e.raf = 0;
    };
  }, [n, bodyRef]);

  // layout changes: repaint every thread
  useEffect(() => {
    const e = engine.current;
    e.w = w;
    e.geo = geo;
    e.reduced = reduced;
    for (let j = 0; j < e.shown.length; j++) paint(j, true);
  }, [w, geo, reduced, n]);

  // new book data: set targets, animate, flash the levels whose size changed
  useEffect(() => {
    const e = engine.current;
    if (e.shown.length !== 2 * n) return;
    e.threads = !empty;
    const max = Math.max(0, ...bids.map((l) => l.size), ...asks.map((l) => l.size));
    const flashes: number[] = [];
    const sides: BookLevel[][] = [bids, asks];
    for (let side = 0; side < 2; side++) {
      const rows = sides[side];
      const prev = e.prev[side];
      const next = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const l = rows[i];
        const k = side * n + i;
        e.target[k] = empty ? SKELETON[i % SKELETON.length] * 0.9 : l && max > 0 ? Math.max(BAR_MIN, l.size / max) : 0;
        e.lab[k] = l ? (labelChars(l, e.geo.compact) * (e.geo.compact ? 6.4 : 7.3)) + (e.geo.compact ? 14 : 23) : 0;
        if (l) {
          next.set(l.price, l.size);
          const before = prev.get(l.price);
          if (before !== undefined && Math.abs(before - l.size) >= 0.06 * Math.max(before, l.size)) flashes.push(k);
        }
      }
      e.prev[side] = next;
    }
    if (e.reduced) {
      e.shown.set(e.target);
      for (let j = 0; j < e.shown.length; j++) paint(j, true);
    } else {
      // the size-change flash is part of the same rAF loop (no per-flash animation objects)
      for (const k of flashes) e.flash[k] = 1;
      kick();
    }
  }, [bids, asks, empty, n]);

  const priceRef = useChangeFlash<HTMLDivElement>(market.price, s.flashUp, s.flashDown, reduced);
  const spread = market.bid !== null && market.ask !== null && market.ask >= market.bid ? market.ask - market.bid : null;
  const compact = geo.compact;
  const fp = compact ? plainPrice : fmtPrice;

  const rowsFor = (side: 'buy' | 'sell', list: BookLevel[]) =>
    Array.from({ length: n }, (_, i) => {
      const l = list[i];
      return <Row key={i} side={side} price={l ? fp(l.price) : ''} size={l ? fmtSize(l.size) : ''} placeholder={!l} />;
    });

  const style = { '--row-h': `${geo.rowH}px`, '--mid-w': `${geo.midW}px`, '--plate-w': `${geo.plateW}px` } as CSSProperties;

  return (
    <div className={`${s.root} ${s.of} ${compact ? s.compact : ''} ${empty ? s.empty : ''}`} style={style} role="group" aria-label="Order flow: buyers waiting on the left in green, sellers waiting on the right in red">
      <div className={s.ofHead}>
        <div className={s.ofTitleRow}>
          <span className={s.ofTitle}>Order flow</span>
          <span className={s.ofHint}>Who is waiting to trade</span>
        </div>
        <div>
          <div className={s.pressureLabels}>
            <span className={s.buyText}>Buyers {totals.has ? `${totals.buyPct}%` : EM_DASH}</span>
            <span className={s.sellText}>{totals.has ? `${totals.sellPct}%` : EM_DASH} Sellers</span>
          </div>
          <div className={s.pressureBar} aria-hidden="true">
            <div className={s.pressureBuy} style={{ transform: `scaleX(${(totals.has ? totals.buyPct : 50) / 100})` }} />
          </div>
          <div className={s.pressureTotals}>
            <span>{totals.has ? `${fmtSize(totals.buy)} ETH` : EM_DASH}</span>
            <span>{totals.has ? `${fmtSize(totals.sell)} ETH` : EM_DASH}</span>
          </div>
        </div>
      </div>

      <div className={s.ofBody} ref={bodyRef}>
        <svg ref={svgRef} className={s.threads} width={w || undefined} height={n * geo.rowH} aria-hidden="true">
          {Array.from({ length: n }, (_, i) => (
            <path key={`b${i}`} className={`${s.thread} ${s.threadBuy}`} />
          ))}
          {Array.from({ length: n }, (_, i) => (
            <path key={`s${i}`} className={`${s.thread} ${s.threadSell}`} />
          ))}
        </svg>
        <div className={s.col}>{rowsFor('buy', bids)}</div>
        <div className={s.mid}>
          <div className={s.plate}>
            <div className={s.plateLabel}>ETH price</div>
            <div ref={priceRef} className={s.platePrice}>
              {market.price === null ? EM_DASH : fmtPrice(market.price)}
            </div>
            <div className={s.plateSub}>{spread !== null ? `Spread ${fmtPrice(spread)}` : ' '}</div>
            {positionPrice !== null && positionPrice !== undefined && Number.isFinite(positionPrice) ? <div className={s.plateSub}>Entry {fmtPrice(positionPrice)}</div> : null}
          </div>
        </div>
        <div className={s.col}>{rowsFor('sell', asks)}</div>
      </div>

      {empty ? <div className={s.ofNote}>{market.status === 'live' || market.status === 'connecting' ? 'Waiting for the live order book…' : 'The live order book is reconnecting…'}</div> : null}
      <div className={s.ofLegend}>Green: people waiting to buy. Red: people waiting to sell. A longer bar means more ETH. Best prices are at the top.</div>
      {!empty ? (
        <p className="sr-only">
          Buy orders {fmtSize(totals.buy)} ETH ({totals.buyPct}%), sell orders {fmtSize(totals.sell)} ETH ({totals.sellPct}%). Best buy price {fmtPrice(bids[0]?.price)}, best sell price {fmtPrice(asks[0]?.price)}.
        </p>
      ) : null}
    </div>
  );
}
