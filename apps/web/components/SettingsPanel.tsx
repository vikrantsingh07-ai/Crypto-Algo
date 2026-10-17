'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { num, pct, usd } from '@/lib/format';
import type { BotState } from '@/lib/types';
import type { Actions } from './Dashboard';
import { Card, Tag } from './ui';

type FieldDef =
  | { path: string; label: string; type: 'number'; step?: number; min?: number; max?: number; help?: string; nullable?: boolean }
  | { path: string; label: string; type: 'text'; help?: string }
  | { path: string; label: string; type: 'bool'; help?: string }
  | { path: string; label: string; type: 'select'; options: [string, string][]; help?: string };

const GROUPS: { title: string; hint?: string; fields: FieldDef[] }[] = [
  {
    title: 'Instrument & position',
    hint: 'Validated against the exchange contract: quantity must be a whole number of contracts; leverage ≤ the exchange maximum.',
    fields: [
      { path: 'instrument.symbol', label: 'ETH contract', type: 'text', help: 'e.g. ETHUSD (perpetual)' },
      { path: 'position.quantityEth', label: 'Quantity (ETH)', type: 'number', step: 0.01, min: 0.01, help: '0.20 ETH = 20 contracts at 0.01 ETH/contract' },
      { path: 'position.leverage', label: 'Leverage (x)', type: 'number', step: 1, min: 1, max: 200, help: 'Never overrides the risk manager' },
      { path: 'position.maxOpenPositions', label: 'Max open positions', type: 'number', step: 1, min: 1, max: 3 },
    ],
  },
  {
    title: 'Targets & stop-loss (ETH price move, USD)',
    hint: 'The target is a price move, not profit: $4–$6 on 0.20 ETH = $0.80–$1.20 gross before fees.',
    fields: [
      { path: 'targets.targetMoveMinUsd', label: 'Target move — min ($)', type: 'number', step: 0.5, min: 0.1 },
      { path: 'targets.targetMoveMaxUsd', label: 'Target move — max ($)', type: 'number', step: 0.5, min: 0.1 },
      { path: 'targets.targetAtrMultiple', label: 'Target = ATR ×', type: 'number', step: 0.1, min: 0.1 },
      { path: 'targets.stopLossMinUsd', label: 'Stop-loss — min ($)', type: 'number', step: 0.5, min: 0.1 },
      { path: 'targets.stopLossMaxUsd', label: 'Stop-loss — max ($)', type: 'number', step: 0.5, min: 0.1 },
      { path: 'targets.stopLossAtrMultiple', label: 'Stop = ATR ×', type: 'number', step: 0.1, min: 0.1 },
    ],
  },
  {
    title: 'Time exit policy',
    fields: [
      { path: 'exits.maxHoldMinutes', label: 'Max holding time (min)', type: 'number', step: 1, min: 1, max: 240, help: 'Hard backstop: market close at this time' },
      { path: 'exits.timeExitPolicy', label: 'If target not reached', type: 'select', options: [['breakeven_then_close', 'Tighten stop to break-even, then close at limit'], ['close_at_market', 'Close at the time limit']] },
      { path: 'exits.breakevenAfterMinutes', label: 'Break-even stop after (min)', type: 'number', step: 1, min: 1 },
      { path: 'exits.takeProfitOrderType', label: 'Take-profit order', type: 'select', options: [['limit', 'Resting limit (maker fee)'], ['market', 'Market (taker fee)']] },
    ],
  },
  {
    title: 'Risk limits',
    hint: 'Mandatory. Trades per rolling 24h is capped at 10 by the software.',
    fields: [
      { path: 'limits.maxTradesPer24h', label: 'Max new trades / rolling 24h', type: 'number', step: 1, min: 1, max: 10 },
      { path: 'limits.perTradeRiskUsd', label: 'Per-trade risk limit ($, net at stop incl. fees)', type: 'number', step: 0.25, min: 0.01 },
      { path: 'limits.dailyLossLimitUsd', label: 'Daily loss limit ($, rolling 24h)', type: 'number', step: 0.5, min: 0.01 },
      { path: 'limits.maxDrawdownPct', label: 'Max drawdown (%)', type: 'number', step: 0.5, min: 0.1, max: 100 },
      { path: 'limits.maxConsecutiveLosses', label: 'Consecutive-loss breaker (losses)', type: 'number', step: 1, min: 1 },
      { path: 'limits.consecutiveLossPauseMinutes', label: 'Breaker pause (min)', type: 'number', step: 5, min: 1 },
      { path: 'limits.cooldownMinutesAfterLoss', label: 'Cooldown after a loss (min)', type: 'number', step: 1, min: 0 },
      { path: 'limits.minFreeMarginPct', label: 'Min free margin after entry (% equity)', type: 'number', step: 5, min: 0, max: 100 },
      { path: 'limits.minLiquidationBufferMultiple', label: 'Liquidation distance ≥ × stop', type: 'number', step: 0.5, min: 1 },
      { path: 'limits.minNetRewardRisk', label: 'Min net reward : risk (after fees)', type: 'number', step: 0.05, min: 0 },
      { path: 'limits.minExpectedNetRewardUsd', label: 'Min expected net reward ($)', type: 'number', step: 0.05, min: 0 },
    ],
  },
  {
    title: 'Market filters',
    fields: [
      { path: 'filters.maxSpreadUsd', label: 'Max spread ($)', type: 'number', step: 0.05, min: 0.01 },
      { path: 'filters.maxSlippageUsd', label: 'Max entry slippage ($, IOC limit cap)', type: 'number', step: 0.05, min: 0.01 },
      { path: 'filters.staleDataSeconds', label: 'Stale-data limit (s)', type: 'number', step: 1, min: 1 },
      { path: 'filters.minAtrUsd', label: 'Min ATR ($)', type: 'number', step: 0.1, min: 0 },
      { path: 'filters.maxAtrUsd', label: 'Max ATR ($)', type: 'number', step: 0.5, min: 0.1 },
    ],
  },
  {
    title: 'Strategy parameters (1-minute candles)',
    hint: 'EMA trend + VWAP + breakout + momentum + volume + ATR band. Test changes in Backtests before relying on them.',
    fields: [
      { path: 'strategy.emaFast', label: 'EMA fast', type: 'number', step: 1, min: 2 },
      { path: 'strategy.emaSlow', label: 'EMA slow', type: 'number', step: 1, min: 3 },
      { path: 'strategy.emaTrend', label: 'EMA trend', type: 'number', step: 1, min: 5 },
      { path: 'strategy.atrPeriod', label: 'ATR period', type: 'number', step: 1, min: 2 },
      { path: 'strategy.breakoutLookback', label: 'Breakout lookback (bars)', type: 'number', step: 1, min: 3 },
      { path: 'strategy.momentumLookback', label: 'Momentum lookback (bars)', type: 'number', step: 1, min: 1 },
      { path: 'strategy.momentumAtrMult', label: 'Momentum ≥ ATR ×', type: 'number', step: 0.1, min: 0 },
      { path: 'strategy.minBodyAtrRatio', label: 'Candle body ≥ ATR ×', type: 'number', step: 0.1, min: 0 },
      { path: 'strategy.closeStrength', label: 'Close strength (0.5–1)', type: 'number', step: 0.05, min: 0.5, max: 1 },
      { path: 'strategy.volumeLookback', label: 'Volume lookback', type: 'number', step: 1, min: 2 },
      { path: 'strategy.minVolumeRatio', label: 'Min volume ratio', type: 'number', step: 0.1, min: 0 },
      { path: 'strategy.maxExtensionAtr', label: 'Max extension from EMA (ATR ×)', type: 'number', step: 0.1, min: 0.1 },
      { path: 'strategy.efficiencyLookback', label: 'Efficiency-ratio lookback', type: 'number', step: 1, min: 5 },
      { path: 'strategy.minEfficiencyRatio', label: 'Min efficiency ratio', type: 'number', step: 0.05, min: 0, max: 1 },
      { path: 'strategy.signalCooldownCandles', label: 'Signal cooldown (candles)', type: 'number', step: 1, min: 0 },
      { path: 'strategy.allowLong', label: 'Allow Long', type: 'bool' },
      { path: 'strategy.allowShort', label: 'Allow Short', type: 'bool' },
    ],
  },
  {
    title: 'Fees & simulation assumptions',
    hint: 'Maker/taker rates default to the exchange product values. No exit-fee waiver is assumed unless you enable it.',
    fields: [
      { path: 'execution.makerFeeRate', label: 'Maker fee override (fraction)', type: 'number', step: 0.0001, min: 0, nullable: true, help: 'blank = exchange value' },
      { path: 'execution.takerFeeRate', label: 'Taker fee override (fraction)', type: 'number', step: 0.0001, min: 0, nullable: true, help: 'blank = exchange value' },
      { path: 'execution.gstRate', label: 'GST on fees (fraction)', type: 'number', step: 0.01, min: 0, max: 1 },
      { path: 'execution.otherTaxRate', label: 'Other tax per leg (fraction of notional)', type: 'number', step: 0.0001, min: 0, max: 0.05, help: '0 unless your statements show one' },
      { path: 'execution.exitFeeWaiver.enabled', label: 'Assume exit-fee waiver', type: 'bool', help: 'Only if your fee statement shows it' },
      { path: 'execution.exitFeeWaiver.withinMinutes', label: 'Waiver window (min)', type: 'number', step: 1, min: 1 },
      { path: 'execution.simSlippageUsd', label: 'Simulated slippage ($)', type: 'number', step: 0.05, min: 0 },
      { path: 'execution.simStopSlippageUsd', label: 'Extra stop slippage ($)', type: 'number', step: 0.05, min: 0 },
      { path: 'execution.tpFillModel', label: 'Simulated take-profit fill', type: 'select', options: [['through', 'Only after price trades through'], ['touch', 'On touch (optimistic)']] },
      { path: 'execution.usdInrRate', label: 'USD/INR (display only)', type: 'number', step: 0.5, min: 1 },
      { path: 'execution.fundingRateFallback', label: 'Demo funding fallback (fraction/8h)', type: 'number', step: 0.0001 },
    ],
  },
  {
    title: 'Demo account',
    fields: [{ path: 'demo.startingBalanceUsd', label: 'Virtual starting balance ($)', type: 'number', step: 10, min: 1, help: 'Applies on “Reset account”' }],
  },
  {
    title: 'Live safety procedures',
    fields: [
      { path: 'live.modeSwitchPolicy', label: 'Switching Live → Demo with an open real position', type: 'select', options: [['keep_managing', 'Keep managing exits (default)'], ['close_at_market', 'Close at market (reduce-only)'], ['manual_review', 'Leave under exchange stop; manual review']] },
      { path: 'live.killSwitchAction', label: 'Kill switch with an open real position', type: 'select', options: [['flatten_positions', 'Flatten (reduce-only market close)'], ['keep_protective', 'Keep exchange-side stop/target']] },
      { path: 'live.reconcileIntervalSeconds', label: 'Reconcile interval (s)', type: 'number', step: 1, min: 3, max: 300 },
      { path: 'live.minAvailableBalanceUsd', label: 'Min available balance ($)', type: 'number', step: 1, min: 0 },
    ],
  },
];

