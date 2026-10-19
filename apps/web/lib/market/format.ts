const priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sizeFmt1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const sizeFmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const EM_DASH = '—';
const MINUS = '−';

/** 3,390.45 (never NaN) */
export function fmtPrice(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? EM_DASH : priceFmt.format(n);
}

/** 3,390 (axis labels when the grid step is a whole number) */
export function fmtWhole(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : EM_DASH;
}

/** ETH size for a book level: 12.34, 123.4, 1.2k */
export function fmtSize(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return sizeFmt1.format(n);
  return sizeFmt2.format(n);
}

/** +0.45% / −0.45% */
export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  const body = Math.abs(n).toFixed(digits);
  return `${n > 0 && Number(body) > 0 ? '+' : n < 0 && Number(body) > 0 ? MINUS : ''}${body}%`;
}

const istFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : null;

/** HH:MM in Indian Standard Time (the operator's clock) */
export function fmtClock(ms: number): string {
  return istFmt ? istFmt.format(new Date(ms)) : new Date(ms).toISOString().slice(11, 16);
}

/** "12s", "3m 05s" */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "ETHUSD" -> "ETH / USD" */
export function prettySymbol(symbol: string): string {
  const m = /^([A-Z0-9]{2,6}?)(USDT|USD|INR)$/.exec(symbol);
  return m ? `${m[1]} / ${m[2]}` : symbol;
}
