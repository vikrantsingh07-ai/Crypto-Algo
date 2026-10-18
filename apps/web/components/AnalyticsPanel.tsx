'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { dayShort, inr, num, pct, pctRaw, signedUsd, timeShort, usd } from '@/lib/format';
import { minutes, scalperView } from '@/lib/scalper';
import type { Analytics, BotState, Metrics } from '@/lib/types';
import { BarChart, HBarChart, LineChart, compact } from './charts';
import { Card, Pnl, Stat, Tag } from './ui';

type View = 'demo' | 'live' | 'backtest';

export default function AnalyticsPanel({ state }: { state: BotState }) {
  const [view, setView] = useState<View>('demo');
  return (
    <div>
      <div className="tabs wrap" role="tablist" style={{ marginTop: 8 }}>
        {(
          [
            ['demo', 'Paper trading (simulated)'],
            ['live', 'Live (actual)'],
            ['backtest', 'Backtests (historical)'],
          ] as [View, string][]
        ).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={view === k} className="tab" onClick={() => setView(k)}>{t}</button>
        ))}
      </div>
      {view === 'backtest' ? <Backtests state={state} /> : <TradeAnalytics mode={view} state={state} />}
    </div>
  );
}

function TradeAnalytics({ mode, state }: { mode: 'demo' | 'live'; state: BotState }) {
  const [data, setData] = useState<Analytics | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () => api<Analytics>('GET', `analytics?mode=${mode}`).then((r) => alive && setData(r)).catch(() => {});
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mode]);

  if (!data) return <div className="card" style={{ marginTop: 12 }}>Loading analytics…</div>;
  const m = data.metrics;
  const rate = state.settings.execution.usdInrRate;
  const v = scalperView(state, 'demo');
  return (
    <div>
      <div className="banner info" style={{ marginTop: 12 }}>
        <span className="icon">{mode === 'demo' ? '◇' : '●'}</span>
        <div>
          <b>{data.label}</b>{mode === 'demo' ? ' — fills, fees and slippage are simulated against live prices; real execution will differ.' : ' — computed from real exchange fills recorded by this bot, with the fees Delta actually charged.'}
          {mode === 'demo' && (
            <div className="sec" style={{ fontSize: 12, marginTop: 4 }}>
              {v.assumed
                ? <><b>Assumption:</b> closing fees are waived on trades closed within {v.windowMin} min (Delta Scalper Offer). Delta does not expose the offer through its API, so these numbers depend on that assumption holding for your account.</>
                : <>Scalper Offer assumption is <b>off</b>: the full closing fee is counted.</>}
            </div>
          )}
        </div>
      </div>
      <MetricsBlock m={m} rate={rate} recent={data.recent} drawdown={data.drawdown} state={state} basis={mode} emptyHint={mode === 'demo' ? 'Run the bot in Demo to collect results.' : 'No live trades recorded yet.'} />
    </div>
  );
}

function histogram(values: number[], bins = 12): { label: string; value: number; sub: string; lo: number }[] {
  if (!values.length) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const w = (hi - lo) / bins || 0.1;
  const out = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * w, value: 0, label: '', sub: '' }));
  for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))].value++;
  return out.map((b) => ({ ...b, label: `${b.lo >= 0 ? '+' : '−'}${Math.abs(b.lo).toFixed(2)}`, sub: `$${b.lo.toFixed(2)} to $${(b.lo + w).toFixed(2)}` }));
}

