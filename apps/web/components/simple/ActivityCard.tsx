'use client';

import { memo } from 'react';
import { dayTime, duration, num, usd } from '@/lib/format';
import type { MarketState } from '@/lib/market/types';
import { exitReasonText, exitSidePrice, openPnlUsd, toneOf, trackPosition, waitingNote } from '@/lib/simple';
import type { BotState, TradeRow } from '@/lib/types';
import { useServerNow } from '../scalper';
import { CardShell, Money, Rupees, SideBadge, Skeleton, useTicker } from './bits';

const pctText = (v: number) => `${Math.round(v)}%`;

/** The open simulated trade: side, live profit/loss, where the price is between stop and target, and the two waiting orders. */
function RunningTrade({ state, market }: { state: BotState; market: MarketState }) {
  useTicker(1000);
  const d = state.demo!;
  const pos = d.openPosition!;
  const now = useServerNow(state.now);
  const fallbackLast = state.market?.quote?.last ?? state.feed.quote?.last ?? null;
  const price = exitSidePrice(pos.side, { bid: market.bid, ask: market.ask, price: market.price ?? fallbackLast });
  const pnl = openPnlUsd(pos.side, pos.entryPrice, pos.qtyEth, price);
  const track = trackPosition({ side: pos.side, entry: pos.entryPrice, stop: pos.stopPrice, target: pos.targetPrice, price });
  const tone = toneOf(pnl === null ? null : Math.round(pnl * 100) / 100);
  const exitFee = state.economics?.roundTrip?.exitFeeUsd;
  const open = Math.max(0, now - pos.entryTs);
  const breakeven = pos.breakevenArmed;

  return (
    <div className="sv-run">
      <div className="sv-run-top">
        <SideBadge side={pos.side} />
        <span className="sv-run-qty tabnum">{num(pos.qtyEth, 2)} ETH</span>
        <span className="sv-spacer" />
        <span className="sv-dim tabnum" title="There is no time limit: the trade ends at its take profit or its stop loss">Open for {duration(open)}</span>
      </div>

      <div className="sv-run-pnl">
        <div className="sv-label">Profit / loss right now</div>
        <div className="sv-today-fig">
          <span className="sv-big"><Money usd={pnl} tone={tone} /></span>
          <span className="sv-mid"><Rupees inr={pnl === null ? null : pnl * d.usdInrRate} tone={tone} /></span>
        </div>
        <div className="sv-note">
          Price move only. Brokerage{exitFee ? <> (about <span className="tabnum">{usd(exitFee)}</span> to close)</> : null} is charged when the trade closes.
        </div>
      </div>

      {track && (
        <div className="sv-track">
          <div className="sv-track-cap" aria-live="off">
            {track.inProfit ? `${pctText(track.pctToTarget)} of the way to take profit` : track.pctToStop > 0 ? `${pctText(track.pctToStop)} of the way to the stop loss` : 'Price is at the entry'}
          </div>
          <div className="sv-track-bar" role="img" aria-label={`Price position between stop loss ${num(pos.stopPrice)} and take profit ${num(pos.targetPrice)}`}>
            <span className="sv-track-clip">
              <span className="sv-track-zone down" style={{ left: 0, width: `${track.entryX * 100}%` }} />
              <span className="sv-track-zone up" style={{ left: `${track.entryX * 100}%`, width: `${(1 - track.entryX) * 100}%` }} />
              <span
                className={`sv-track-fill ${track.inProfit ? 'up' : 'down'}`}
                style={{ left: `${Math.min(track.entryX, track.priceX) * 100}%`, width: `${Math.abs(track.priceX - track.entryX) * 100}%` }}
              />
            </span>
            <i className="sv-track-entry" style={{ left: `${track.entryX * 100}%` }} title="Entry" />
            <i className={`sv-track-now ${track.inProfit ? 'up' : track.pctToStop > 0 ? 'down' : ''}`} style={{ left: `${track.priceX * 100}%` }} title="Price now" />
          </div>
          <div className="sv-track-ends">
            <span className="down">
              <span className="sv-dim">Stop loss</span>
              <b className="tabnum">{num(pos.stopPrice)}</b>
            </span>
            <span className="up">
              <span className="sv-dim">Take profit</span>
              <b className="tabnum">{num(pos.targetPrice)}</b>
            </span>
          </div>
        </div>
      )}

      <dl className="sv-facts">
        <div><dt>Entry</dt><dd className="tabnum">{num(pos.entryPrice)}</dd></div>
        <div><dt>Price now</dt><dd className="tabnum">{price === null ? '—' : num(price)}</dd></div>
      </dl>

      <div className="sv-label" style={{ marginTop: 12 }}>Waiting orders</div>
      <ul className="sv-orders">
        <li><i className="sv-dot up" aria-hidden /> Take profit at <b className="tabnum">{num(pos.targetPrice)}</b></li>
        <li><i className="sv-dot down" aria-hidden /> Stop loss at <b className="tabnum">{num(pos.stopPrice)}</b>{breakeven && <span className="sv-dim"> (moved to break-even)</span>}</li>
      </ul>
    </div>
  );
}

