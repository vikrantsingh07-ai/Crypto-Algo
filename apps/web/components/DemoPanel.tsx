'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { duration, inr, num, pctRaw, signedUsd, timeShort, usd } from '@/lib/format';
import { feeWindow, scalperView } from '@/lib/scalper';
import type { BotState, TradeRow } from '@/lib/types';
import type { Actions } from './Dashboard';
import { LineChart } from './charts';
import { ExitFeeClock, FeeRealityCard, useServerNow } from './scalper';
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

/**
 * Exit-fee cell: the charged amount (Live: as reported by the exchange). `windowMin` is the Scalper Offer window and is null
 * while the offer is not in use (the default), in which case nothing about the offer is mentioned; a zero fee on an older
 * trade that did use it still reads FREE.
 */
function ExitFeeCell({ t, windowMin, live }: { t: TradeRow; windowMin: number | null; live: boolean }) {
  if (t.exitFee === null || t.exitFee === undefined) return <span className="muted">—</span>;
  const saved = t.exitFeeSaved ?? t.meta?.exitFeeSaved ?? null;
  if (t.exitFee === 0 && (windowMin !== null || saved)) {
    return <><Tag kind="good">FREE</Tag>{saved ? <div className="sub">saved {usd(saved, 3)}</div> : live ? <div className="sub">exchange: $0.00</div> : null}</>;
  }
  // charged although it closed inside the window: surface it (liquidations and ineligible trades legitimately pay)
  const inside = windowMin !== null && t.holdMs !== null && t.holdMs <= windowMin * 60_000;
  return (
    <span title={inside ? 'Closed inside the offer window but a closing fee was charged (liquidation, not eligible, or the offer is not applied).' : undefined}>
      {usd(t.exitFee, 3)}
      {inside && <div className="sub warn-text">charged in window</div>}
    </span>
  );
}