function MetricsBlock({ m, rate, recent, drawdown, state, emptyHint, ddOverride, basis }: { m: Metrics; rate: number; recent?: Analytics['recent']; drawdown?: Analytics['drawdown']; state: BotState; emptyHint: string; ddOverride?: { ts: number; dd: number }[]; basis: 'demo' | 'live' | 'backtest' }) {
  const v = scalperView(state, basis === 'live' ? 'live' : 'demo');
  const assumption = basis !== 'live';
  const eq = m.equityCurve.map((p) => ({ x: p.ts, y: p.equity }));
  const spanMs = eq.length > 1 ? eq[eq.length - 1].x - eq[0].x : 0;
  const xAxis = (x: number) => (spanMs < 2 * 86_400_000 ? new Date(x).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : dayShort(x));
  const dd = (ddOverride ?? drawdown ?? []).map((p) => ({ x: p.ts, y: p.dd }));
  const daily = m.dailyPnl.map((d) => ({ label: dayShort(Date.parse(d.day)), value: d.netPnl, sub: `${d.trades} trades · fees ${usd(d.fees)}` }));
  const bins = useMemo(() => histogram((recent ?? []).map((t) => t.netPnl)), [recent]);
  const exits = Object.entries(m.exitReasons).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v }));
  const hold = m.totalTrades ? m.holdingBuckets.map((b) => ({ label: b.label, value: b.count })) : [];
  const side = (m.totalTrades ? (['long', 'short'] as const) : ([] as ('long' | 'short')[])).map((s) => ({ label: s === 'long' ? 'Long' : 'Short', value: m.bySide[s].netPnl, sub: `${m.bySide[s].trades} trades · win ${pct(m.bySide[s].winRate, 0)}` }));
  const regimes = Object.entries(m.byRegime).filter(([, g]) => g.trades > 0);

  return (
    <div>
      {m.totalTrades === 0 && <div className="card" style={{ marginTop: 12 }}><div className="empty">{emptyHint}</div></div>}
      {m.smallSample && m.totalTrades > 0 && <div className="banner warn"><span className="icon">!</span><div><b>Small sample ({m.totalTrades} trades).</b> Results with fewer than 100 trades are statistically weak — the 95% interval for the win rate is {pct(m.winRateCI95.low, 0)}–{pct(m.winRateCI95.high, 0)}. Do not read this as evidence of profitability.</div></div>}
      <div className="grid g-6">
        <Stat label="Trades" value={m.totalTrades} sub={`${m.wins} wins · ${m.losses} losses`} />
        <Stat label="Win rate" value={pct(m.winRate, 1)} sub={`95% CI ${pct(m.winRateCI95.low, 0)}–${pct(m.winRateCI95.high, 0)}`} />
        <Stat label="Gross P&L" value={<Pnl v={m.grossPnl} />} sub="before costs" />
        <Stat label="Fees & costs" value={usd(m.fees)} sub={`funding ${signedUsd(m.funding ?? 0)}`} />
        <Stat label="Net P&L" value={<Pnl v={m.netPnl} />} sub={inr(m.netPnlInr || m.netPnl * rate)} tone={m.netPnl > 0 ? 'good' : m.netPnl < 0 ? 'bad' : undefined} />
        <Stat label="Profit factor" value={m.profitFactor === null ? '∞' : num(m.profitFactor)} sub={`avg win ${usd(m.avgWin)} · avg loss ${usd(m.avgLoss)}`} />
        <Stat label="Max drawdown" value={pctRaw(m.maxDrawdownPct, 2)} sub={usd(m.maxDrawdownUsd)} />
        <Stat label="Avg hold" value={`${num(m.avgHoldMinutes, 1)} min`} sub={`time-exit limit ${minutes(v.effectiveMaxHoldMin)}${v.clamped ? ' (fee-free window)' : ''}`} />
        <Stat label="Reached target" value={pctRaw(m.targetReachedPct, 0)} sub="price hit the target distance" />
        <Stat label="Take-profit exits" value={pctRaw(m.takeProfitPct, 0)} sub="filled by the TP order" />
        <Stat label="Stop-loss exits" value={pctRaw(m.stopLossPct, 0)} sub={`break-even stops ${pctRaw(m.breakevenStopPct, 0)}`} />
        <Stat label="Time exits" value={pctRaw(m.timeExitPct, 0)} sub="closed at the time limit" />
        {m.feesSavedUsd !== undefined && (
          <Stat
            wide
            label="Closing fees saved (Scalper Offer)"
            value={<span className="good">{usd(m.feesSavedUsd, 3)}</span>}
            sub={assumption ? `Assumption-based: ${basis === 'demo' ? 'simulated trades' : 'backtest'} that closed within ${v.windowMin} min are counted as paying no closing fee. Delta does not expose the offer via its API, so verify it in Live.` : 'Live: closing fees the exchange did not charge on trades closed inside the window, estimated as the fee they would have paid. Actual fees paid are in the Fees stat.'}
          />
        )}
      </div>
      {m.breakevenWinRate !== null && m.totalTrades > 0 && (
        <p className="sec" style={{ fontSize: 12 }}>Break-even win rate for the realised average win/loss: <b>{pct(m.breakevenWinRate, 1)}</b> (actual {pct(m.winRate, 1)}).</p>
      )}

      <div className="grid g-2">
        <Card><LineChart title="Cumulative net P&L (equity)" subtitle="After fees, closed trades" points={eq} yFmt={(v) => usd(v, 2)} xFmt={xAxis} tipFmt={(p) => usd(p.y)} tableHead={['Date', 'Equity']} empty="No closed trades yet" /></Card>
        <Card><LineChart title="Drawdown" subtitle="% below the running peak" points={dd} color="var(--series-2)" yFmt={(v) => `${v.toFixed(1)}%`} xFmt={xAxis} tipFmt={(p) => `${p.y.toFixed(2)}%`} yDomain={dd.length ? [0, Math.max(1, ...dd.map((p) => p.y)) * 1.15] : undefined} tableHead={['Date', 'Drawdown']} empty="No closed trades yet" /></Card>
      </div>
      <div className="grid g-2">
        <Card><BarChart title="Daily net P&L" subtitle="Blue = gain, red = loss (sign shown in the tooltip)" bars={daily} diverging yFmt={(v) => usd(v)} tipFmt={(b) => signedUsd(b.value)} /></Card>
        <Card><BarChart title="Trade distribution — net P&L per trade" subtitle="Count of trades by net result (USD)" bars={bins} color="var(--series-1)" yFmt={(v) => String(Math.round(v))} tipFmt={(b) => `${b.value} trades`} height={200} maxXLabels={6} /></Card>
      </div>
      <div className="grid g-3">
        <Card><HBarChart title="Exit reasons" bars={exits} /></Card>
        <Card><BarChart title="Holding time" subtitle="Trades by time held" bars={hold} yFmt={(v) => String(Math.round(v))} tipFmt={(b) => `${b.value} trades`} height={170} /></Card>
        <Card><BarChart title="Long vs Short" subtitle="Net P&L by direction" bars={side} diverging yFmt={(v) => usd(v)} tipFmt={(b) => signedUsd(b.value)} height={170} /></Card>
      </div>
      <div className="grid g-2">
        <Card title="Direction breakdown">
          <div className="table-wrap"><table>
            <thead><tr><th>Side</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Gross/Net</th><th className="num">Fees</th><th className="num">Avg net</th></tr></thead>
            <tbody>
              {(['long', 'short'] as const).map((s) => (
                <tr key={s}><td>{s === 'long' ? '▲ Long' : '▼ Short'}</td><td className="num">{m.bySide[s].trades}</td><td className="num">{pct(m.bySide[s].winRate, 0)}</td><td className="num"><Pnl v={m.bySide[s].grossPnl} /> / <Pnl v={m.bySide[s].netPnl} /></td><td className="num">{usd(m.bySide[s].fees)}</td><td className="num"><Pnl v={m.bySide[s].avgNetPnl} /></td></tr>
              ))}
            </tbody>
          </table></div>
        </Card>
        <Card title="Performance by market regime" hint="Regime at entry: trend / range / volatility">
          {regimes.length === 0 ? <div className="empty">No trades yet</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Regime</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Net</th><th className="num">Avg net</th></tr></thead>
              <tbody>{regimes.map(([r, g]) => <tr key={r}><td>{r.replace('_', ' ')}</td><td className="num">{g.trades}</td><td className="num">{pct(g.winRate, 0)}</td><td className="num"><Pnl v={g.netPnl} /></td><td className="num"><Pnl v={g.avgNetPnl} /></td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}

interface RunRow { id: string; kind: string; dataSource: string; status: string; params: any; summary: any; error: string | null; createdAt: string; finishedAt: string | null }

function Backtests({ state }: { state: BotState }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [kind, setKind] = useState<'backtest' | 'walkforward'>('walkforward');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const synthetic = state.deployment.marketData === 'synthetic';

  const load = useCallback(async () => {
    const r = await api<{ runs: RunRow[] }>('GET', 'backtests').catch(() => null);
    if (r) setRuns(r.runs);
  }, []);
  useEffect(() => {
    void load();
    void api<{ role: string }>('GET', 'auth/me').then((m) => setAdmin(m.role === 'admin')).catch(() => {});
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function open(id: string) {
    setSel(await api('GET', `backtests/${id}`));
  }
  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const body = kind === 'walkforward' ? { kind, days, trainDays: Math.max(3, Math.round(days / 3)), testDays: Math.max(2, Math.round(days / 6)) } : { kind, days };
      const r = await api<{ id: string }>('POST', 'backtests', body);
      await load();
      setTimeout(() => void open(r.id), 800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const res = sel?.status === 'done' ? sel.result : null;
  const oos: Metrics | null = res ? (res.outOfSampleMetrics ?? null) : null;

  return (
    <div>
      <div className={`banner ${synthetic ? 'warn' : 'info'}`} style={{ marginTop: 12 }}>
        <span className="icon">◷</span>
        <div>
          <b>Historical backtests</b> — {synthetic ? <b>this server uses SYNTHETIC data; results are a mechanics check only.</b> : 'downloads public ETH 1-minute candles from Delta Exchange and replays the strategy with the same risk manager, fee model and conservative fill rules as Demo.'}
          {' '}A walk-forward run picks parameters on a training window and reports only the untouched out-of-sample window.
          <div className="sec" style={{ fontSize: 12, marginTop: 4 }}>
            {scalperView(state, 'demo').assumed
              ? <><b>Assumption:</b> closing fees are waived on trades closed within {scalperView(state, 'demo').windowMin} min (Delta Scalper Offer, as supplied by the operator and not verifiable through the API). Results depend on your account having joined it.</>
              : <>Scalper Offer assumption is <b>off</b>: the full closing fee is counted.</>}
          </div>
        </div>
      </div>
      <div className="grid g-main">
        <Card title="Run a backtest" hint="Runs on the server; results are stored">
          <div className="fields">
            <div className="field"><label htmlFor="bk">Type</label><select id="bk" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="walkforward">Walk-forward (out-of-sample)</option><option value="backtest">Single backtest (70/30 split)</option></select></div>
            <div className="field"><label htmlFor="bd">History (days, 2–60)</label><input id="bd" type="number" min={2} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} disabled={!admin || busy} onClick={start}>{busy ? 'Starting…' : 'Run'}</button>
          {!admin && <span className="muted" style={{ marginLeft: 8 }}>admin only</span>}
          {err && <p className="bad">{err}</p>}
        </Card>
        <Card title="Previous runs">
          {runs.length === 0 ? <div className="empty">No runs yet</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Started</th><th>Type</th><th>Data</th><th>Status</th><th className="num">Net (OOS)</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const o = r.summary?.outOfSample ?? r.summary?.fullSample;
                  return (
                    <tr key={r.id}>
                      <td>{timeShort(Date.parse(r.createdAt))}</td><td>{r.kind}</td><td>{r.dataSource === 'synthetic' ? <Tag kind="warn">synthetic</Tag> : 'Delta'}</td>
                      <td>{r.status === 'failed' ? <span className="bad" title={r.error ?? ''}>failed</span> : r.status}</td>
                      <td className="num">{o ? <Pnl v={o.netPnl} /> : '—'}</td>
                      <td><button className="linkbtn" disabled={r.status !== 'done'} onClick={() => open(r.id)}>open</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      {res && (
        <div>
          <Card title={`${res.kind === 'walkforward' ? 'Walk-forward' : 'Backtest'} result`} hint={`${res.candles.toLocaleString()} candles · ${timeShort(res.from)} → ${timeShort(res.to)} · spread assumption $${res.spreadUsd}`} right={res.synthetic ? <Tag kind="warn">SYNTHETIC DATA</Tag> : <Tag>Historical</Tag>}>
            <p style={{ marginTop: 0 }}><b>{res.note}</b></p>
            {res.costNote && (
              <p className="sec">Cost reality at ETH ${num(res.costNote.referencePrice, 0)}: price must move <b>${num(res.costNote.breakevenMoveUsd)}</b> to cover fees; fees ≈ {usd(res.costNote.roundTripFeeIfTargetUsd, 3)} per winning round trip; the minimum target nets {signedUsd(res.costNote.netRewardAtMinTargetUsd)} and needs a win rate of <b>{pct(res.costNote.requiredWinRateAtMinTarget, 0)}</b> to break even.</p>
            )}
            {res.kind === 'backtest' ? (
              <div className="table-wrap"><table>
                <thead><tr><th>Sample</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net</th><th className="num">PF</th><th className="num">Max DD</th></tr></thead>
                <tbody>
                  {([['In-sample (70%)', res.inSample], ['Out-of-sample (30%)', res.outOfSample], ['Full', res.fullSample]] as [string, any][]).map(([l, s]) => (
                    <tr key={l}><td>{l}</td><td className="num">{s.trades}</td><td className="num">{pct(s.winRate, 0)}</td><td className="num"><Pnl v={s.grossPnl} /></td><td className="num">{usd(s.fees)}</td><td className="num"><Pnl v={s.netPnl} /></td><td className="num">{s.profitFactor === null ? '∞' : num(s.profitFactor)}</td><td className="num">{pctRaw(s.maxDrawdownPct, 1)}</td></tr>
                  ))}
                </tbody>
              </table></div>
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>Fold</th><th>Chosen params</th><th>Test window</th><th className="num">IS net</th><th className="num">OOS trades</th><th className="num">OOS win</th><th className="num">OOS net</th></tr></thead>
                <tbody>
                  {res.folds.map((f: any) => (
                    <tr key={f.fold}><td>{f.fold}</td><td>{f.chosen}</td><td>{dayShort(f.testFrom)}–{dayShort(f.testTo)}</td><td className="num"><Pnl v={f.inSample.netPnl} /></td><td className="num">{f.outOfSample.trades}</td><td className="num">{pct(f.outOfSample.winRate, 0)}</td><td className="num"><Pnl v={f.outOfSample.netPnl} /></td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
            <ul className="sec" style={{ fontSize: 12, marginBottom: 0 }}>{res.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
          </Card>
          {oos && <MetricsBlock m={oos} rate={state.settings.execution.usdInrRate} state={state} basis="backtest" emptyHint="No out-of-sample trades" ddOverride={(oos as any).drawdownCurve} recent={res.trades?.map((t: any) => ({ ...t }))} />}
        </div>
      )}
    </div>
  );
}

export { compact };