function Waiting({ state }: { state: BotState }) {
  const note = waitingNote(state);
  return (
    <div className="sv-wait">
      <span className="sv-wait-pulse" aria-hidden />
      <div>
        <div className="sv-wait-title">Waiting for a good setup</div>
        <p className="sv-wait-text">The algo only trades when conditions pass its safety checks.</p>
        {note && <p className="sv-wait-why">{note}</p>}
      </div>
    </div>
  );
}

/** Why a finished trade ended, one calm line per trade, colour coded by its result. */
function RecentTradesInner({ rows, failed, onAll }: { rows: TradeRow[] | null; failed: boolean; onAll?: () => void }) {
  const closed = (rows ?? []).filter((t) => t.status === 'closed').slice(0, 8);
  return (
    <div className="sv-recent">
      <div className="sv-sechead">
        <h3 className="sv-h3">Recent trades</h3>
        {onAll && <button className="sv-link" onClick={onAll}>See all</button>}
      </div>
      {rows === null ? (
        failed ? (
          <div className="sv-empty">Could not load the trades. Trying again...</div>
        ) : (
          <div className="sv-skel-stack" role="status" aria-label="Loading recent trades">
            <Skeleton h={48} />
            <Skeleton h={48} />
            <Skeleton h={48} />
          </div>
        )
      ) : closed.length === 0 ? (
        <div className="sv-empty">No finished trades yet. When the algo closes a trade it will appear here.</div>
      ) : (
        <ul className="sv-trades">
          {closed.map((t) => {
            const tone = toneOf(t.netPnl !== null ? Math.round(t.netPnl * 100) / 100 : null);
            return (
              <li key={t.id} className={`sv-trade ${tone}`}>
                <div className="sv-trade-main">
                  <div className="sv-trade-line">
                    <SideBadge side={t.side} small />
                    <span className="sv-trade-why">{exitReasonText(t.exitReason)}</span>
                  </div>
                  <div className="sv-sub">
                    {dayTime(t.exitTs)} · lasted {duration(t.holdMs)} · {num(t.entryPrice)} → {num(t.exitPrice)}
                  </div>
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
    </div>
  );
}
export const RecentTrades = memo(RecentTradesInner);

export function ActivityCard({ state, market, trades, failed, onHistory }: { state: BotState; market: MarketState; trades: TradeRow[] | null; failed: boolean; onHistory: () => void }) {
  const d = state.demo;
  const open = d?.openPosition ?? null;
  return (
    <CardShell title="What the algo is doing" hint="Simulated trades, no real money" area="activity">
      <div className="sv-sechead">
        <h3 className="sv-h3">Running now</h3>
        {open && <span className="sv-live-pill"><i className="sv-dot up" aria-hidden /> In a trade</span>}
      </div>
      {!d ? (
        <div className="sv-skel-stack" role="status" aria-label="Loading">
          <Skeleton h={28} w="40%" />
          <Skeleton h={60} />
        </div>
      ) : open ? (
        <RunningTrade state={state} market={market} />
      ) : (
        <Waiting state={state} />
      )}
      <RecentTrades rows={trades} failed={failed} onAll={onHistory} />
    </CardShell>
  );
}