const get = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setIn(o: any, path: string, v: unknown) {
  const out = structuredClone(o);
  const ks = path.split('.');
  let cur = out;
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]];
  cur[ks[ks.length - 1]] = v;
  return out;
}

interface Issue { path: string; message: string; severity: 'error' | 'warning' }

export default function SettingsPanel({ state, actions }: { state: BotState; actions: Actions }) {
  const [draft, setDraft] = useState<any>(state.settings);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // follow server state until the user starts editing
  useEffect(() => {
    if (!dirty) setDraft(state.settings);
  }, [state.settings, dirty]);

  const byPath = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) m.set(i.path, [...(m.get(i.path) ?? []), i]);
    return m;
  }, [issues]);

  const edit = (path: string, v: unknown) => {
    setDraft((d: any) => setIn(d, path, v));
    setDirty(true);
    setMsg(null);
  };

  async function save() {
    setSaving(true);
    setIssues([]);
    setMsg(null);
    try {
      const r = await api<{ settings: any; issues: Issue[]; changed: string[] }>('PUT', 'settings', draft);
      setIssues(r.issues ?? []);
      setDirty(false);
      setDraft(r.settings);
      setMsg(r.changed.length ? `Saved ${r.changed.length} change(s): ${r.changed.join(', ')}` : 'No changes');
      await actions.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.body?.issues) {
        setIssues(e.body.issues);
        setMsg('Not saved — fix the highlighted fields.');
      } else setMsg(`Not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const readOnly = !actions.isAdmin;
  const econ = state.economics;

  return (
    <div>
      <div className="grid g-2">
        <ExchangeConnection state={state} actions={actions} />
        <Card title="Fee reality check" hint={econ ? `At ETH $${num(econ.referencePrice)} · ${econ.contracts} contracts · stop ≈ $${num(econ.stopUsd)} — recomputed live` : 'Waiting for a price'}>
          {econ ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Target move</th><th className="num">Gross</th><th className="num">Fees (maker TP)</th><th className="num">Net</th><th className="num">Win rate needed</th></tr>
                  </thead>
                  <tbody>
                    {econ.makerTarget.map((r) => (
                      <tr key={r.moveUsd}>
                        <td>${num(r.moveUsd, 1)}</td><td className="num">{usd(r.grossReward)}</td><td className="num">{usd(r.fees, 3)}</td>
                        <td className="num"><b className={r.netReward > 0 ? 'good' : 'bad'}>{r.netReward > 0 ? '+' : ''}{usd(r.netReward)}</b></td>
                        <td className="num">{pct(r.requiredWinRate, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sec" style={{ fontSize: 12, marginBottom: 0 }}>
                Taker {pct(econ.rates.taker, 3)} / maker {pct(econ.rates.maker, 3)} + GST {pct(econ.rates.gst, 0)}. Price must move <b>${num(econ.breakevenMoveMakerExitUsd)}</b> just to cover fees with a maker take-profit
                (<b>${num(econ.breakevenMoveTakerExitUsd)}</b> if the exit is a taker order). “Win rate needed” is the break-even rate for the target above vs a ${num(econ.stopUsd)} stop; the bot also blocks trades below your minimum net reward:risk.
                {!econ.verifiedSpec && ' Fee rates shown are documented fallbacks, not read from the exchange.'}
              </p>
            </>
          ) : (
            <div className="empty">No price yet.</div>
          )}
        </Card>
      </div>

      <div className="grid">
        <Card
          title="Strategy & risk settings"
          hint="Persisted on the server. Switching Demo ↔ Live never resets or re-asks for these."
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dirty && <Tag kind="warn">unsaved changes</Tag>}
              <button className="btn sm" disabled={!dirty || saving} onClick={() => { setDraft(state.settings); setDirty(false); setIssues([]); setMsg(null); }}>Revert</button>
              <button className="btn primary sm" disabled={!dirty || saving || readOnly} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          }
        >
          {readOnly && <p className="sec" style={{ marginTop: 0 }}>Read-only: your role is <b>viewer</b>.</p>}
          {msg && <p className={msg.startsWith('Not saved') ? 'bad' : 'good'} role="status" style={{ fontWeight: 600, marginTop: 0 }}>{msg}</p>}
          {issues.length > 0 && (
            <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
              {issues.map((i, k) => <li key={k} className={i.severity === 'error' ? 'bad' : 'sec'}><b>{i.severity === 'error' ? 'Error' : 'Warning'}</b> · {i.path}: {i.message}</li>)}
            </ul>
          )}
          {GROUPS.map((g) => (
            <fieldset key={g.title} style={{ border: 0, padding: 0, margin: '0 0 18px' }} disabled={readOnly}>
              <legend style={{ fontWeight: 700, padding: 0, marginBottom: 2 }}>{g.title}</legend>
              {g.hint && <div className="hint" style={{ marginBottom: 8 }}>{g.hint}</div>}
              <div className="fields">
                {g.fields.map((f) => {
                  const val = get(draft, f.path);
                  const errs = byPath.get(f.path) ?? [];
                  const invalid = errs.some((e) => e.severity === 'error');
                  const id = `f-${f.path}`;
                  return (
                    <div key={f.path} className={`field ${invalid ? 'invalid' : ''}`}>
                      {f.type === 'bool' ? (
                        <label className="check-row" htmlFor={id} style={{ padding: '20px 0 0' }}>
                          <input id={id} type="checkbox" checked={!!val} onChange={(e) => edit(f.path, e.target.checked)} />
                          <span>{f.label}</span>
                        </label>
                      ) : (
                        <>
                          <label htmlFor={id}>{f.label}</label>
                          {f.type === 'select' ? (
                            <select id={id} value={val ?? ''} onChange={(e) => edit(f.path, e.target.value)}>
                              {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          ) : f.type === 'text' ? (
                            <input id={id} type="text" value={val ?? ''} onChange={(e) => edit(f.path, e.target.value.toUpperCase())} />
                          ) : (
                            <input
                              id={id}
                              type="number"
                              step={f.step}
                              min={f.min}
                              max={f.max}
                              value={val ?? ''}
                              onChange={(e) => edit(f.path, e.target.value === '' ? (f.nullable ? null : '') : Number(e.target.value))}
                            />
                          )}
                        </>
                      )}
                      {'help' in f && f.help && <span className="help">{f.help}</span>}
                      {errs.map((e, k) => <span key={k} className={e.severity === 'error' ? 'err' : 'wrn'}>{e.message}</span>)}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </Card>
      </div>
    </div>
  );
}

function ExchangeConnection({ state, actions }: { state: BotState; actions: Actions }) {
  const cred = state.live.credentials;
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<{ ok: boolean; steps: { step: string; ok: boolean; detail: string }[] } | null>(null);
  const [open, setOpen] = useState(false);

  async function save() {
    const r = await actions.run('Save credentials', () => api('PUT', 'credentials', { apiKey, apiSecret, password }), 'Credentials saved (encrypted on the server)');
    if (r) {
      setApiKey('');
      setApiSecret('');
      setPassword('');
      setOpen(false);
    }
  }

  return (
    <Card title="Exchange connection" hint={state.deployment.exchange} right={<Tag kind={cred.configured ? 'good' : 'warn'}>{cred.configured ? 'configured' : 'not configured'}</Tag>}>
      <table className="kv">
        <tbody>
          <tr><td className="sec">API key</td><td className="num">{cred.configured ? `${cred.keyHint} · ${cred.fingerprint}` : '—'}</td></tr>
          <tr><td className="sec">Stored in</td><td className="num">{cred.source === 'environment' ? 'server environment variables' : cred.source === 'database' ? 'server database (AES-256-GCM encrypted)' : '—'}</td></tr>
          <tr><td className="sec">Secret</td><td className="num">never sent to the browser</td></tr>
        </tbody>
      </table>
      <p className="sec" style={{ fontSize: 12 }}>
        Create the key in the Delta Exchange API management page with <b>Trading</b> permission only and the server’s static IP whitelisted. Delta API keys have no withdrawal permission. Keys are environment-specific
        (testnet keys do not work in production).
      </p>
      {actions.isAdmin && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {cred.source !== 'environment' && <button className="btn sm" onClick={() => setOpen((o) => !o)} disabled={!cred.canStoreInDatabase}>{cred.configured ? 'Replace key…' : 'Add key…'}</button>}
          {cred.configured && <button className="btn sm" onClick={async () => { const r = await actions.run('Test', () => api<any>('POST', 'credentials/test')); if (r) setResult(r); }}>Test connection</button>}
          {cred.configured && cred.source === 'database' && <button className="btn sm ghost" onClick={() => window.confirm('Remove the stored API key? Live trading will be disarmed.') && actions.run('Remove', () => api('DELETE', 'credentials'), 'Credentials removed')}>Remove</button>}
        </div>
      )}
      {!cred.canStoreInDatabase && cred.source !== 'environment' && <p className="bad" style={{ fontSize: 12 }}>This server has no CREDENTIAL_ENCRYPTION_KEY, so keys cannot be stored from the dashboard. Set DELTA_API_KEY / DELTA_API_SECRET as server secrets instead.</p>}
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <div className="field"><label htmlFor="ck">API key</label><input id="ck" type="text" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} /></div>
          <div className="field"><label htmlFor="cs">API secret</label><input id="cs" type="password" autoComplete="new-password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value.trim())} /></div>
          <div className="field"><label htmlFor="cp">Your dashboard password (confirms it’s you)</label><input id="cp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <p className="sec" style={{ fontSize: 12, margin: 0 }}>Saving a new key disarms Live execution; you will re-run the activation checks.</p>
          <button className="btn primary sm" disabled={!apiKey || !apiSecret || !password} onClick={save}>Save encrypted</button>
        </div>
      )}
      {result && (
        <ul className="checks" style={{ marginTop: 10 }}>
          {result.steps.map((s) => <li key={s.step}><span className={`mark ${s.ok ? 'ok' : 'no'}`}>{s.ok ? '✓' : '✕'}</span><span><b>{s.step}</b> <span className="sec">— {s.detail}</span></span></li>)}
        </ul>
      )}
    </Card>
  );
}
