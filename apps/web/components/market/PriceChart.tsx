'use client';
import { memo, useId, useMemo } from 'react';
import type { MarketCandle, MarketState, PositionLines } from '../../lib/market/types';
import { computeDomain, spreadLabels, timeStepMinutes, yTicks, type Domain } from '../../lib/market/chartMath';
import { fmtClock, fmtPrice, fmtWhole, prettySymbol } from '../../lib/market/format';
import { useElementWidth } from './hooks';
import s from './market.module.css';

const PAD_T = 10;
const PAD_B = 20;
const PAD_L = 6;

interface Geometry {
  width: number;
  height: number;
  padR: number;
  plotW: number;
  plotH: number;
  slot: number;
  domain: Domain;
}

const yOf = (g: Geometry, v: number) => PAD_T + ((g.domain.max - v) / (g.domain.max - g.domain.min)) * g.plotH;
const xOf = (g: Geometry, i: number) => PAD_L + g.slot * (i + 0.5);
const px = (n: number) => Math.round(n * 10) / 10;

/** Wicks and bodies of all closed candles as four paths (not one element per candle). Rebuilt only when the data or the scale really changes. */
const ClosedCandles = memo(function ClosedCandles({ candles, g }: { candles: MarketCandle[]; g: Geometry }) {
  const { upWick, upBody, downWick, downBody } = useMemo(() => {
    const bodyW = Math.max(1, Math.min(14, Math.floor(g.slot * 0.7)));
    let uw = '';
    let ub = '';
    let dw = '';
    let db = '';
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const x = Math.round(xOf(g, i)) + 0.5;
      const yH = px(yOf(g, c.h));
      const yL = px(yOf(g, c.l));
      const yO = yOf(g, c.o);
      const yC = yOf(g, c.c);
      const top = px(Math.min(yO, yC));
      const h = Math.max(1, px(Math.abs(yO - yC)));
      const x0 = px(x - bodyW / 2);
      const wick = `M${x} ${yH}V${yL}`;
      const body = `M${x0} ${top}h${bodyW}v${h}h${-bodyW}z`;
      if (c.c >= c.o) {
        uw += wick;
        ub += body;
      } else {
        dw += wick;
        db += body;
      }
    }
    return { upWick: uw, upBody: ub, downWick: dw, downBody: db };
  }, [candles, g.width, g.height, g.slot, g.domain.min, g.domain.max]);
  return (
    <g>
      {downWick ? <path d={downWick} className={`${s.wick} ${s.down}`} /> : null}
      {downBody ? <path d={downBody} className={`${s.body} ${s.down}`} /> : null}
      {upWick ? <path d={upWick} className={`${s.wick} ${s.up}`} /> : null}
      {upBody ? <path d={upBody} className={`${s.body} ${s.up}`} /> : null}
    </g>
  );
});

/**
 * Live 1-minute candlestick chart (SVG). The last candle follows every price tick; optional dashed lines mark the entry,
 * stop and target of the running trade. No pointer interaction on purpose (nothing to mis-click on a phone).
 */
