'use client';

import { useMemo } from 'react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useDeltaMarket } from '@/lib/market/useDeltaMarket';
import { positionLines, seedCandlesFromSpark } from '@/lib/simple';
import type { BotState, Me } from '@/lib/types';
import { OrderFlow, PriceChart, PriceHero } from '../market';
import { ActivityCard } from './ActivityCard';
import { AccountCard } from './AccountCard';
import { CardShell, useNarrow } from './bits';
import { SimpleHeader, type SimplePage } from './Header';
import { HistoryView } from './HistoryView';
import { useDemoTrades } from './useDemoTrades';
import type { Actions } from '../Dashboard';

/**
 * The default dashboard. Layout on a wide screen:
 *   [ price + live chart ] [ order flow ]
 *   [ my simulated account ] [ what the algo is doing ]
 * and on a phone: price + chart, order flow, algo activity, account.
 *
 * The price, the chart and the order flow come from Delta's public market feed read straight by the browser (see
 * lib/market); everything about the account and the algo comes from the backend snapshot, polled by Dashboard.
 */
export default function SimpleView({
  state,
  me,
  actions,
  lost,
  page,
  setPage,
  onDeveloper,
  onLogout,
  onToggleTheme,
}: {
  state: BotState;
  me: Me | null;
  actions: Actions;
  lost: string | null;
  page: SimplePage;
  setPage: (p: SimplePage) => void;
  onDeveloper: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
}) {
  const symbol = state.spec?.symbol || state.settings?.instrument?.symbol || 'ETHUSD';
  // An older backend has no state.market: its quote and the 1-minute closes in state.spark seed the chart instead.
  const seedQuote = state.market?.quote ?? state.feed.quote ?? null;
  const backendCandles = state.market?.candles;
  const seedCandles = useMemo(
    () => (backendCandles && backendCandles.length > 0 ? backendCandles : seedCandlesFromSpark(state.spark, state.now)),
    [backendCandles, state.spark, state.now],
  );

  // Dev data from the backend's synthetic generator is not Delta's price: never mix it with the real public feed.
  const market = useDeltaMarket({
    symbol,
    seedCandles,
    seedQuote,
    contractValue: state.spec?.contractValue,
    levels: 10,
    enabled: !state.feed.synthetic,
  });

  const pos = state.demo?.openPosition ?? null;
  const lines = useMemo(
    () => positionLines(pos ? { side: pos.side, entryPrice: pos.entryPrice, stopPrice: pos.stopPrice, targetPrice: pos.targetPrice } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pos?.id, pos?.side, pos?.entryPrice, pos?.stopPrice, pos?.targetPrice],
  );

  const refreshKey = `${pos?.id ?? ''}|${state.demo?.today?.trades ?? ''}|${state.demo?.tradesLast24h ?? ''}`;
  const { rows, failed } = useDemoTrades(40, 6000, refreshKey);
  const narrow = useNarrow(700);

  return (
    <div className="sv">
      <SimpleHeader
        state={state}
        me={me}
        isAdmin={actions.isAdmin}
        page={page}
        onPage={setPage}
        onDeveloper={onDeveloper}
        onKill={actions.confirmKill}
        onLogout={onLogout}
        onToggleTheme={onToggleTheme}
      />

      <Banners state={state} actions={actions} lost={lost} />

      {page === 'history' ? (
        <HistoryView state={state} onBack={() => setPage('overview')} />
      ) : (
        <main className="sv-grid">
          <CardShell className="sv-price" area="price" label={`${symbol} price`}>
            <PriceHero market={market} symbol={symbol} />
            <div className="sv-chart">
              <PriceChart market={market} positionLines={lines} height={narrow ? 210 : 280} />
            </div>
          </CardShell>

          <CardShell className="sv-flow" area="flow" label="Order flow">
            <OrderFlow market={market} levels={10} positionPrice={pos?.entryPrice ?? null} />
          </CardShell>

          <AccountCard state={state} trades={rows} />

          <ActivityCard state={state} market={market} trades={rows} failed={failed} onHistory={() => setPage('history')} />
        </main>
      )}

      <p className="sv-foot">
        Everything here is a simulation with a virtual balance; no real orders are placed. The daily goal is a goal, not a promise, and trading can lose money.
      </p>
    </div>
  );
}

/** Only the notices an ordinary user must see. Technical ones live in the developer view. */
function Banners({ state, actions, lost }: { state: BotState; actions: Actions; lost: string | null }) {
  return (
    <div className="sv-banners">
      {lost && (
        <div className="sv-banner warn" role="alert">
          <b>Reconnecting...</b> The dashboard cannot reach the server right now. The numbers below may be a little old (last update {ago(state.now)}).
        </div>
      )}
      {state.killSwitch && (
        <div className="sv-banner crit" role="alert">
          <div>
            <b>Emergency stop is on.</b> The algo will not open any new trade.
          </div>
          {actions.isAdmin && <button className="sv-btn" onClick={actions.confirmKill}>Release</button>}
        </div>
      )}
      {state.feed.synthetic && (
        <div className="sv-banner warn" role="alert">
          <b>Test data.</b> These prices are generated for development, not from Delta Exchange.
        </div>
      )}
      {!state.workerActive && !state.killSwitch && (
        <div className="sv-banner warn" role="alert">
          <b>The algo is not running on this server right now.</b> Open positions are not being watched until it is back.
        </div>
      )}
      {state.attention.length > 0 && (
        <div className="sv-banner crit" role="alert">
          <div>
            <b>Needs your attention</b>
            <ul>{state.attention.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
          {actions.isAdmin && (
            <button className="sv-btn" onClick={() => actions.run('Clear', () => api('POST', 'attention/clear'), 'Marked as seen')}>Got it</button>
          )}
        </div>
      )}
    </div>
  );
}
