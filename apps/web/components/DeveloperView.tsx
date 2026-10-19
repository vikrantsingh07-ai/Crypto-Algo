'use client';

import { api } from '@/lib/api';
import { ago, num } from '@/lib/format';
import { scalperView } from '@/lib/scalper';
import type { BotState, Me } from '@/lib/types';
import ActivationWizard from './ActivationWizard';
import AnalyticsPanel from './AnalyticsPanel';
import type { Actions } from './Dashboard';
import DemoPanel from './DemoPanel';
import LivePanel from './LivePanel';
import SettingsPanel from './SettingsPanel';

export type Tab = 'demo' | 'live' | 'settings' | 'analytics';

/**
 * The original technical dashboard (Demo / Live / Strategy & Risk / Analytics). It is no longer the default: the operator
 * opens it from the menu of the simple view ("Developer view"). The modals it opens (activation wizard, kill switch, demo
 * switch) are owned by Dashboard so the two views share them.
 */
export default function DeveloperView({
  state,
  me,
  actions,
  lost,
  busy,
  tab,
  setTab,
  wizard,
  closeWizard,
  onWizardDone,
  onSimple,
  onLogout,
  onToggleTheme,
  notify,
}: {
  state: BotState;
  me: Me | null;
  actions: Actions;
  lost: string | null;
  busy: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  wizard: boolean;
  closeWizard: () => void;
  onWizardDone: () => void;
  onSimple: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
  notify: (msg: string, err?: boolean) => void;
}) {
  const isAdmin = actions.isAdmin;
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
  // The Scalper Offer is dormant (off by default): its status only appears while someone has switched it on.
  const sv = scalperView(state, 'live');
  const lsc = state.live.scalper;
  const scDot = lsc?.status === 'not_applied' ? 'crit' : lsc?.status === 'confirmed' ? 'good' : 'warn';
  const scLabel = lsc?.status === 'not_applied' ? 'NOT APPLIED · full fees' : lsc?.status === 'confirmed' ? `confirmed ×${lsc.confirmedCount}` : sv.hasTimeLimit ? `assumed · no closing fee ≤ ${sv.windowMin} min` : 'assumed · inactive without a time limit';

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topline">
          <div className="brand">
            <h1>CryptoAlgo</h1>
            <span className="sub">Developer view · {state.spec.symbol} perpetual · {state.feed.synthetic ? 'SYNTHETIC DEV DATA (not Delta)' : state.deployment.exchange}</span>
          </div>
          <div className="top-actions">
            {q && (
              <span className="tabnum" style={{ fontWeight: 700, fontSize: 16 }} title="Last traded price">
                {state.spec.symbol} ${num(q.last)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>bid {num(q.bid)} / ask {num(q.ask)}</span>
              </span>
            )}
            <button className="btn sm kill" disabled={!isAdmin || busy} onClick={actions.confirmKill} title="Emergency stop: blocks every new entry and disarms live execution">
              {state.killSwitch ? 'KILL SWITCH ENGAGED · Release' : '⏻ KILL SWITCH'}
            </button>
            <button className="btn sm" onClick={onSimple} title="Back to the simple dashboard">Simple view</button>
            <button className="btn sm ghost" onClick={onToggleTheme} aria-label="Toggle light/dark theme">Theme</button>
            <button className="btn sm ghost" onClick={onLogout}>Sign out{me ? ` (${me.username})` : ''}</button>
          </div>
        </div>

        <div className="mode-row">
          <div className="mode-switch" role="group" aria-label="Trading mode">
            <button className="mode-btn demo" aria-pressed={!live} onClick={() => (live ? actions.confirmDemoSwitch() : setTab('demo'))} disabled={!isAdmin && live}>
              DEMO TRADING
            </button>
            <button className="mode-btn live" aria-pressed={live} onClick={() => (isAdmin ? actions.openWizard() : notify('Only an administrator can enable Live Trading', true))} title="Opens the safety checks and confirmation. Selecting Live never places an order by itself.">
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
          {sv.assumed && <span><i className={`dot ${scDot}`} />Scalper Offer: <b>{scLabel}</b></span>}
          <span className="muted">{state.deployment.realMoney ? 'Environment: production' : 'Environment: sandbox/testnet'}</span>
        </div>

        <div className="tabs" role="tablist">
          {(
            [
              ['demo', 'Demo Trading', 'Demo'],
              ['live', 'Live Trading', 'Live'],
              ['settings', 'Strategy & Risk', 'Strategy'],
              ['analytics', 'Analytics', 'Analytics'],
            ] as [Tab, string, string][]
          ).map(([k, t, short]) => (
            <button key={k} role="tab" aria-selected={tab === k} aria-label={t} className={`tab ${k === 'live' ? 'livetab' : ''}`} onClick={() => setTab(k)}>
              <span className="long">{t}</span><span className="short">{short}</span>{k === 'live' && (armed ? ' ●' : '')}
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
          {isAdmin && <button className="btn sm" onClick={() => actions.run('Clear', () => api('POST', 'attention/clear'), 'Cleared')}>Acknowledge</button>}
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

      {wizard && <ActivationWizard state={state} onClose={closeWizard} onDone={onWizardDone} />}
    </div>
  );
}
