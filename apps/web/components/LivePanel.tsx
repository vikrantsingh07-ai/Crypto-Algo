'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ago, duration, inr, num, usd } from '@/lib/format';
import type { BotState, TradeRow } from '@/lib/types';
import type { Actions } from './Dashboard';
import { TradesTable } from './DemoPanel';
import { Meter } from './charts';
import { Card, Checks, Pnl, Stat, Tag } from './ui';

const STALE_ACCOUNT_MS = 60_000;

export default function LivePanel({ state, actions }: { state: BotState; actions: Actions }) {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ trades: TradeRow[] }>('GET', 'trades?mode=live&limit=60').then((r) => alive && setRows(r.trades)).catch(() => {});
    void load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const L = state.live;
  const a = L.account;
  const cred = L.credentials;
  const armed = state.liveArmed && state.mode === 'live';
  const accountAge = a.fetchedAt ? state.now - a.fetchedAt : null;
  const stale = accountAge === null || accountAge > STALE_ACCOUNT_MS;
  const pos = a.position && a.position.size !== 0 ? a.position : null;
  const tracked = L.position;
  const closed = rows?.filter((t) => t.status === 'closed') ?? [];
  const realized = closed.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const fees = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
  const apiOk = cred.configured && !a.error && !!a.fetchedAt;

  return (
    <div>
      <div className={`banner ${armed ? 'crit' : 'info'}`} style={{ marginTop: 12 }}>
        <span className="icon">{armed ? '●' : '○'}</span>
        <div style={{ flex: 1 }}>
          <b style={{ letterSpacing: '0.03em' }}>{armed ? `LIVE EXECUTION: ENABLED (${state.deployment.realMoney ? 'REAL FUNDS' : 'TESTNET'})` : 'LIVE EXECUTION: DISABLED'}</b>
          <div className="sec" style={{ fontSize: 12 }}>
            {armed
              ? `Armed ${state.liveArmedAt ? ago(state.liveArmedAt, state.now) : ''} by ${state.liveArmedBy ?? 'operator'}. Orders go to ${state.deployment.exchange}.`
              : 'No real order can be placed. Live execution turns on only after the activation checks pass and you confirm.'}
          </div>
        </div>
        {actions.isAdmin && !armed && <button className="btn primary" onClick={actions.openWizard} disabled={state.deployment.liveHardDisabled}>Enable Live Trading…</button>}
        {actions.isAdmin && armed && <button className="btn" onClick={actions.confirmDemoSwitch}>Switch to Demo</button>}
      </div>

      <div className="grid g-3">
        <Card title="Connection & API health" right={<Tag kind={apiOk ? 'good' : cred.configured ? 'crit' : 'warn'}>{apiOk ? 'connected' : cred.configured ? 'error' : 'not configured'}</Tag>}>
          <table className="kv">
            <tbody>
              <tr><td className="sec">Environment</td><td className="num">{state.deployment.exchange}</td></tr>
              <tr><td className="sec">API key</td><td className="num">{cred.configured ? `${cred.keyHint} · ${cred.fingerprint} (${cred.source})` : 'none — add in Strategy & Risk → Exchange connection'}</td></tr>
              <tr><td className="sec">Last successful API call</td><td className="num">{ago(L.apiLastSuccessAt, state.now)}</td></tr>
              <tr><td className="sec">Account data fetched</td><td className="num">{ago(a.fetchedAt, state.now)}{stale && a.fetchedAt ? ' · STALE' : ''}</td></tr>
              <tr><td className="sec">Clock offset vs exchange</td><td className="num">{(L.clockOffsetMs / 1000).toFixed(1)}s</td></tr>
              <tr><td className="sec">Market data</td><td className="num">{state.feed.health.mode}{state.feed.health.reconnects ? ` · ${state.feed.health.reconnects} reconnects` : ''}</td></tr>
              <tr><td className="sec">Contract</td><td className="num">{state.spec.verified ? `${state.spec.symbol} #${state.spec.productId} · ${state.spec.tradingStatus}` : 'unverified (fallback values)'}</td></tr>
              <tr><td className="sec">Reconciliation</td><td className="num">{L.reconciled ? 'in sync' : `NOT in sync — ${L.reconcileReason ?? 'pending'}`}</td></tr>
            </tbody>
          </table>
          {a.error && <p className="bad" style={{ marginBottom: 0 }}>Account error: {a.error}</p>}
          {L.apiLastError && !apiOk && <p className="muted" style={{ fontSize: 12 }}>Last error {ago(L.apiLastError.at, state.now)}: {L.apiLastError.message}</p>}
          {actions.isAdmin && cred.configured && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => actions.run('Reconcile', () => api('POST', 'live/reconcile'), 'Reconciled')}>Re-check exchange state</button>}
        </Card>

        <Card title="Exchange account" hint="Real data from the exchange — never simulated" right={<Tag kind="real">Real account</Tag>}>
          {!apiOk ? (
            <div className="empty">Account data unavailable{a.error ? ` (${a.error})` : cred.configured ? '' : ' — API credentials not configured'}.</div>
          ) : (
            <>
              {stale && <p className="bad" style={{ marginTop: 0 }}>⚠ Data is {duration(accountAge)} old (stale).</p>}
              <div className="grid g-2" style={{ marginTop: 0 }}>
                <Stat label="Equity (USD-equiv.)" value={usd(a.equityUsd)} sub={a.equityUsd !== null ? inr(a.equityUsd * state.settings.execution.usdInrRate) : undefined} />
                <Stat label="Available margin" value={usd(a.availableUsd)} sub={a.balances[0] ? `${a.balances[0].assetSymbol} wallet · blocked ${num(a.balances[0].blockedMargin)}` : undefined} />
              </div>
              <div className="sec" style={{ fontSize: 12, marginTop: 8 }}>Drawdown baseline {usd(L.baselineEquityUsd)} · peak {usd(L.peakEquityUsd)} {actions.isAdmin && <button className="linkbtn" onClick={() => actions.run('Reset', () => api('POST', 'live/reset-baseline'), 'Baseline reset')}>reset</button>}</div>
            </>
          )}
        </Card>

        <Card title="Risk status (Live)" right={<Tag kind={L.risk.tradingAllowed ? 'good' : 'warn'}>{L.risk.tradingAllowed ? 'entries allowed' : 'entries blocked'}</Tag>}>
          <Checks checks={L.risk.checks} />
          <div className="sec" style={{ fontSize: 12, marginTop: 8 }}>Trades in rolling 24h: <b>{L.risk.tradesLast24h}</b> / {state.settings.limits.maxTradesPer24h}</div>
          <Meter value={L.risk.tradesLast24h} max={state.settings.limits.maxTradesPer24h} label="Live trades in rolling 24 hours" />
        </Card>
      </div>

      <div className="grid g-2">
        <Card title="Exchange positions" hint="From the exchange (real-time position endpoint)" right={<Tag kind="real">Real</Tag>}>
          {!apiOk ? (
            <div className="empty">Unavailable</div>
          ) : pos ? (
            <>
              <table className="kv">
                <tbody>
                  <tr><td className="sec">Contract</td><td className="num">{pos.symbol || state.spec.symbol}</td></tr>
                  <tr><td className="sec">Size</td><td className="num">{pos.size > 0 ? '▲ LONG' : '▼ SHORT'} {Math.abs(pos.size)} contracts = {num(Math.abs(pos.size) * state.spec.contractValue, 2)} ETH</td></tr>
                  <tr><td className="sec">Entry price (actual)</td><td className="num">{num(pos.entryPrice)}</td></tr>
                  <tr><td className="sec">Mark</td><td className="num">{num(pos.markPrice)}</td></tr>
                  <tr><td className="sec">Unrealised P&L</td><td className="num"><Pnl v={pos.unrealizedPnl} /></td></tr>
                  <tr><td className="sec">Margin · liquidation</td><td className="num">{usd(pos.margin)} · {num(pos.liquidationPrice)}</td></tr>
                  <tr><td className="sec">Bot tracking</td><td className="num">{tracked ? `trade ${tracked.id} · stop ${num(tracked.stopPrice)} · target ${num(tracked.targetPrice)}` : <b className="bad">NOT tracked by the bot</b>}</td></tr>
                </tbody>
              </table>
              {tracked && <div style={{ marginTop: 8 }}><div className="sec" style={{ fontSize: 12 }}>Holding {duration(state.now - tracked.entryTs)} of {state.settings.exits.maxHoldMinutes}m</div><Meter value={state.now - tracked.entryTs} max={state.settings.exits.maxHoldMinutes * 60_000} label="Holding time" /></div>}
              {actions.isAdmin && <button className="btn danger sm" style={{ marginTop: 10 }} onClick={() => window.confirm('Close the REAL position now with a reduce-only market order?') && actions.run('Close position', () => api('POST', 'live/close-position'), 'Close order sent')}>Close real position</button>}
            </>
          ) : (
            <div className="empty">Flat — no open exchange position.</div>
          )}
        </Card>

        <Card title="Open orders" hint="Real resting / pending orders on this contract" right={<Tag kind="real">Real</Tag>}>
          {!apiOk ? (
            <div className="empty">Unavailable</div>
          ) : a.openOrders.length === 0 ? (
            <div className="empty">No open orders.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Side</th><th>Type</th><th className="num">Size</th><th className="num">Price</th><th>State</th></tr></thead>
                <tbody>
                  {a.openOrders.map((o) => (
                    <tr key={o.id}>
                      <td>{o.id}</td>
                      <td>{o.side}</td>
                      <td>{o.stopOrderType ? o.stopOrderType.replace(/_order/, '').replace('_', ' ') : o.orderType.replace('_order', '')}{o.reduceOnly ? ' · reduce-only' : ''}</td>
                      <td className="num">{o.size}</td>
                      <td className="num">{num(o.stopPrice ?? o.limitPrice)}</td>
                      <td>{o.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid g-4">
        <Stat label="Realised P&L (bot trades)" value={<Pnl v={realized} />} sub="net of actual exchange fees" />
        <Stat label="Actual fees paid" value={usd(fees)} sub="from exchange fills" />
        <Stat label="Live trades · rolling 24h" value={`${L.risk.tradesLast24h} / ${state.settings.limits.maxTradesPer24h}`} />
        <Stat label="Consecutive losses" value={`${L.consecutiveLosses} / ${state.settings.limits.maxConsecutiveLosses}`} sub="circuit breaker pauses entries" />
      </div>

      <div className="grid">
        <Card title="Live trade history" hint="Real exchange trades only — demo trades are never shown here" right={<Tag kind="real">Real</Tag>}>
          <TradesTable rows={rows} mode="live" />
        </Card>
      </div>

      {L.lastDecision && (
        <div className="grid">
          <Card title="Last live entry decision" hint={`Candle ${new Date(L.lastDecision.candleTime).toLocaleString()}`}>
            <Tag kind={L.lastDecision.allowed ? 'good' : 'warn'}>{L.lastDecision.allowed ? 'order sent' : 'not traded'}</Tag>
            {!L.lastDecision.allowed && <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{L.lastDecision.reasons.slice(0, 6).map((r, i) => <li key={i} className="sec">{r}</li>)}</ul>}
          </Card>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>Amounts are USD-equivalent. Nothing on this tab is taken from the demo account.</p>
    </div>
  );
}
