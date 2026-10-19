'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dayTime, duration, inrWhole, num, pct, usd } from '@/lib/format';
import { exitReasonText, toneOf } from '@/lib/simple';
import type { Analytics, BotState, TradeRow } from '@/lib/types';
import { Tag } from '../ui';
import { CardShell, Money, Rupees, SideBadge, Skeleton } from './bits';

const PAGE = 20;

/**
 * Everything the algo has done on the simulated account: totals on top, then every finished trade, newest first, a page
 * at a time. Totals come from the analytics endpoint (the whole current simulated account), the list from /api/trades.
 */
export function HistoryView({ state, onBack }: { state: BotState; onBack: () => void }) {
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState(false);
  const [sum, setSum] = useState<Analytics['metrics'] | null>(null);
  const [sumErr, setSumErr] = useState(false);

  const loadPage = useCallback(async (p: number) => {
    try {
      const r = await api<{ trades: TradeRow[] }>('GET', `trades?mode=demo&limit=${PAGE}&offset=${p * PAGE}`);
      setRows(r.trades.filter((t) => t.status === 'closed'));
      setMore(r.trades.length === PAGE);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    void loadPage(page);
    if (page !== 0) return;
    // the newest page keeps itself fresh while it is on screen
    const t = setInterval(() => {
      if (!document.hidden) void loadPage(0);
    }, 8000);
    return () => clearInterval(t);
  }, [page, loadPage]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Analytics>('GET', 'analytics?mode=demo')
        .then((r) => {
          if (!alive) return;
          setSum(r.metrics);
          setSumErr(false);
        })
        .catch(() => alive && setSumErr(true));
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const rate = state.demo?.usdInrRate ?? state.settings.execution.usdInrRate;
  const net = sum ? sum.netPnl : null;
  const netInr = sum ? (sum.netPnlInr || sum.netPnl * rate) : null;

  return (
    <div className="sv-history">
      <div className="sv-page-head">
        <button className="sv-back" onClick={onBack}>← Back</button>
        <h1 className="sv-page-title">History</h1>
        <Tag kind="sim">Simulated</Tag>
      </div>

      <CardShell title="Everything so far" hint="All finished trades of the simulated account" label="Totals">
        {!sum ? (
          sumErr ? (
            <div className="sv-empty">Could not load the totals. Trying again...</div>
          ) : (
            <div className="sv-tiles four" role="status" aria-label="Loading totals">
              <Skeleton h={58} /><Skeleton h={58} /><Skeleton h={58} /><Skeleton h={58} />
            </div>
          )
        ) : (
          <>
            <div className="sv-tiles four">
              <div className="sv-tile">
                <div className="sv-label">Trades</div>
                <div className="sv-val tabnum">{sum.totalTrades}</div>
              </div>
              <div className="sv-tile">
                <div className="sv-label">Wins · Losses</div>
                <div className="sv-val tabnum"><span className={sum.wins > 0 ? 'up' : ''}>{sum.wins}</span><span className="sv-dim"> · </span><span className={sum.losses > 0 ? 'down' : ''}>{sum.losses}</span></div>
              </div>
              <div className="sv-tile">
                <div className="sv-label">Net result <span className="sv-dim">(after brokerage)</span></div>
                <div className="sv-val tabnum"><Money usd={net} /></div>
                <div className="sv-sub tabnum"><Rupees inr={netInr} /></div>
              </div>
              <div className="sv-tile">
                <div className="sv-label">Brokerage paid</div>
                <div className="sv-val tabnum">{usd(sum.fees)}</div>
                <div className="sv-sub tabnum">{inrWhole(sum.fees * rate)}</div>
              </div>
            </div>
            {sum.totalTrades > 0 && (
              <p className="sv-note">
                Share of winning trades so far: <b className="tabnum">{pct(sum.winRate, 0)}</b> of {sum.totalTrades}.{' '}
                {sum.smallSample ? 'That is too few trades to say anything about the future. ' : ''}These are simulated results, not a promise.
              </p>
            )}
          </>
        )}
      </CardShell>

      <CardShell title="All trades" hint="Newest first" label="All trades">
        {rows === null ? (
          err ? (
            <div className="sv-empty">
              Could not load the trades. <button className="sv-link" onClick={() => void loadPage(page)}>Try again</button>
            </div>
          ) : (
            <div className="sv-skel-stack" role="status" aria-label="Loading trades">
              <Skeleton h={52} /><Skeleton h={52} /><Skeleton h={52} /><Skeleton h={52} />
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="sv-empty">{page === 0 ? 'No finished trades yet. When the algo closes a trade it will appear here.' : 'No more trades.'}</div>
        ) : (
          <ul className="sv-trades full">
            {rows.map((t) => {
              const tone = toneOf(t.netPnl !== null ? Math.round(t.netPnl * 100) / 100 : null);
              return (
                <li key={t.id} className={`sv-trade ${tone}`}>
                  <div className="sv-h-when">
                    <div className="tabnum">{dayTime(t.exitTs)}</div>
                    <div className="sv-sub">lasted {duration(t.holdMs)}</div>
                  </div>
                  <div className="sv-h-what">
                    <div className="sv-trade-line"><SideBadge side={t.side} small /><span className="sv-trade-why">{exitReasonText(t.exitReason)}</span></div>
                    <div className="sv-sub tabnum">{num(t.entryPrice)} → {num(t.exitPrice)}</div>
                  </div>
                  <div className="sv-h-fee sv-sub tabnum">
                    <span className="sv-dim">Brokerage</span> {t.fees === null ? '—' : usd(t.fees)}
                  </div>
                  <div className="sv-trade-res">
                    <Money usd={t.netPnl} tone={tone} />
                    <Rupees inr={t.netPnlInr} tone={tone} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {(page > 0 || more) && (
          <div className="sv-pager">
            <button className="sv-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Newer</button>
            <span className="sv-dim">Page {page + 1}</span>
            <button className="sv-btn" disabled={!more} onClick={() => setPage((p) => p + 1)}>Older →</button>
          </div>
        )}
      </CardShell>
      <span className="sr-only" aria-live="polite">{rows ? `${rows.length} trades shown` : ''}</span>
    </div>
  );
}