export function PriceChart({ market, positionLines, height = 260 }: { market: MarketState; positionLines?: PositionLines | null; height?: number }) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const uid = useId();
  const compact = width > 0 && width < 420;
  const padR = compact ? 64 : 70;
  const plotW = Math.max(0, width - PAD_L - padR);
  const plotH = Math.max(0, height - PAD_T - PAD_B);
  const perCandle = compact ? 5 : 6;
  const maxVisible = Math.max(20, Math.floor(plotW / perCandle));

  const all = market.candles;
  const visible = useMemo(() => (all.length > maxVisible ? all.slice(all.length - maxVisible) : all), [all, maxVisible]);
  const closed = useMemo(() => visible.slice(0, -1), [visible]);
  const forming = visible.length ? visible[visible.length - 1] : null;
  const price = market.price;

  const domain = useMemo(
    () => computeDomain(visible, [price, positionLines?.entry, positionLines?.stop, positionLines?.target]),
    [visible, price, positionLines?.entry, positionLines?.stop, positionLines?.target],
  );

  const ready = width > 0 && domain !== null && plotW > 40 && plotH > 40 && visible.length > 0;
  const slotCount = Math.max(visible.length, 24) + 2;
  const dMin = domain?.min ?? 0;
  const dMax = domain?.max ?? 0;
  const g = useMemo<Geometry | null>(
    () => (ready ? { width, height, padR, plotW, plotH, slot: plotW / slotCount, domain: { min: dMin, max: dMax } } : null),
    [ready, width, height, padR, plotW, plotH, slotCount, dMin, dMax],
  );

  // closed candles keep their array identity between ticks only if the content did not change, so key the memo on a cheap fingerprint
  const lastClosed = closed.length ? closed[closed.length - 1] : null;
  const closedKey = `${closed.length}|${closed[0]?.t ?? 0}|${lastClosed?.t ?? 0}|${lastClosed?.c ?? 0}|${lastClosed?.h ?? 0}|${lastClosed?.l ?? 0}`;
  const stableClosed = useMemo(() => closed, [closedKey]);

  const title = `${prettySymbol(market.symbol)} price chart`;
  const first = visible[0];
  const desc =
    price === null || !first
      ? 'Waiting for price data.'
      : `Last price ${fmtPrice(price)}. ${visible.length} one-minute candles from ${fmtClock(first.t)} to ${fmtClock(visible[visible.length - 1].t)} India time.` +
        (positionLines ? ` Open ${positionLines.side} trade: entry ${fmtPrice(positionLines.entry)}, stop ${fmtPrice(positionLines.stop)}, target ${fmtPrice(positionLines.target)}.` : '');

  const empty = visible.length === 0;

  return (
    <div className={`${s.root} ${s.chartWrap}`} ref={wrapRef} style={{ height }}>
      {g ? (
        <svg className={s.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${uid}-t ${uid}-d`}>
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{desc}</desc>
          <Axes g={g} candles={visible} priceY={price === null ? null : Math.min(PAD_T + g.plotH - 1, Math.max(PAD_T + 1, yOf(g, price)))} />
          <ClosedCandles candles={stableClosed} g={g} />
          {forming ? <FormingCandle c={forming} index={visible.length - 1} g={g} /> : null}
          {price !== null ? <LastPrice g={g} price={price} prevClose={closed.length ? closed[closed.length - 1].c : forming ? forming.o : price} lastX={xOf(g, visible.length - 1)} /> : null}
          {positionLines ? <Lines g={g} lines={positionLines} /> : null}
        </svg>
      ) : null}
      {empty ? (
        <div className={`${s.chartEmpty} ${s.skeleton}`} role="status">
          {market.status === 'connecting' ? 'Loading chart…' : 'Chart data is not available yet'}
        </div>
      ) : null}
    </div>
  );
}

function Axes({ g, candles, priceY }: { g: Geometry; candles: MarketCandle[]; priceY: number | null }) {
  const ticks = useMemo(() => yTicks(g.domain, compactTicks(g.plotH)), [g.domain, g.plotH]);
  const whole = ticks.length > 1 && Number.isInteger(ticks[1] - ticks[0]);
  const stepMin = timeStepMinutes(g.slot);
  const labels: { x: number; text: string }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const minute = Math.round(candles[i].t / 60000);
    if (minute % stepMin === 0) {
      const x = xOf(g, i);
      if (x > 22 && x < g.width - g.padR - 14) labels.push({ x, text: fmtClock(candles[i].t) });
    }
  }
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line className={s.gridLine} x1={PAD_L} x2={g.width - g.padR} y1={Math.round(yOf(g, v)) + 0.5} y2={Math.round(yOf(g, v)) + 0.5} />
          {priceY !== null && Math.abs(yOf(g, v) - priceY) < 12 ? null : (
            <text className={s.axisText} x={g.width - g.padR + 6} y={yOf(g, v) + 3.5}>
              {whole ? fmtWhole(v) : fmtPrice(v)}
            </text>
          )}
        </g>
      ))}
      {labels.map((l) => (
        <text key={l.text + l.x} className={s.axisText} x={l.x} y={g.height - 5} textAnchor="middle">
          {l.text}
        </text>
      ))}
    </g>
  );
}

const compactTicks = (plotH: number) => (plotH < 150 ? 3 : plotH < 220 ? 4 : 5);

function FormingCandle({ c, index, g }: { c: MarketCandle; index: number; g: Geometry }) {
  const bodyW = Math.max(1, Math.min(14, Math.floor(g.slot * 0.7)));
  const x = Math.round(xOf(g, index)) + 0.5;
  const yO = yOf(g, c.o);
  const yC = yOf(g, c.c);
  const up = c.c >= c.o;
  return (
    <g className={up ? s.up : s.down}>
      <path className={s.wick} d={`M${x} ${px(yOf(g, c.h))}V${px(yOf(g, c.l))}`} />
      <rect className={s.body} x={px(x - bodyW / 2)} y={px(Math.min(yO, yC))} width={bodyW} height={Math.max(1, px(Math.abs(yO - yC)))} />
    </g>
  );
}

function LastPrice({ g, price, prevClose, lastX }: { g: Geometry; price: number; prevClose: number; lastX: number }) {
  const y = Math.min(PAD_T + g.plotH - 1, Math.max(PAD_T + 1, yOf(g, price)));
  const up = price >= prevClose;
  const colour = up ? 'var(--of-buy)' : 'var(--of-sell)';
  const text = fmtPrice(price);
  const tagW = text.length * 6.6 + 10;
  return (
    <g>
      <line className={s.lastLine} x1={PAD_L} x2={g.width - g.padR} y1={y} y2={y} style={{ stroke: colour }} />
      <circle className={s.lastDot} cx={lastX} cy={y} r={3} style={{ fill: colour }} />
      <rect x={g.width - g.padR + 1} y={y - 9} width={Math.min(tagW, g.padR - 1)} height={18} rx={4} style={{ fill: colour }} />
      <text className={s.lastTag} x={g.width - g.padR + 5} y={y + 4}>
        {text}
      </text>
    </g>
  );
}

function Lines({ g, lines }: { g: Geometry; lines: PositionLines }) {
  const items = [
    { key: 'target', label: 'Target', value: lines.target, line: s.posTarget, text: s.posTargetText, border: 'var(--of-buy)' },
    { key: 'entry', label: 'Entry', value: lines.entry, line: s.posEntry, text: s.posEntryText, border: 'var(--axis, #c3c2b7)' },
    { key: 'stop', label: 'Stop', value: lines.stop, line: s.posStop, text: s.posStopText, border: 'var(--of-sell)' },
  ]
    .filter((i) => Number.isFinite(i.value))
    .map((i) => ({ ...i, y: yOf(g, i.value) }))
    .sort((a, b) => a.y - b.y);
  const placed = spreadLabels(
    items.map((i) => i.y - 3),
    14,
    PAD_T + 10,
    PAD_T + g.plotH - 3,
  );
  return (
    <g>
      {items.map((i, n) => {
        const label = `${i.label} ${fmtPrice(i.value)}`;
        const w = label.length * 6.3 + 10;
        return (
          <g key={i.key}>
            <line className={`${s.posLine} ${i.line}`} x1={PAD_L} x2={g.width - g.padR} y1={i.y} y2={i.y} />
            <rect className={s.posLabelBg} x={PAD_L + 4} y={placed[n] - 10} width={w} height={14} rx={3} style={{ stroke: i.border }} />
            <text className={`${s.posLabel} ${i.text}`} x={PAD_L + 9} y={placed[n] + 0.5}>
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
