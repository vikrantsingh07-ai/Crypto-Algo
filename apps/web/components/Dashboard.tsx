'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ago, num } from '@/lib/format';
import type { BotState, Me } from '@/lib/types';
import ActivationWizard from './ActivationWizard';
import AnalyticsPanel from './AnalyticsPanel';
import DemoPanel from './DemoPanel';
import LivePanel from './LivePanel';
import SettingsPanel from './SettingsPanel';
import { Modal, Toast } from './ui';

type Tab = 'demo' | 'live' | 'settings' | 'analytics';

export interface Actions {
  isAdmin: boolean;
  run: <T = any>(label: string, fn: () => Promise<T>, okMsg?: string) => Promise<T | undefined>;
  refresh: () => Promise<void>;
  openWizard: () => void;
  confirmDemoSwitch: () => void;
  confirmKill: () => void;
}

export default function Dashboard() {
  const [state, setState] = useState<BotState | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('demo');
  const [lost, setLost] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [wizard, setWizard] = useState(false);
  const [confirm, setConfirm] = useState<null | 'demo' | 'kill' | 'release'>(null);
  const [busy, setBusy] = useState(false);
  const [killReason, setKillReason] = useState('');
  const [, force] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), err ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<BotState>('GET', 'state');
      setState(s);
      setLost(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 502) setLost('The trading backend is unreachable from the dashboard.');
      else if (e instanceof ApiError) setLost(e.message);
      else setLost('Connection to the dashboard server lost.');
    }
  }, []);

  useEffect(() => {
    void api<Me>('GET', 'auth/me').then(setMe).catch(() => {});
    void refresh();
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) await refresh();
        loop();
      }, document.hidden ? 8000 : 2000);
    };
    loop();
    const tick = setInterval(() => force((n) => n + 1), 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [refresh]);

  const isAdmin = me?.role === 'admin';

  const run: Actions['run'] = useCallback(
    async (label, fn, okMsg) => {
      setBusy(true);
      try {
        const r = await fn();
        if (okMsg) notify(okMsg);
        await refresh();
        return r;
      } catch (e) {
        notify(`${label}: ${e instanceof ApiError ? e.message : (e as Error).message}`, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  const toggleTheme = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('ca_theme', next);
    } catch {
      /* storage blocked: theme just applies for this visit */
    }
  };

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'cryptoalgo' } });
    window.location.href = '/login';
  }

  if (!state) {
    return (
      <div className="shell">
        <div className="login-wrap" style={{ minHeight: '60vh' }}>
          <div className="card">{lost ? <span className="bad">{lost}</span> : 'Loading dashboard…'}</div>
        </div>
      </div>
    );
  }

  const live = state.mode === 'live';
  const armed = state.liveArmed;
  const label = state.killSwitch
    ? 'KILL SWITCH ENGAGED — ALL NEW ENTRIES BLOCKED'
    : !live
      ? 'DEMO MODE — LIVE TRADING DISABLED'
      : armed
        ? state.deployment.realMoney
          ? 'LIVE MODE — REAL ORDERS ENABLED'
          : 'LIVE MODE (TESTNET) — SANDBOX ORDERS ENABLED, NO REAL FUNDS'
        : 'LIVE SELECTED — EXECUTION NOT ARMED';
  const statusClass = state.killSwitch ? 'kill' : live ? 'live' : 'demo';
  const h = state.feed.health;
  const feedDot = h.mode === 'ws' || h.mode === 'synthetic' ? 'good' : h.mode === 'rest-fallback' ? 'warn' : 'crit';
  const feedLabel = h.mode === 'ws' ? 'WebSocket live' : h.mode === 'rest-fallback' ? 'REST fallback' : h.mode === 'synthetic' ? 'SYNTHETIC' : 'DOWN';
  const cred = state.live.credentials;
  const apiDot = !cred.configured ? 'warn' : state.live.account.error ? 'crit' : state.live.account.fetchedAt ? 'good' : 'warn';
  const apiLabel = !cred.configured ? 'not configured' : state.live.account.error ? 'error' : state.live.account.fetchedAt ? 'connected' : 'connecting';
  const q = state.feed.quote;

  const actions: Actions = {
    isAdmin: !!isAdmin,
    run,
    refresh,
    openWizard: () => setWizard(true),
    confirmDemoSwitch: () => setConfirm('demo'),
    confirmKill: () => setConfirm(state.killSwitch ? 'release' : 'kill'),
  };

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topline">
          <div className="brand">
            <h1>CryptoAlgo</h1>
            <span className="sub">{state.spec.symbol} perpetual · {state.feed.synthetic ? 'SYNTHETIC DEV DATA (not Delta)' : state.deployment.exchange}</span>
          </div>
          <div className="top-actions">
            {q && (
              <span className="tabnum" style={{ fontWeight: 700, fontSize: 16 }} title="Last traded price">
                {state.spec.symbol} ${num(q.last)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>bid {num(q.bid)} / ask {num(q.ask)}</span>
              </span>
            )}
            <button className={`btn sm kill`} disabled={!isAdmin || busy} onClick={actions.confirmKill} title="Emergency stop: blocks every new entry and disarms live execution">
              {state.killSwitch ? 'KILL SWITCH ENGAGED · Release' : '⏻ KILL SWITCH'}
            </button>
            <button className="btn sm ghost" onClick={toggleTheme} aria-label="Toggle light/dark theme">Theme</button>
            <button className="btn sm ghost" onClick={logout}>Sign out{me ? ` (${me.username})` : ''}</button>
          </div>
        </div>

        <div className="mode-row">
          <div className="mode-switch" role="group" aria-label="Trading mode">
            <button className="mode-btn demo" aria-pressed={!live} onClick={() => (live ? actions.confirmDemoSwitch() : setTab('demo'))} disabled={!isAdmin && live}>
              DEMO TRADING
            </button>
            <button className="mode-btn live" aria-pressed={live} onClick={() => (isAdmin ? setWizard(true) : notify('Only an administrator can enable Live Trading', true))} title="Opens the safety checks and confirmation. Selecting Live never places an order by itself.">
              LIVE TRADING
            </button>
          </div>
          <div className={`mode-status ${statusClass}`} role="status" aria-live="polite">
            <span className="big">{label}</span>
            <span className="sec" style={{ fontSize: 12 }}>
              Bot {state.running ? <b>running</b> : <b>stopped</b>} · worker {state.workerActive ? 'active' : <b className="bad">not active on this instance</b>}
              {live && !armed && ' · live orders are impossible until activation completes'}
              {!live && ' · simulated orders and virtual balance only'}
            </span>
          </div>
        </div>

        <div className="statusbar" aria-label="Connection status">
          <span><i className={`dot ${feedDot}`} />Market data: <b>{feedLabel}</b>{state.feed.ageMs !== null && ` · last tick ${ago(q?.ts, state.now)}`}</span>
          <span><i className={`dot ${apiDot}`} />Exchange account API: <b>{apiLabel}</b>{cred.fingerprint && ` · ${cred.keyHint}`}</span>
          <span><i className={`dot ${state.live.reconciled ? 'good' : cred.configured ? 'warn' : ''}`} />Reconciliation: <b>{state.live.reconciled ? 'in sync' : cred.configured ? 'not in sync' : 'n/a'}</b></span>
          <span className="muted">{state.deployment.realMoney ? 'Environment: production' : 'Environment: sandbox/testnet'}</span>
        </div>

        <div className="tabs" role="tablist">
          {(
            [
              ['demo', 'Demo Trading'],
              ['live', 'Live Trading'],
              ['settings', 'Strategy & Risk'],
              ['analytics', 'Analytics'],
            ] as [Tab, string][]
          ).map(([k, t]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${k === 'live' ? 'livetab' : ''}`} onClick={() => setTab(k)}>
              {t}{k === 'live' && (armed ? ' ●' : '')}
            </button>
          ))}
        </div>
      </div>

      {lost && <div className="banner crit" role="alert"><span className="icon">!</span><div><b>Connection problem.</b> {lost} Data shown below may be stale (last update {ago(state.now)}).</div></div>}
      {state.feed.synthetic && <div className="banner warn" role="alert"><span className="icon">⚠</span><div><b>SYNTHETIC DEVELOPMENT DATA.</b> Prices are randomly generated, not from Delta Exchange. Never use this for decisions. Live trading is impossible in this mode.</div></div>}
      {state.deployment.liveHardDisabled && <div className="banner info"><span className="icon">🔒</span><div>Live trading is <b>hard-disabled by the server deployment</b> (LIVE_HARD_DISABLE).</div></div>}
      {!state.workerActive && <div className="banner warn" role="alert"><span className="icon">!</span><div><b>Trading worker is not active on this server instance.</b> Another instance holds the lease or the worker is disabled; commands are unavailable here.</div></div>}
      {state.attention.length > 0 && (
        <div className="banner crit" role="alert">
          <span className="icon">!</span>
          <div style={{ flex: 1 }}>
            <b>Needs your attention</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{state.attention.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
          {isAdmin && <button className="btn sm" onClick={() => run('Clear', () => api('POST', 'attention/clear'), 'Cleared')}>Acknowledge</button>}
        </div>
      )}
      {!state.spec.verified && <div className="banner warn"><span className="icon">!</span><div>Contract details have not been read from the exchange yet; documented fallback values are shown. <b>Live activation is blocked</b> until they are verified.</div></div>}

      <main>
        {tab === 'demo' && <DemoPanel state={state} actions={actions} />}
        {tab === 'live' && <LivePanel state={state} actions={actions} />}
        {tab === 'settings' && <SettingsPanel state={state} actions={actions} />}
        {tab === 'analytics' && <AnalyticsPanel state={state} />}
      </main>

      <p className="muted" style={{ marginTop: 28, fontSize: 12 }}>
        Trading derivatives with leverage can lose more than expected, including your entire deposit. Demo results are simulated and Backtests are historical; neither guarantees future results.
      </p>

      {wizard && <ActivationWizard state={state} onClose={() => setWizard(false)} onDone={async () => { setWizard(false); await refresh(); setTab('live'); notify('Live execution armed'); }} />}

      {confirm === 'demo' && (
        <Modal
          title="Switch to Demo?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  const r = await run('Switch to demo', () => api('POST', 'mode', { mode: 'demo' }));
                  setConfirm(null);
                  if (r) notify(`Demo mode. ${(r as any).result?.action ?? ''}`);
                }}
              >
                Switch to Demo
              </button>
            </>
          }
        >
          <p>New live entries stop <b>immediately</b>. Switching modes does <b>not</b> close a real position by itself.</p>
          <p className="sec">
            Configured policy for an open real position: <b>{state.settings.live.modeSwitchPolicy.replace(/_/g, ' ')}</b>
            {state.live.position || (state.live.account.position?.size ?? 0) !== 0 ? <> — <b className="bad">a real position is open right now.</b></> : ' — no real position is open.'}
          </p>
        </Modal>
      )}

      {(confirm === 'kill' || confirm === 'release') && (
        <Modal
          title={confirm === 'kill' ? 'Engage the emergency kill switch?' : 'Release the kill switch?'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className={`btn ${confirm === 'kill' ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={async () => {
                  const engage = confirm === 'kill';
                  const r = await run('Kill switch', () => api('POST', 'kill-switch', { engage, reason: killReason || undefined }));
                  setConfirm(null);
                  if (r) notify(engage ? `Kill switch engaged. ${(r as any).action ?? ''}` : 'Kill switch released (live is still disarmed)');
                }}
              >
                {confirm === 'kill' ? 'ENGAGE KILL SWITCH' : 'Release'}
              </button>
            </>
          }
        >
          {confirm === 'kill' ? (
            <>
              <p>This blocks <b>every new entry</b> (demo and live), disarms live execution and switches to Demo.</p>
              <p className="sec">Open real position policy: <b>{state.settings.live.killSwitchAction === 'flatten_positions' ? 'flatten with a reduce-only market order' : 'keep the exchange-side stop and target'}</b>.</p>
              <div className="field"><label htmlFor="kr">Reason (optional, goes to the audit log)</label><input id="kr" type="text" value={killReason} onChange={(e) => setKillReason(e.target.value)} maxLength={120} /></div>
            </>
          ) : (
            <p>Releasing the kill switch re-enables the Demo bot. <b>Live execution stays disarmed</b> — you must pass the activation checks again to go Live.</p>
          )}
        </Modal>
      )}

      <Toast message={toast?.msg ?? null} error={toast?.err} />
      <span className="sr-only" aria-live="polite">{label}</span>
    </div>
  );
}
