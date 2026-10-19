export const usd = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const signedUsd = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const inr = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export const num = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
export const pctRaw = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`);

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined) return 'never';
  return `${duration(now - ts)} ago`;
}

export const timeShort = (ts: number | null | undefined): string => (ts ? new Date(ts).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
export const dayShort = (ts: number): string => new Date(ts).toLocaleDateString('en-GB', { month: 'short', day: '2-digit' });

/** Whole rupees with Indian digit grouping: ₹1,234. Used where paise would only add noise. */
export const inrWhole = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const r = Math.round(v);
  return `${r < 0 ? '−' : ''}₹${Math.abs(r).toLocaleString('en-IN')}`;
};

export const signedInr = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const r = Math.round(v);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}₹${Math.abs(r).toLocaleString('en-IN')}`;
};

/** Clock time of day in the viewer's timezone, e.g. 14:05. */
export const clockTime = (ts: number | null | undefined): string => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

/** "Today, 14:05" / "Yesterday, 23:10" / "12 Oct, 09:00" in the viewer's timezone. */
export function dayTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((start(new Date(now)) - start(d)) / 86_400_000);
  const hm = clockTime(ts);
  if (diffDays === 0) return `Today, ${hm}`;
  if (diffDays === 1) return `Yesterday, ${hm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm}`;
}