/** Phone layout: one card per trade so the fee outcome (exit FREE / charged) is visible without sideways scrolling. */
function TradeCards({ rows, live, windowMin }: { rows: TradeRow[]; live: boolean; windowMin: number | null }) {
  return (
    <ul className="trade-cards">
      {rows.map((t) => (
        <li key={t.id}>
          <div className="tc-head">
            <b>{t.side === 'long' ? '▲ Long' : '▼ Short'}</b> <span className="muted">{num(t.qtyEth, 2)} ETH · {timeShort(t.entryTs)}</span>
            <span className="tc-net">{t.status === 'closed' ? <Pnl v={t.netPnl} /> : t.status === 'open' ? <Tag>open</Tag> : <Tag kind="warn">{t.status}</Tag>}</span>
          </div>
          <div className="sec tc-line">
            {t.status === 'closed'
              ? <>{num(t.entryPrice)} → {num(t.exitPrice)} · {t.exitReason?.replace(/_/g, ' ') ?? '—'} · held {duration(t.holdMs)}</>
              : <>entry {num(t.entryPrice)} · {t.status === 'open' ? 'position still open' : t.status.replace(/_/g, ' ')}</>}
          </div>
          {t.status === 'open' && t.entryFee !== null && t.entryFee !== undefined && (
            <div className="tc-fees"><span>entry fee {usd(t.entryFee, 3)} (paid)</span><span className="muted">exit fee is settled when it closes</span></div>
          )}
          {t.status === 'closed' && (
            <div className="tc-fees">
              <span>entry fee {t.entryFee === null || t.entryFee === undefined ? '—' : usd(t.entryFee, 3)}</span>
              <span className="tc-exit">{live ? 'exit fee (exchange)' : 'exit fee'} <ExitFeeCell t={t} windowMin={windowMin} live={live} /></span>
              <span className="muted">net {t.netPnlInr === null ? '—' : inr(t.netPnlInr)}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TradesTable({ rows, mode, windowMin = null }: { rows: TradeRow[] | null; mode: 'demo' | 'live'; windowMin?: number | null }) {
  if (!rows) return <div className="empty">Loading…</div>;
  if (!rows.length) return <div className="empty">{mode === 'demo' ? 'No simulated trades yet.' : 'No live trades recorded by this bot yet.'}</div>;
  const live = mode === 'live';
  return (
    <>
      <TradeCards rows={rows} live={live} windowMin={windowMin} />
      <div className="table-wrap trades-table">
        <table className="sticky-first">
          <thead>
            <tr>
              <th>Opened</th><th>Side</th><th className="num">Qty ETH</th><th className="num">Entry</th><th className="num">Exit</th><th>Exit reason</th>
              <th className="num">Hold</th><th className="num">Gross</th><th className="num">Fees</th>
              <th className="num">Entry fee</th><th className="num">{live ? 'Exit fee (exchange)' : 'Exit fee'}</th>
              <th className="num">Net</th><th className="num">Net ₹</th>
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
                <td className="num">{t.fees === null ? '—' : usd(t.fees, 3)}</td>
                <td className="num">{t.entryFee === null || t.entryFee === undefined ? '—' : usd(t.entryFee, 3)}</td>
                <td className="num">{t.status === 'closed' ? <ExitFeeCell t={t} windowMin={windowMin} live={live} /> : <span className="muted">—</span>}</td>
                <td className="num"><Pnl v={t.netPnl} /></td>
                <td className="num">{t.netPnlInr === null ? '—' : inr(t.netPnlInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function DemoPanel({ state, actions }: { state: BotState; actions: Actions }) {
  const d = state.demo;
  const trades = useTrades('demo');
  const now = useServerNow(state.now);
  if (!d) return <div className="card" style={{ marginTop: 12 }}>Demo account not initialised yet (worker starting)…</div>;

  const pos = d.openPosition;
  const q = state.feed.quote;
  const dir = pos ? (pos.side === 'long' ? 1 : -1) : 0;
  const mark = pos && q ? (pos.side === 'long' ? q.bid : q.ask) : null;
  const unrealGross = pos && mark !== null ? dir * (mark - pos.entryPrice) * pos.qtyEth : null;
  const rates = state.economics?.rates ?? { taker: state.spec.takerFeeRate, gst: state.settings.execution.gstRate };
  const v = scalperView(state, 'demo');
  const heldMs = pos ? Math.max(0, now - pos.entryTs) : 0;
  // null = no time limit (the default). With the offer on, an existing limit is clamped to window - margin (28.5 min, not the raw 30)
  const maxHoldMs = v.effectiveMaxHoldMin === null ? null : v.effectiveMaxHoldMin * 60_000;
  const waivedNow = !!pos && v.effective && feeWindow(pos.entryTs, v.windowMin, now).remainingMs > 0;
  const takerExitFee = pos && mark !== null ? mark * pos.qtyEth * (state.settings.execution.takerFeeRate ?? rates.taker) * (1 + rates.gst) : null;
  const estExitFee = waivedNow ? 0 : takerExitFee;
  const closed = trades?.filter((t) => t.status === 'closed') ?? [];
  const savedSum = closed.reduce((a, t) => a + (t.exitFeeSaved ?? t.meta?.exitFeeSaved ?? 0), 0);
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
            <Stat label="Unrealised (gross)" value={<Pnl v={unrealGross ?? d.unrealizedPnlUsd} />} sub={pos ? (waivedNow ? 'exit fee free (offer, assumed)' : `est. exit fee ${usd(estExitFee, 3)}`) : 'flat'} />
            <Stat label="Fees paid (simulated)" value={usd(d.totalFeesUsd)} sub={v.effective ? 'entry fee + GST; closing free ≤ ' + v.windowMin + ' min (assumed)' : 'maker/taker + GST'} />
            <Stat label="Max drawdown" value={pctRaw(d.maxDrawdownPct, 2)} sub={`peak ${usd(d.peakEquityUsd)}`} />
            <Stat label="Win rate (last 60)" value={closed.length ? pctRaw((wins / closed.length) * 100, 0) : '—'} sub={`${wins}/${closed.length} trades`} />
            <Stat label="Trades · rolling 24h" value={<>{d.tradesLast24h}<span className="muted"> / {state.settings.limits.maxTradesPer24h}</span></>} sub={<Meter value={d.tradesLast24h} max={state.settings.limits.maxTradesPer24h} label="Trades in rolling 24 hours" />} />
            <Stat label="Leverage" value={`${state.settings.position.leverage}x`} sub={`${state.settings.position.quantityEth} ETH = ${state.economics?.contracts ?? '—'} contracts × ${state.spec.contractValue} ETH`} />
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
                  <tr><td className="sec">Entry fee (simulated, paid)</td><td className="num">{usd(pos.entryFee.total, 3)}</td></tr>
                  <tr><td className="sec">Exit fee if closed now</td><td className="num">{waivedNow ? <b className="good">FREE (Scalper Offer)</b> : <>{usd(estExitFee, 3)} <span className="muted">(est.{v.effective ? ', window ended' : ''})</span></>}</td></tr>
                  <tr><td className="sec">Net if closed now</td><td className="num"><Pnl v={unrealGross !== null && estExitFee !== null ? unrealGross - pos.entryFee.total - estExitFee : null} /></td></tr>
                  <tr><td className="sec">Liquidation (est.)</td><td className="num">{num(pos.liquidationPrice)}</td></tr>
                  <tr><td className="sec">Max favourable move</td><td className="num">${num(pos.mfe)} of ${num(pos.targetMoveUsd)} target</td></tr>
                </tbody>
              </table>
              {v.effective && <div style={{ marginTop: 10 }}><ExitFeeClock entryTs={pos.entryTs} windowMin={v.windowMin} now={now} /></div>}
              <div style={{ marginTop: 10 }}>
                {maxHoldMs === null ? (
                  <div className="sec" style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>Open for · no time limit</span><span className="tabnum">{duration(heldMs)}</span></div>
                ) : (
                  <>
                    <div className="sec" style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>Holding time{v.clamped ? ' · time exit' : ''}</span><span className="tabnum">{duration(heldMs)} / {duration(maxHoldMs)}</span></div>
                    <Meter value={heldMs} max={maxHoldMs} label="Holding time used" />
                    {v.clamped && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>The time exit fires at {duration(maxHoldMs)} (configured {state.settings.exits.maxHoldMinutes} min, shortened by the {v.marginSec} s safety margin) so even that close stays inside the {v.windowMin}-min fee-free window.</div>}
                  </>
                )}
              </div>
              {actions.isAdmin && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => actions.run('Close', () => api('POST', 'demo/close'), 'Simulated position closed')}>Close simulated position</button>}
            </>
          ) : (
            <div>
              <p style={{ marginTop: 0 }}>
                <b>No open simulated position.</b> The bot opens a trade only when every strategy condition passes <i>and</i> the risk manager approves — it never trades just to use the daily quota.
              </p>
              <p className="sec" style={{ fontSize: 12 }}>
                {v.effective ? <>A trade closed within {v.windowMin} min pays <b>no closing fee</b>, only the entry fee (Delta Scalper Offer — assumed).</> : <>Brokerage is charged on both the entry and the closing leg. A trade has no time limit: it ends at its target or its stop.</>}
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
        <FeeRealityCard state={state} wide />
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
          {(v.effective || savedSum > 0) && closed.length > 0 && (
            <p className="saved-strip">
              <b>Closing fees saved by the Scalper Offer:</b> <span className="tabnum good">{usd(savedSum, 3)}</span> over these {closed.length} closed trades <span className="muted">(simulated — assumes the offer)</span>
            </p>
          )}
          <TradesTable rows={trades} mode="demo" windowMin={v.assumed ? v.windowMin : null} />
        </Card>
      </div>
    </div>
  );
}
