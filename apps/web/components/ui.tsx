'use client';

import { useEffect, type ReactNode } from 'react';
import { signedUsd } from '@/lib/format';
import type { RiskCheck } from '@/lib/types';

export function Card({ title, hint, right, children, className = '' }: { title?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header>
          <div>
            {title && <h3>{title}</h3>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone, wide }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad'; wide?: boolean }) {
  return (
    <div className={`card stat ${wide ? 'wide' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value tabnum ${tone ?? ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Tag({ children, kind }: { children: ReactNode; kind?: 'sim' | 'real' | 'warn' | 'good' | 'crit' }) {
  return <span className={`tag ${kind ?? ''}`}>{children}</span>;
}

/** Signed P&L text: sign glyph + colour, so direction never relies on colour alone. */
export function Pnl({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  return <span className={`tabnum ${v > 0 ? 'good' : v < 0 ? 'bad' : ''}`}>{signedUsd(v, digits)}</span>;
}

const CHECK_TITLES: Record<string, string> = {
  KILL_SWITCH: 'Kill switch released',
  LIVE_NOT_ARMED: 'Live execution armed',
  SPEC_UNVERIFIED: 'Contract verified with exchange',
  TRADING_STATUS: 'Contract tradable',
  STALE_DATA: 'Market data fresh',
  API_UNHEALTHY: 'Exchange connectivity',
  NOT_RECONCILED: 'Exchange state in sync',
  MAX_OPEN_POSITIONS: 'Open positions',
  MAX_TRADES_24H: 'Trades in rolling 24h',
  DAILY_LOSS_LIMIT: 'Daily loss limit',
  MAX_DRAWDOWN: 'Drawdown limit',
  CONSECUTIVE_LOSSES: 'Loss-streak breaker',
  COOLDOWN: 'Post-loss cooldown',
  PENDING_ORDER: 'No order in flight',
  MIN_BALANCE: 'Available balance',
  SPREAD: 'Spread',
  DUPLICATE_SIGNAL: 'Not a duplicate signal',
  QUANTITY: 'Quantity valid',
  LEVERAGE: 'Leverage within limit',
  PER_TRADE_RISK: 'Per-trade risk',
  NET_REWARD: 'Net reward after fees',
  NET_REWARD_RISK: 'Net reward : risk',
  FREE_MARGIN: 'Free margin',
  LIQUIDATION_BUFFER: 'Liquidation buffer',
};

export function Checks({ checks, onlyFailed }: { checks: RiskCheck[]; onlyFailed?: boolean }) {
  const list = onlyFailed ? checks.filter((c) => !c.ok) : checks;
  if (!list.length) return <div className="muted">All checks passing.</div>;
  return (
    <ul className="checks">
      {list.map((c) => (
        <li key={c.code}>
          <span className={`mark ${c.ok ? 'ok' : 'no'}`} aria-label={c.ok ? 'pass' : 'fail'}>{c.ok ? '✓' : '✕'}</span>
          <span>
            <b>{CHECK_TITLES[c.code] ?? c.code.replace(/_/g, ' ').toLowerCase()}</b> <span className="sec">— {c.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'dialog'} style={wide ? { maxWidth: 820 } : undefined}>
        <h2>{title}</h2>
        {children}
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Toast({ message, error }: { message: string | null; error?: boolean }) {
  if (!message) return null;
  return <div className={`toast ${error ? 'err' : ''}`} role="status">{message}</div>;
}
