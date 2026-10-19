'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { signedInr, signedUsd } from '@/lib/format';
import type { ResultTone } from '@/lib/simple';

/** Grey shimmering placeholder block while the first data loads. */
export function Skeleton({ h = 16, w = '100%', r = 8, style }: { h?: number; w?: number | string; r?: number; style?: React.CSSProperties }) {
  return <span className="sv-skel" aria-hidden style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function SideBadge({ side, small }: { side: 'long' | 'short'; small?: boolean }) {
  // neutral colour on purpose: a SHORT in profit must not look like a loss, a LONG that hit its stop must not look like a win
  return (
    <span className={`sv-side ${side} ${small ? 'sm' : ''}`}>
      <span aria-hidden>{side === 'long' ? '▲' : '▼'}</span> {side === 'long' ? 'LONG' : 'SHORT'}
    </span>
  );
}

const toneClass = (t: ResultTone) => (t === 'win' ? 'up' : t === 'loss' ? 'down' : '');

/** Signed dollar amount, coloured, with the sign glyph so colour is never the only cue. */
export function Money({ usd, tone, digits = 2 }: { usd: number | null | undefined; tone?: ResultTone; digits?: number }) {
  const t: ResultTone = tone ?? (usd === null || usd === undefined || usd === 0 ? 'flat' : usd > 0 ? 'win' : 'loss');
  return <span className={`tabnum ${toneClass(t)}`}>{signedUsd(usd, digits)}</span>;
}

export function Rupees({ inr, tone }: { inr: number | null | undefined; tone?: ResultTone }) {
  const t: ResultTone = tone ?? (inr === null || inr === undefined || Math.round(inr) === 0 ? 'flat' : inr > 0 ? 'win' : 'loss');
  return <span className={`tabnum ${toneClass(t)}`}>{signedInr(inr)}</span>;
}

/** Re-render the caller every `ms` (default 1 s) so elapsed-time texts keep moving. Pauses while the tab is hidden. */
export function useTicker(ms = 1000): void {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) set((n) => n + 1);
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** True below the given width; false until mounted so the server render and the first client render agree. */
export function useNarrow(maxWidth = 700): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [maxWidth]);
  return narrow;
}

export function CardShell({ title, hint, right, children, className = '', area, label }: { title?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; area?: string; label?: string }) {
  return (
    <section className={`card sv-card ${className}`} style={area ? { gridArea: area } : undefined} aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      {(title || right) && (
        <header className="sv-card-head">
          <div>
            {title && <h2 className="sv-card-title">{title}</h2>}
            {hint && <div className="sv-card-hint">{hint}</div>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}
