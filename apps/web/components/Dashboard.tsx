'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { mergeSlimState } from '@/lib/simple';
import type { BotState, Me } from '@/lib/types';
import DeveloperView, { type Tab } from './DeveloperView';
import { Skeleton } from './simple/bits';
import type { SimplePage } from './simple/Header';
import SimpleView from './simple/SimpleView';
import { Modal, Toast } from './ui';

export interface Actions {
  isAdmin: boolean;
  run: <T = any>(label: string, fn: () => Promise<T>, okMsg?: string) => Promise<T | undefined>;
  refresh: () => Promise<void>;
  openWizard: () => void;
  confirmDemoSwitch: () => void;
  confirmKill: () => void;
}

type View = 'simple' | 'developer';
const VIEW_KEY = 'ca_view';
/** The bulky chart series (candles, spark) are fetched in full this often; the polls in between ask for the slim snapshot. */
const FULL_STATE_EVERY_MS = 30_000;
const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 10_000;

/**
 * Owns what both views share: the polled backend snapshot, who is signed in, the toast, and the modals (activation wizard,
 * switch to demo, kill switch). The simple view is the default; "Developer view" in its menu opens the original tabs.
 */
export default function Dashboard() {
  const [state, setState] = useState<BotState | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [page, setPage] = useState<SimplePage>('overview');
  const [tab, setTab] = useState<Tab>('demo');
  const [lost, setLost] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [wizard, setWizard] = useState(false);
  const [confirm, setConfirm] = useState<null | 'demo' | 'kill' | 'release'>(null);
  const [busy, setBusy] = useState(false);
  const [killReason, setKillReason] = useState('');
  const [, force] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFullAt = useRef(0);
  const reqSeq = useRef({ sent: 0, applied: 0 });

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), err ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current.sent;
    try {
      const wantFull = Date.now() - lastFullAt.current > FULL_STATE_EVERY_MS;
      const s = await api<BotState>('GET', wantFull ? 'state' : 'state?slim=1');
      // two requests can overlap (a poll and a refresh after an action): never let the older answer replace the newer one
      if (seq < reqSeq.current.applied) return;
      reqSeq.current.applied = seq;
      // an older backend ignores ?slim and sends everything: that counts as a full snapshot too
      if (!s.slim) lastFullAt.current = Date.now();
      setState((prev) => mergeSlimState(prev, s));
      setLost(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 502) setLost('The trading backend is unreachable from the dashboard.');
      else if (e instanceof ApiError) setLost(e.message);
      else setLost('Connection to the dashboard server lost.');
    }
  }, []);

  useEffect(() => {
    try {
      setView(localStorage.getItem(VIEW_KEY) === 'developer' ? 'developer' : 'simple');
    } catch {
      setView('simple');
    }
    void api<Me>('GET', 'auth/me').then(setMe).catch(() => {});
    void refresh();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    // every 2 s while the tab is visible, every 10 s while it is hidden; coming back to the tab refreshes at once
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await refresh();
        if (!stopped) schedule();
      }, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // The developer panels count down with the server clock; the simple view drives its own tickers.
  useEffect(() => {
    if (view !== 'developer') return;
    const tick = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(tick);
  }, [view]);

  const choose = useCallback((v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage blocked: the choice just applies for this visit */
    }
    window.scrollTo(0, 0);
  }, []);

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

  if (!state || !view) return <LoadingScreen lost={lost} retry={() => void refresh()} />;

  const actions: Actions = {
    isAdmin: !!isAdmin,
    run,
    refresh,
    openWizard: () => setWizard(true),
    confirmDemoSwitch: () => setConfirm('demo'),
    confirmKill: () => setConfirm(state.killSwitch ? 'release' : 'kill'),
  };

  return (
    <>
      {view === 'simple' ? (
        <SimpleView
          state={state}
          me={me}
          actions={actions}
          lost={lost}
          page={page}
          setPage={(p) => {
            setPage(p);
            window.scrollTo(0, 0);
          }}
          onDeveloper={() => choose('developer')}
          onLogout={logout}
          onToggleTheme={toggleTheme}
        />
      ) : (
        <DeveloperView
          state={state}
          me={me}
          actions={actions}
          lost={lost}
          busy={busy}
          tab={tab}
          setTab={setTab}
          wizard={wizard}
          closeWizard={() => setWizard(false)}
          onWizardDone={async () => {
            setWizard(false);
            await refresh();
            setTab('live');
            notify('Live execution armed');
          }}
          onSimple={() => choose('simple')}
          onLogout={logout}
          onToggleTheme={toggleTheme}
          notify={notify}
        />
      )}

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
      <span className="sr-only" aria-live="polite">{state.killSwitch ? 'Emergency stop is on' : state.mode === 'live' && state.liveArmed ? 'Live mode' : 'Demo mode, simulated'}</span>
    </>
  );
}

/** First paint: the shape of the page as grey placeholders, or a calm "Reconnecting..." when the first request fails. */
function LoadingScreen({ lost, retry }: { lost: string | null; retry: () => void }) {
  return (
    <div className="sv" aria-busy={!lost}>
      <header className="sv-header">
        <div className="sv-header-row">
          <div className="sv-brand">
            <span className="sv-logo" aria-hidden>C</span>
            <div><h1>CryptoAlgo</h1></div>
          </div>
        </div>
        <div className="sv-chips"><Skeleton h={34} w={250} r={999} /></div>
      </header>
      {lost && (
        <div className="sv-banner warn" role="alert">
          <div><b>Reconnecting...</b> The dashboard cannot reach the server yet. It keeps trying.</div>
          <button className="sv-btn" onClick={retry}>Try now</button>
        </div>
      )}
      <div className="sv-grid" role="status" aria-label="Loading the dashboard">
        <section className="card sv-card" style={{ gridArea: 'price' }}>
          <Skeleton h={22} w="30%" />
          <Skeleton h={52} w="55%" style={{ marginTop: 12 }} />
          <Skeleton h={220} style={{ marginTop: 16 }} />
        </section>
        <section className="card sv-card" style={{ gridArea: 'flow' }}>
          <Skeleton h={22} w="35%" />
          <Skeleton h={280} style={{ marginTop: 16 }} />
        </section>
        <section className="card sv-card" style={{ gridArea: 'account' }}>
          <Skeleton h={22} w="45%" />
          <Skeleton h={90} style={{ marginTop: 16 }} />
          <Skeleton h={60} style={{ marginTop: 12 }} />
        </section>
        <section className="card sv-card" style={{ gridArea: 'activity' }}>
          <Skeleton h={22} w="40%" />
          <Skeleton h={120} style={{ marginTop: 16 }} />
          <Skeleton h={60} style={{ marginTop: 12 }} />
        </section>
      </div>
    </div>
  );
}
