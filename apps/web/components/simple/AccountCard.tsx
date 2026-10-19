'use client';

import { memo } from 'react';
import { inrWhole, num, signedInr, signedUsd, usd } from '@/lib/format';
import { goalInrOf, goalProgress, resolveToday, toneOf, tradesLimitOf } from '@/lib/simple';
import type { BotState, TradeRow } from '@/lib/types';
import { Tag } from '../ui';
import { CardShell, Skeleton } from './bits';

/**
 * "My simulated account": balance, equity, today's result, the goal bar and a few plain counters. Everything here is the
 * virtual demo account; no real money. Reads `demo.today` from the backend and, for an older backend without it, works
 * the same numbers out from the trade list.
 */
function AccountCardInner({ state, trades }: { state: BotState; trades: TradeRow[] | null }) {
  const d = state.demo;
  if (!d) {
    return (
      <CardShell title="My simulated account" area="account" right={<Tag kind="sim">Simulated</Tag>}>
        <div className="sv-skel-stack" role="status" aria-label="Loading the simulated account">
          <Skeleton h={34} w="55%" />
          <Skeleton h={20} w="80%" />
          <Skeleton h={64} />
        </div>
      </CardShell>
    );
  }

  const today = resolveToday(state, trades);
  const rate = d.usdInrRate;
  const goal = today?.goalInr ?? goalInrOf(state);
  const limit = today?.tradesLimit ?? tradesLimitOf(state);
  const netInr = today?.netPnlInr ?? 0;
  const netUsd = today?.netPnlUsd ?? 0;
  const tone = toneOf(Math.round(netInr * 100) / 100);
  const progress = goalProgress(netInr, goal);
  const reached = goal > 0 && netInr >= goal;
  const brokerage = state.economics?.roundTrip?.totalFeeUsd;
  const last24 = d.tradesLast24h;

  return (
    <CardShell title="My simulated account" hint="Virtual money, real Delta prices" area="account" right={<Tag kind="sim">Simulated</Tag>}>
      <div className="sv-acct-top">
        <div>
          <div className="sv-label">Balance</div>
          <div className="sv-fig tabnum">{usd(d.balanceUsd)}</div>
          <div className="sv-sub tabnum">{inrWhole(d.balanceUsd * rate)}</div>
        </div>
        <div>
          <div className="sv-label">Equity <span className="sv-dim">(with the open trade)</span></div>
          <div className="sv-fig tabnum">{usd(d.equityUsd)}</div>
          <div className="sv-sub tabnum">{inrWhole(d.equityUsd * rate)}</div>
        </div>
      </div>

      <div className="sv-today" aria-live="off">
        <div className="sv-label">Today&apos;s result <span className="sv-dim">(after brokerage)</span></div>
        {today ? (
          <div className="sv-today-fig">
            <span className={`sv-big tabnum ${tone === 'win' ? 'up' : tone === 'loss' ? 'down' : ''}`}>{signedUsd(netUsd)}</span>
            <span className={`sv-mid tabnum ${tone === 'win' ? 'up' : tone === 'loss' ? 'down' : ''}`}>{signedInr(netInr)}</span>
          </div>
        ) : (
          <Skeleton h={34} w="50%" />
        )}
      </div>

      <div className="sv-goal">
        <div className="sv-goal-row">
          <span>
            Today <b className="tabnum">{inrWhole(netInr)}</b> of <b className="tabnum">{inrWhole(goal)}</b> goal
          </span>
          {reached && <span className="sv-goal-hit">Goal reached</span>}
        </div>
        <div className="sv-bar" role="progressbar" aria-label="Progress towards today's goal" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.max(0, Math.min(goal, Math.round(netInr)))}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="sv-note">A goal, not a promise. The algo never trades just to reach it.</div>
      </div>

      <div className="sv-tiles">
        <div className="sv-tile">
          <div className="sv-label">Trades today</div>
          <div className="sv-val tabnum">{today ? `${today.trades} of ${limit}` : '—'}</div>
          {last24 > (today?.trades ?? 0) && <div className="sv-sub tabnum">{last24} of {limit} in the last 24 h</div>}
        </div>
        <div className="sv-tile">
          <div className="sv-label">Wins · Losses</div>
          <div className="sv-val tabnum">
            {today ? (
              <>
                <span className={today.wins > 0 ? 'up' : ''}>{today.wins}</span>
                <span className="sv-dim"> · </span>
                <span className={today.losses > 0 ? 'down' : ''}>{today.losses}</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <div className="sv-sub">today</div>
        </div>
        <div className="sv-tile">
          <div className="sv-label">Brokerage paid</div>
          <div className="sv-val tabnum">{today ? usd(today.feesUsd) : '—'}</div>
          <div className="sv-sub">today</div>
        </div>
      </div>

      {brokerage !== undefined && Number.isFinite(brokerage) && brokerage > 0 && (
        <p className="sv-note sv-brokerage">
          Brokerage about <b className="tabnum">USD {num(brokerage)}</b> per trade (entry + exit).
        </p>
      )}
    </CardShell>
  );
}

export const AccountCard = memo(AccountCardInner);
