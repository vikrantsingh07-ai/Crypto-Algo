'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { duration, inr, num, pctRaw, signedUsd, timeShort, usd } from '@/lib/format';
import type { BotState, TradeRow } from '@/lib/types';
import type { Actions } from './Dashboard';
import { LineChart } from './charts';
import { Card, Checks, Pnl, Stat, Tag } from './ui';
import { Meter } from './charts';

function useTrades(mode: 'demo' | 'live', everyMs = 5000) {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ trades: TradeRow[] }>('GET', `trades?mode=${mode}&limit=60`).then((r) => alive && setRows(r.trades)).catch(() => {});
    void load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mode, everyMs]);
  return rows;
}

export function ConditionList({ state }: { state: BotState }) {
  const ev = state.evaluation;
  if (!ev) return <div className="muted">No candle evaluated yet — the strategy runs on every closed 1-minute candle.</div>;
  if (!ev.ready) return <div className="muted">Warming up indicators ({ev.index + 1} candles loaded)…</div>;
  const Side = ({ s, name }: { s: typeof ev.long; name: string }) => {
    const passed = s.conditions.filter((c) => c.pass).length;
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <b>{name}</b>
          <Tag kind={s.pass ? 'good' : undefined}>{passed}/{s.conditions.length} conditions</Tag>
        </div>
        <ul className="checks" style={{ marginTop: 6 }}>
          {s.conditions.map((c) => (
            <li key={c.name} title={c.detail}>
              <span className={`mark ${c.pass ? 'ok' : 'no'}`}>{c.pass ? '✓' : '✕'}</span>
              <span><b>{c.name.replace(/_/g, ' ')}</b> <span className="muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      </div>
    );
  };
  return (
    <div className="grid g-2" style={{ marginTop: 0 }}>
      <Side s={ev.long} name="Long setup" />
      <Side s={ev.short} name="Short setup" />
    </div>
  );
}

export function TradesTable({ rows, mode }: { rows: TradeRow[] | null; mode: 'demo' | 'live' }) {
  if (!rows) return <div className="empty">Loading…</div>;
  if (!rows.length) return <div className="empty">{mode === 'demo' ? 'No simulated trades yet.' : 'No live trades recorded by this bot yet.'}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Opened</th><th>Side</th><th className="num">Qty ETH</th><th className="num">Entry</th><th className="num">Exit</th><th>Exit reason</th>
            <th className="num">Hold</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net</th><th className="num">Net ₹</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{timeShort(t.entryTs)}</td>
              <td>{t.side === 'long' ? '▲ Long' : '▼ Short'}</td>
              <td className="num">{num(t.qtyEth, 2)}</td>
              <td className="num">{num(t.entryPrice)}</td>
              <td className="num">{t.status === 'closed' ? num(t.exitPrice) : t.status === 'open' ? <Tag>open</Tag> : <Tag kind="warn">{t.status}</Tag>}</td>
              <td>{t.exitReason?.replace(/_/g, ' ') ?? '—'}</td>
              <td className="num">{duration(t.holdMs)}</td>
              <td className="num">{t.grossPnl === null ? '—' : signedUsd(t.grossPnl)}</td>
              <td className="num">{t.fees === null ? '—' : usd(t.fees)}</td>
              <td className="num"><Pnl v={t.netPnl} /></td>
              <td className="num">{t.netPnlInr === null ? '—' : inr(t.netPnlInr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DemoPanel({ state, actions }: { state: BotState; actions: Actions }) {
  const d = state.demo;
  const trades = useTrades('demo');
  if (!d) return <div className="card" style={{ marginTop: 12 }}>Demo account not initialised yet (worker starting)…</div>;

  const pos = d.openPosition;
  const q = state.feed.quote;
  const dir = pos ? (pos.side === 'long' ? 1 : -1) : 0;
  const mark = pos && q ? (pos.side === 'long' ? q.bid : q.ask) : null;
  const unrealGross = pos && mark !== null ? dir * (mark - pos.entryPrice) * pos.qtyEth : null;
  const rates = state.economics?.rates ?? { taker: state.spec.takerFeeRate, gst: state.settings.execution.gstRate };
  const estExitFee = pos && mark !== null ? mark * pos.qtyEth * (state.settings.execution.takerFeeRate ?? rates.taker) * (1 + rates.gst) : null;
  const heldMs = pos ? state.now - pos.entryTs : 0;
  const maxHoldMs = state.settings.exits.maxHoldMinutes * 60_000;
  const closed = trades?.filter((t) => t.status === 'closed') ?? [];
  const wins = closed.filter((t) => (t.netPnl ?? 0) > 0).length;
  const realized = d.balanceUsd - d.startingBalanceUsd + (pos?.entryFee.total ?? 0);
  const sig = state.evaluation?.signal;
  const spark = state.spark.map(([x, y]) => ({ x, y }));
  const markers = pos
    ? [
        { y: pos.targetPrice, label: `Target ${num(pos.targetPrice)}`, color: 'var(--series-3)' },
        { y: pos.entryPrice, label: `Entry ${num(pos.entryPrice)}`, color: 'var(--ink-muted)' },
        { y: pos.stopPrice, label: `Stop ${num(pos.stopPrice)}`, color: 'var(--status-critical)' },
      ]
    : [];

  return (
    <div>
      <div className="grid g-main">
        <Card
          title="Simulated account"
          hint="Virtual balance · live Delta prices · simulated fills, fees, slippage and funding"
          right={<Tag kind="sim">Simulated — no real orders</Tag>}
        >
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <div className="sec" style={{ fontSize: 12 }}>Demo equity</div>
              <div className="hero tabnum">{usd(d.equityUsd)}</div>
              <div className="muted tabnum">{inr(d.equityUsd * d.usdInrRate)} <span style={{ fontSize: 11 }}>(@ ₹{d.usdInrRate}/USD, configured rate)</span></div>
            </div>
            <div className="tabnum">
              <div className="sec" style={{ fontSize: 12 }}>vs starting {usd(d.startingBalanceUsd)}</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}><Pnl v={d.equityUsd - d.startingBalanceUsd} /></div>
            </div>
          </div>
          <div className="grid g-4" style={{ marginTop: 14 }}>
            <Stat label="Realised P&L" value={<Pnl v={realized} />} sub={`balance ${usd(d.balanceUsd)}`} />
            <Stat label="Unrealised (gross)" value={<Pnl v={unrealGross ?? d.unrealizedPnlUsd} />} sub={pos ? `est. exit fee ${usd(estExitFee, 3)}` : 'flat'} />
            <Stat label="Fees paid (simulated)" value={usd(d.totalFeesUsd)} sub="maker/taker + GST" />
            <Stat label="Max drawdown" value={pctRaw(d.maxDrawdownPct, 2)} sub={`peak ${usd(d.peakEquityUsd)}`} />
            <Stat label="Win rate (last 60)" value={closed.length ? pctRaw((wins / closed.length) * 100, 0) : '—'} sub={`${wins}/${closed.length} trades`} />
            <Stat label="Trades · rolling 24h" value={<>{d.tradesLast24h}<span className="muted"> / {state.settings.limits.maxTradesPer24h}</span></>} sub={<Meter value={d.tradesLast24h} max={state.settings.limits.maxTradesPer24h} label="Trades in rolling 24 hours" />} />
            <Stat label="Leverage · quantity" value={`${state.settings.position.leverage}x · ${state.settings.position.quantityEth} ETH`} sub={`${state.economics?.contracts ?? '—'} contracts × ${state.spec.contractValue} ETH`} />
            <Stat label="Bot" value={state.running ? 'Running' : 'Stopped'} sub={state.running ? 'evaluating each 1m candle' : 'exits still managed'} />
          </div>
        </Card>

        <Card title="Current position" hint="Simulated" right={pos ? <Tag kind="sim">{pos.side === 'long' ? '▲ LONG' : '▼ SHORT'}</Tag> : <Tag>flat</Tag>}>
          {pos ? (
            <>
              <table className="kv">
                <tbody>
                  <tr><td className="sec">Quantity · leverage</td><td className="num">{pos.qtyEth} ETH · {pos.leverage}x</td></tr>
                  <tr><td className="sec">Entry (incl. slippage)</td><td className="num">{num(pos.entryPrice)}</td></tr>
                  <tr><td className="sec">Mark (exit side)</td><td className="num">{num(mark)}</td></tr>
                  <tr><td className="sec">Target · Stop</td><td className="num">{num(pos.targetPrice)} · {num(pos.stopPrice)}{pos.breakevenArmed ? ' (break-even)' : ''}</td></tr>
                  <tr><td className="sec">Gross P&L</td><td className="num"><Pnl v={unrealGross} /></td></tr>
                  <tr><td className="sec">Entry fee (simulated) · est. exit fee</td><td className="num">{usd(pos.entryFee.total, 3)} · {usd(estExitFee, 3)}</td></tr>
                  <tr><td className="sec">Net if closed now</td><td className="num"><Pnl v={unrealGross !== null && estExitFee !== null ? unrealGross - pos.entryFee.total - estExitFee : null} /></td></tr>
                  <tr><td className="sec">Liquidation (est.)</td><td className="num">{num(pos.liquidationPrice)}</td></tr>
                  <tr><td className="sec">Max favourable move</td><td className="num">${num(pos.mfe)} of ${num(pos.targetMoveUsd)} target</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 8 }}>
                <div className="sec" style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between' }}><span>Holding time</span><span className="tabnum">{duration(heldMs)} / {duration(maxHoldMs)}</span></div>
                <Meter value={heldMs} max={maxHoldMs} label="Holding time used" />
              </div>
              {actions.isAdmin && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => actions.run('Close', () => api('POST', 'demo/close'), 'Simulated position closed')}>Close simulated position</button>}
            </>
          ) : (
            <div>
              <p style={{ marginTop: 0 }}>
                <b>No open simulated position.</b> The bot opens a trade only when every strategy condition passes <i>and</i> the risk manager approves — it never trades just to use the daily quota.
              </p>
              <div className="sec">Latest signal: {sig ? <b>{sig.side.toUpperCase()} @ {num(sig.refPrice)} (target ${num(sig.targetMoveUsd)}, stop ${num(sig.stopMoveUsd)})</b> : <b>none</b>}</div>
              {d.lastDecision && (
                <div style={{ marginTop: 8 }}>
                  <Tag kind={d.lastDecision.allowed ? 'good' : 'warn'}>{d.lastDecision.allowed ? 'last signal taken' : 'last signal rejected'}</Tag>
                  {!d.lastDecision.allowed && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{d.lastDecision.reasons.slice(0, 5).map((r, i) => <li key={i} className="sec" style={{ fontSize: 12 }}>{r}</li>)}</ul>}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid g-main">
        <Card>
          <LineChart
            title={`${state.spec.symbol} price`}
            subtitle={pos ? 'Last 90 one-minute closes with entry, target and stop' : 'Last 90 one-minute closes'}
            points={spark}
            yFmt={(v) => num(v, v > 1000 ? 0 : 2)}
            tipFmt={(p) => `$${num(p.y)}`}
            markers={markers}
            area={false}
            height={230}
            tableHead={['Time', 'Close']}
          />
        </Card>
        <Card title="Risk status" hint="Mandatory pre-trade checks (Demo)" right={<Tag kind={d.risk.tradingAllowed ? 'good' : 'warn'}>{d.risk.tradingAllowed ? 'entries allowed' : 'entries blocked'}</Tag>}>
          <Checks checks={d.risk.checks} />
        </Card>
      </div>

      <div className="grid">
        <Card title="Signal diagnostics" hint={state.evaluation ? `Evaluated candle ${timeShort(state.evaluation.candleTime)} · regime ${state.evaluation.regime.replace('_', ' ')} · ATR $${num(state.evaluation.atr)}` : undefined}>
          <ConditionList state={state} />
        </Card>
      </div>

      <div className="grid">
        <Card
          title="Demo trade history"
          hint="Simulated trades only — stored separately from real exchange trades"
          right={
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Tag kind="sim">Simulated</Tag>
              {actions.isAdmin && (
                <>
                  <button className="btn sm" onClick={() => actions.run('Bot', () => api('POST', state.running ? 'bot/stop' : 'bot/start'), state.running ? 'Bot stopped' : 'Bot started')}>{state.running ? 'Stop bot' : 'Start bot'}</button>
                  <button className="btn sm ghost" onClick={() => window.confirm('Start a new virtual account? History is kept but the current epoch restarts.') && actions.run('Reset', () => api('POST', 'demo/reset', {}), 'Demo account reset')}>Reset account</button>
                </>
              )}
            </div>
          }
        >
          <TradesTable rows={trades} mode="demo" />
        </Card>
      </div>
    </div>
  );
}
