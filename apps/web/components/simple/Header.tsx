'use client';

import { useEffect, useRef, useState } from 'react';
import type { BotState, Me } from '@/lib/types';

export type SimplePage = 'overview' | 'history';

export function modeChip(state: BotState): { tone: 'demo' | 'live' | 'warn'; text: string } {
  if (state.mode === 'live' && state.liveArmed) {
    return state.deployment.realMoney ? { tone: 'live', text: 'LIVE - real money' } : { tone: 'live', text: 'LIVE (test) - sandbox money' };
  }
  if (state.mode === 'live') return { tone: 'warn', text: 'LIVE selected - not active, no orders' };
  return { tone: 'demo', text: 'DEMO - simulated, no real money' };
}

export function botStatus(state: BotState): { tone: 'good' | 'warn' | 'crit'; text: string } {
  if (state.killSwitch) return { tone: 'crit', text: 'Emergency stop is on' };
  if (!state.workerActive) return { tone: 'warn', text: 'Algo is offline on this server' };
  if (!state.running) return { tone: 'warn', text: 'Algo is paused' };
  if (state.demo?.openPosition) return { tone: 'good', text: 'Algo is in a trade' };
  return { tone: 'good', text: 'Algo is watching the market' };
}

/**
 * Top of the simple view: app name, the mode chip (always says DEMO unless the backend reports live armed), the algo's
 * status in plain words, Overview / History, and a small menu. The price feed's own state is shown on the price card.
 */
export function SimpleHeader({
  state,
  me,
  isAdmin,
  page,
  onPage,
  onDeveloper,
  onKill,
  onLogout,
  onToggleTheme,
}: {
  state: BotState;
  me: Me | null;
  isAdmin: boolean;
  page: SimplePage;
  onPage: (p: SimplePage) => void;
  onDeveloper: () => void;
  onKill: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
}) {
  const chip = modeChip(state);
  const bot = botStatus(state);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const items = () => Array.from(box.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (label: string, fn: () => void, cls = '') => (
    <button
      role="menuitem"
      className={`sv-menu-item ${cls}`}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );

  return (
    <header className="sv-header">
      <div className="sv-header-row">
        <div className="sv-brand">
          <span className="sv-logo" aria-hidden>C</span>
          <div>
            <h1>CryptoAlgo</h1>
            <div className="sv-brand-sub">{state.spec?.symbol ?? 'ETH'} algo</div>
          </div>
        </div>

        <nav className="sv-seg" aria-label="Pages">
          <button aria-current={page === 'overview' ? 'page' : undefined} onClick={() => onPage('overview')}>Overview</button>
          <button aria-current={page === 'history' ? 'page' : undefined} onClick={() => onPage('history')}>History</button>
        </nav>

        <div className="sv-menu" ref={box}>
          <button ref={btn} className="sv-menu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="sv-burger" aria-hidden />
            Menu
          </button>
          {open && (
            <div className="sv-menu-pop" role="menu" aria-label="Menu">
              {item('Developer view', onDeveloper)}
              {item('Switch light / dark', onToggleTheme)}
              {isAdmin && item(state.killSwitch ? 'Release emergency stop' : 'Emergency stop', onKill, state.killSwitch ? '' : 'danger')}
              {item(`Sign out${me ? ` (${me.username})` : ''}`, onLogout)}
            </div>
          )}
        </div>
      </div>

      <div className="sv-chips" role="status" aria-live="polite">
        <span className={`sv-mode ${chip.tone}`}>{chip.text}</span>
        <span className={`sv-status ${bot.tone}`}><i className="sv-dot" aria-hidden />{bot.text}</span>
      </div>
    </header>
  );
}
