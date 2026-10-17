'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Small dependency-free SVG charts following the data-viz spec: 2px lines, ~10% area wash, bars <= 24px
 * with a 4px rounded data end, hairline solid gridlines, 8px+ end markers with a surface ring,
 * crosshair + tooltip on hover, selective direct labels, legend for >= 2 series, and a table view.
 */

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.floor(e.contentRect.width))));
    ro.observe(el);
    setW(Math.max(220, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function niceTicks(min: number, max: number, n = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step0 = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.5; v += step) out.push(+v.toFixed(10));
  return out;
}

export const compact = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  return `${+v.toFixed(2)}`;
};

function ChartFrame({ title, subtitle, children, table, legend }: { title: string; subtitle?: ReactNode; children: ReactNode; table?: { head: string[]; rows: (string | number)[][] }; legend?: { label: string; color: string }[] }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure style={{ margin: 0 }}>
      <div className="chart-head">
        <figcaption>
          <h3>{title}</h3>
          {subtitle && <div className="hint">{subtitle}</div>}
        </figcaption>
        {table && (
          <button className="linkbtn" onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
            {showTable ? 'Show chart' : 'View as table'}
          </button>
        )}
      </div>
      {showTable && table ? (
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto', marginTop: 8 }}>
          <table>
            <thead>
              <tr>{table.head.map((h, i) => <th key={h} className={i ? 'num' : ''}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
      {legend && legend.length > 1 && !showTable && (
        <div className="legend">
          {legend.map((l) => (
            <span key={l.label}><i style={{ background: l.color }} />{l.label}</span>
          ))}
        </div>
      )}
    </figure>
  );
}

export interface Pt {
  x: number;
  y: number;
}
export interface Marker {
  y: number;
  label: string;
  color: string;
}

export function LineChart({
  title,
  subtitle,
  points,
  color = 'var(--series-1)',
  height = 220,
  yFmt = compact,
  xFmt = (x: number) => new Date(x).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  tipFmt,
  area = true,
  zeroLine = false,
  markers = [],
  yDomain,
  tableHead = ['Time', 'Value'],
  empty = 'No data yet',
}: {
  title: string;
  subtitle?: ReactNode;
  points: Pt[];
  color?: string;
  height?: number;
  yFmt?: (v: number) => string;
  xFmt?: (x: number) => string;
  tipFmt?: (p: Pt) => string;
  area?: boolean;
  zeroLine?: boolean;
  markers?: Marker[];
  yDomain?: [number, number];
  tableHead?: string[];
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 50, r: markers.length ? 76 : 18, t: 10, b: 22 };
  const iw = Math.max(50, width - m.l - m.r);
  const ih = height - m.t - m.b;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = [...points.map((p) => p.y), ...markers.map((k) => k.y)];
    let lo = yDomain ? yDomain[0] : Math.min(...ys, zeroLine ? 0 : Infinity);
    let hi = yDomain ? yDomain[1] : Math.max(...ys, zeroLine ? 0 : -Infinity);
    const pad = (hi - lo) * 0.08 || 1;
    if (!yDomain) {
      lo -= pad;
      hi += pad;
    }
    const ticks = niceTicks(lo, hi, 4).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const sx = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * iw;
    const sy = (y: number) => m.t + (1 - (y - lo) / (hi - lo || 1)) * ih;
    return { lo, hi, ticks, x0, x1, sx, sy };
  }, [points, markers, yDomain, zeroLine, iw, ih, m.l, m.t]);

  const table = { head: tableHead, rows: points.slice(-200).map((p) => [xFmt(p.x), yFmt(p.y)]) };

  return (
    <ChartFrame title={title} subtitle={subtitle} table={points.length ? table : undefined}>
      <div className="chart" ref={ref} style={{ height }}>
        {!geom ? (
          <div className="empty" style={{ paddingTop: height / 3 }}>{empty}</div>
        ) : (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${title}. ${points.length} points from ${yFmt(points[0].y)} to ${yFmt(points[points.length - 1].y)}.`}
              onMouseMove={(e) => {
                const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const x = e.clientX - r.left;
                const xv = geom.x0 + ((x - m.l) / iw) * (geom.x1 - geom.x0);
                let best = 0;
                let bd = Infinity;
                for (let i = 0; i < points.length; i++) {
                  const d = Math.abs(points[i].x - xv);
                  if (d < bd) {
                    bd = d;
                    best = i;
                  }
                }
                setHover(best);
              }}
              onMouseLeave={() => setHover(null)}
              onTouchMove={(e) => {
                const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const x = e.touches[0].clientX - r.left;
                const xv = geom.x0 + ((x - m.l) / iw) * (geom.x1 - geom.x0);
                let best = 0;
                let bd = Infinity;
                points.forEach((p, i) => {
                  const d = Math.abs(p.x - xv);
                  if (d < bd) {
                    bd = d;
                    best = i;
                  }
                });
                setHover(best);
              }}
            >
              {geom.ticks.map((t) => (
                <g key={t}>
                  <line className="gridline" x1={m.l} x2={m.l + iw} y1={geom.sy(t)} y2={geom.sy(t)} />
                  <text x={m.l - 8} y={geom.sy(t) + 4} textAnchor="end">{yFmt(t)}</text>
                </g>
              ))}
              {zeroLine && geom.lo < 0 && geom.hi > 0 && <line className="axisline" x1={m.l} x2={m.l + iw} y1={geom.sy(0)} y2={geom.sy(0)} />}
              <line className="axisline" x1={m.l} x2={m.l + iw} y1={m.t + ih} y2={m.t + ih} />
              {[0, 0.5, 1].map((f) => {
                const x = geom.x0 + f * (geom.x1 - geom.x0);
                return <text key={f} x={m.l + f * iw} y={height - 5} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{xFmt(x)}</text>;
              })}
              {area && (
                <path
                  d={`M${geom.sx(points[0].x)},${m.t + ih} ${points.map((p) => `L${geom.sx(p.x)},${geom.sy(p.y)}`).join(' ')} L${geom.sx(points[points.length - 1].x)},${m.t + ih} Z`}
                  fill={color}
                  opacity={0.1}
                />
              )}
              {markers.map((k) => (
                <g key={k.label}>
                  <line x1={m.l} x2={m.l + iw} y1={geom.sy(k.y)} y2={geom.sy(k.y)} stroke={k.color} strokeWidth={1} opacity={0.9} />
                  <circle cx={m.l + iw} cy={geom.sy(k.y)} r={4} fill={k.color} stroke="var(--surface)" strokeWidth={2} />
                  <text x={m.l + iw + 9} y={geom.sy(k.y) + 4}>{k.label}</text>
                </g>
              ))}
              <polyline points={points.map((p) => `${geom.sx(p.x)},${geom.sy(p.y)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* end marker: 8px dot with a 2px surface ring */}
              <circle cx={geom.sx(points[points.length - 1].x)} cy={geom.sy(points[points.length - 1].y)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
              {hover !== null && (
                <g>
                  <line x1={geom.sx(points[hover].x)} x2={geom.sx(points[hover].x)} y1={m.t} y2={m.t + ih} stroke="var(--axis)" strokeWidth={1} />
                  <circle cx={geom.sx(points[hover].x)} cy={geom.sy(points[hover].y)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />
                </g>
              )}
            </svg>
            {hover !== null && (
              <div className="tip" style={{ left: Math.min(Math.max(geom.sx(points[hover].x), 60), width - 60), top: geom.sy(points[hover].y) }}>
                <b>{tipFmt ? tipFmt(points[hover]) : yFmt(points[hover].y)}</b>
                <span className="muted">{xFmt(points[hover].x)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </ChartFrame>
  );
}

export interface Bar {
  label: string;
  value: number;
  sub?: string;
}

/** Vertical columns. `diverging` colours gains/losses with the blue/red diverging pair (sign also shown in tooltips/labels). */
export function BarChart({
  title,
  subtitle,
  bars,
  height = 200,
  diverging = false,
  color = 'var(--series-1)',
  yFmt = compact,
  tipFmt,
  empty = 'No data yet',
  maxXLabels = 8,
}: {
  title: string;
  subtitle?: ReactNode;
  bars: Bar[];
  height?: number;
  diverging?: boolean;
  color?: string;
  yFmt?: (v: number) => string;
  tipFmt?: (b: Bar) => string;
  empty?: string;
  maxXLabels?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 50, r: 12, t: 12, b: 26 };
  const iw = Math.max(50, width - m.l - m.r);
  const ih = height - m.t - m.b;
  const vals = bars.map((b) => b.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.1 || 1;
  const ticks = niceTicks(lo < 0 ? lo - pad : lo, hi + pad, 4);
  const dlo = Math.min(...ticks);
  const dhi = Math.max(...ticks);
  const sy = (v: number) => m.t + (1 - (v - dlo) / (dhi - dlo || 1)) * ih;
  const slot = iw / Math.max(1, bars.length);
  const bw = Math.min(24, Math.max(3, slot - 4));
  const extreme = vals.length ? vals.reduce((a, v, i) => (Math.abs(v) > Math.abs(vals[a]) ? i : a), 0) : -1;
  const every = Math.max(1, Math.ceil(bars.length / maxXLabels));
  const table = { head: ['Bucket', 'Value'], rows: bars.map((b) => [b.label, tipFmt ? tipFmt(b) : yFmt(b.value)]) };

  return (
    <ChartFrame title={title} subtitle={subtitle} table={bars.length ? table : undefined}>
      <div className="chart" ref={ref} style={{ height }}>
        {bars.length === 0 ? (
          <div className="empty" style={{ paddingTop: height / 3 }}>{empty}</div>
        ) : (
          <>
            <svg width={width} height={height} role="img" aria-label={`${title}: ${bars.length} bars`} onMouseLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <g key={t}>
                  <line className="gridline" x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} />
                  <text x={m.l - 8} y={sy(t) + 4} textAnchor="end">{yFmt(t)}</text>
                </g>
              ))}
              <line className="axisline" x1={m.l} x2={m.l + iw} y1={sy(0)} y2={sy(0)} />
              {bars.map((b, i) => {
                const cx = m.l + slot * i + slot / 2;
                const y0 = sy(0);
                const y1 = sy(b.value);
                const up = b.value >= 0;
                const h = Math.max(1, Math.abs(y1 - y0));
                const top = up ? y1 : y0;
                const fill = diverging ? (up ? 'var(--pos)' : 'var(--neg)') : color;
                // 4px rounded data-end, square at the baseline
                const r = Math.min(4, bw / 2, h);
                const x = cx - bw / 2;
                const path = up
                  ? `M${x},${top + h} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + bw - r},${top} Q${x + bw},${top} ${x + bw},${top + r} L${x + bw},${top + h} Z`
                  : `M${x},${top} L${x},${top + h - r} Q${x},${top + h} ${x + r},${top + h} L${x + bw - r},${top + h} Q${x + bw},${top + h} ${x + bw},${top + h - r} L${x + bw},${top} Z`;
                return (
                  <g key={i} onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)}>
                    <rect x={cx - slot / 2} y={m.t} width={slot} height={ih} fill="transparent" />
                    <path d={path} fill={fill} opacity={hover === null || hover === i ? 1 : 0.55} />
                    {i === extreme && (
                      <text x={cx} y={up ? top - 5 : top + h + 13} textAnchor="middle" style={{ fill: 'var(--ink-2)', fontWeight: 600 }}>{yFmt(b.value)}</text>
                    )}
                    {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle">{b.label}</text>}
                  </g>
                );
              })}
            </svg>
            {hover !== null && bars[hover] && (
              <div className="tip" style={{ left: Math.min(Math.max(m.l + slot * hover + slot / 2, 60), width - 60), top: sy(bars[hover].value) }}>
                <b>{tipFmt ? tipFmt(bars[hover]) : yFmt(bars[hover].value)}</b>
                <span className="muted">{bars[hover].label}{bars[hover].sub ? ` · ${bars[hover].sub}` : ''}</span>
              </div>
            )}
          </>
        )}
      </div>
    </ChartFrame>
  );
}

/** Horizontal bars (value at the tip) for categorical comparisons such as exit reasons. */
export function HBarChart({ title, subtitle, bars, color = 'var(--series-1)', fmt = (v: number) => String(v), empty = 'No data yet' }: { title: string; subtitle?: ReactNode; bars: Bar[]; color?: string; fmt?: (v: number) => string; empty?: string }) {
  const max = Math.max(1e-9, ...bars.map((b) => Math.abs(b.value)));
  return (
    <ChartFrame title={title} subtitle={subtitle} table={bars.length ? { head: ['Category', 'Value'], rows: bars.map((b) => [b.label, fmt(b.value)]) } : undefined}>
      {bars.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <div role="img" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {bars.map((b) => (
            <div key={b.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 130px) 1fr', gap: 10, alignItems: 'center' }} title={`${b.label}: ${fmt(b.value)}`}>
              <span className="sec" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ height: 14, width: `${Math.max(1, (Math.abs(b.value) / max) * 100)}%`, maxWidth: 'calc(100% - 56px)', background: color, borderRadius: '0 4px 4px 0' }} />
                <span className="tabnum" style={{ fontSize: 12, fontWeight: 600 }}>{fmt(b.value)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </ChartFrame>
  );
}

export function Meter({ value, max, tone, label }: { value: number; max: number; tone?: 'warn' | 'crit'; label: string }) {
  const p = Math.min(100, Math.max(0, max > 0 ? (value / max) * 100 : 0));
  return (
    <div role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label} className={`meter ${tone ?? (p >= 100 ? 'crit' : p >= 75 ? 'warn' : '')}`}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}
