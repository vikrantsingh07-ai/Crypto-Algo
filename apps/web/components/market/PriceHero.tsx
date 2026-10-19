'use client';
import type { MarketState, MarketStatus } from '../../lib/market/types';
import { fmtAge, fmtPct, fmtPrice, prettySymbol } from '../../lib/market/format';
import { useChangeFlash, useNow, usePrefersReducedMotion } from './hooks';
import s from './market.module.css';

const STATUS_TEXT: Record<MarketStatus, string> = {
  live: 'Live',
  connecting: 'Connecting',
  fallback: 'Delayed',
  down: 'Reconnecting',
};

const STATUS_HELP: Record<MarketStatus, string> = {
  live: 'Prices come straight from Delta Exchange.',
  connecting: 'Opening the live price feed. The price shown is from our server for now.',
  fallback: 'The direct feed is reconnecting. This price comes from our server and can be a few seconds behind.',
  down: 'No price feed right now. Trying again automatically.',
};

/** Small status pill: "Live" / "Delayed" / "Reconnecting" with a plain-language tooltip. */
export function StatusPill({ status, updatedAt }: { status: MarketStatus; updatedAt: number }) {
  const now = useNow(status !== 'live' && updatedAt > 0);
  const age = now > 0 && updatedAt > 0 ? now - updatedAt : null;
  return (
    <span className={s.status} data-state={status} title={STATUS_HELP[status]}>
      <span className={s.dot} aria-hidden="true" />
      <span aria-hidden="true">{STATUS_TEXT[status]}</span>
      {age !== null && age > 3000 ? <span className={s.statusAge}>· updated {fmtAge(age)} ago</span> : null}
      <span className="sr-only" role="status">
        {STATUS_TEXT[status]}. {STATUS_HELP[status]}
      </span>
    </span>
  );
}

/** Big live price with up/down flash, change %, bid / ask and a connection pill. */
export function PriceHero({ market, symbol }: { market: MarketState; symbol?: string }) {
  const reduced = usePrefersReducedMotion();
  const priceRef = useChangeFlash<HTMLSpanElement>(market.price, s.flashUp, s.flashDown, reduced);
  const { price, bid, ask, changePct } = market;
  const spread = bid !== null && ask !== null && ask >= bid ? ask - bid : null;
  const dir = changePct === null || Math.abs(changePct) < 0.005 ? 'flat' : changePct > 0 ? 'up' : 'down';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const name = prettySymbol(symbol ?? market.symbol);

  return (
    <div className={s.root}>
      <div className={s.heroTop}>
        <div className={s.heroName}>
          {name}
          <span className={s.heroKind}>Perpetual</span>
        </div>
        <StatusPill status={market.status} updatedAt={market.updatedAt} />
      </div>
      <div className={s.heroRow}>
        <span ref={priceRef} className={s.heroPrice}>
          {price === null ? <span className={s.skeleton} style={{ display: 'inline-block', width: '5.2ch', height: '0.9em', borderRadius: 8, verticalAlign: '-0.08em' }} /> : fmtPrice(price)}
        </span>
        {changePct !== null ? (
          <span className={s.heroChange} data-dir={dir}>
            {arrow ? <span aria-hidden="true">{arrow} </span> : null}
            {fmtPct(changePct)}
            {market.changeLabel ? <span className={s.heroChangeLabel}>{market.changeLabel}</span> : null}
          </span>
        ) : null}
      </div>
      <div className={s.heroQuote}>
        <span>
          Bid <b>{fmtPrice(bid)}</b>
        </span>
        <span>
          Ask <b>{fmtPrice(ask)}</b>
        </span>
        {spread !== null ? (
          <span>
            Spread <b>{fmtPrice(spread)}</b>
          </span>
        ) : null}
      </div>
    </div>
  );
}
