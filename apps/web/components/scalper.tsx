'use client';

import { useRef, type ReactNode } from 'react';
import { num, pct, signedUsd, usd } from '@/lib/format';
import { DIWALI_NOTE, OFFER_TERMS, clockHm, feeWindow, mmss, scalperView, type ScalperView } from '@/lib/scalper';
import type { BotState, EconRow, LiveScalper } from '@/lib/types';
import { Card, Tag } from './ui';

/**
 * Server clock extrapolated between polls (state.now only changes every ~2 s). The Dashboard re-renders every
 * second, which is what makes countdowns tick.
 */
export function useServerNow(stateNow: number): number {
  const anchor = useRef({ server: stateNow, local: Date.now() });
  if (anchor.current.server !== stateNow) anchor.current = { server: stateNow, local: Date.now() };
  return stateNow + (Date.now() - anchor.current.local);
}

/** "exit fee free until HH:MM (in mm:ss)" - turns into a warning once the window is nearly gone. */
export function ExitFeeClock({ entryTs, windowMin, now }: { entryTs: number; windowMin: number; now: number }) {
  const w = feeWindow(entryTs, windowMin, now);
  if (w.tone === 'crit') {
    return <span className="fee-clock crit"><b aria-hidden>✕</b><span>fee-free window ended {clockHm(w.endsAt)} — a closing fee now applies</span></span>;
  }
  return (
    <span className={`fee-clock ${w.tone}`}>
      <b aria-hidden>{w.tone === 'warn' ? '⚠' : '✓'}</b>
      <span>
        exit fee free until <b className="tabnum">{clockHm(w.endsAt)}</b> (in <span className="tabnum">{mmss(w.remainingMs)}</span>)
        {w.tone === 'warn' && ' — window nearly gone'}
      </span>
    </span>
  );
}

/** Verification status of the offer on the live side. Text never relies on colour alone. */
export function ScalperPill({ v, live }: { v: ScalperView; live?: LiveScalper }) {
  if (!v.assumed) return <span className="pill off">○ Offer switched OFF — full closing fees assumed</span>;
  if (!live) return <span className="pill warn">? Assumed — unverified (server reports no check status)</span>;
  if (live.status === 'confirmed') return <span className="pill good">✓ Confirmed ×{live.confirmedCount}</span>;
  if (live.status === 'not_applied') return <span className="pill crit">✕ NOT APPLIED — closing fees are being charged, using full-fee economics</span>;
  return <span className="pill warn">? Assumed — unverified</span>;
}

/** Offer terms, collapsed by default so the phone view stays short. Also states what is NOT modelled. */
export function OfferTerms() {
  return (
    <details className="terms">
      <summary>Offer terms (as supplied by the operator)</summary>
      <ul>
        {OFFER_TERMS.map((t) => <li key={t}>{t}</li>)}
      </ul>
      <p>{DIWALI_NOTE}</p>
    </details>
  );
}

const sameMove = (a: EconRow, b: EconRow) => Math.abs(a.moveUsd - b.moveUsd) < 1e-9;

/**
 * Fee reality check: what each target is worth after fees, WITH vs WITHOUT the Scalper Offer side by side.
 * Every field the server may not send yet (older server) is optional; the card degrades to a single basis.
 */
export function FeeRealityCard({ state, wide }: { state: BotState; wide?: boolean }) {
  const econ = state.economics;
  const v = scalperView(state, 'demo');
  const liveSc = state.live.scalper;
  // live gates on full fees once the exchange has been seen charging a closing fee
  const liveFullFee = v.assumed && (liveSc?.status === 'not_applied' || econ?.scalper?.liveEffective === false);

  if (!econ) {
    return (
      <Card title="Fee reality check" hint="Waiting for a price">
        <div className="empty">No price yet.</div>
      </Card>
    );
  }

  const withRows = econ.makerTarget;
  const noRows = econ.makerTargetNoWaiver;
  const compare = v.effective && !!noRows && noRows.length === withRows.length;
  // the basis of the main rows is what the settings say; breakevenMoveWaivedUsd is always the waived figure, so only use it while the offer is applied
  const beWith = v.effective ? (econ.breakevenMoveWaivedUsd ?? econ.breakevenMoveMakerExitUsd) : undefined;
  const beWithout = econ.breakevenMoveNoWaiverMakerExitUsd ?? (v.effective ? undefined : econ.breakevenMoveMakerExitUsd);
  const beTakerWithout = 2 * econ.referencePrice * econ.rates.taker * (1 + econ.rates.gst);
  const mid = withRows[Math.floor(withRows.length / 2)];
  const midNo = noRows?.find((r) => mid && sameMove(r, mid));

  let sentence: ReactNode;
  if (!v.assumed) {
    sentence = (
      <>
        The Scalper Offer is <b>switched OFF</b> in settings, so the <b>full closing fee</b> is counted everywhere
        {mid && <>: a ${num(mid.moveUsd, 1)} target nets <b>{signedUsd(mid.netReward, 3)}</b></>}
        {beWithout !== undefined && <> and price must move <b>${num(beWithout)}</b> just to cover fees</>}. If your Delta account has joined the offer, turn it on under Strategy &amp; Risk.
      </>
    );
  } else if (compare && mid && midNo && beWith !== undefined && beWithout !== undefined) {
    sentence = (
      <>
        With the Scalper Offer (<b>assumed</b>) a trade closed inside {v.windowMin} min pays <b>only the entry fee</b>: a ${num(mid.moveUsd, 1)} target nets <b className="good">{signedUsd(mid.netReward, 3)}</b> instead of <b>{signedUsd(midNo.netReward, 3)}</b>, and price only has to move <b>${num(beWith)}</b> to cover fees instead of <b>${num(beWithout)}</b>.
      </>
    );
  } else {
    sentence = (
      <>
        Closing fees are <b>assumed free</b> when a trade is closed inside {v.windowMin} min (Scalper Offer)
        {mid && <>: a ${num(mid.moveUsd, 1)} target nets <b>{signedUsd(mid.netReward, 3)}</b></>}
        {beWith !== undefined && <> and price must move ${num(beWith)} to cover the entry fee</>}. The comparison without the offer is not available from this server version.
      </>
    );
  }

  return (
    <Card
      className={wide ? 'fee-wide' : ''}
      title="Fee reality check"
      hint={`At ETH $${num(econ.referencePrice)} · ${econ.contracts} contracts · stop ≈ $${num(econ.stopUsd)} — recomputed live`}
      right={v.assumed ? <Tag kind="sim">Scalper Offer assumed</Tag> : <Tag kind="warn">Offer OFF · full fees</Tag>}
    >
      <div className="fee-layout">
        <div>
          <p className="fee-sentence">{sentence}</p>
          {liveFullFee && (
            <div className="banner crit" style={{ marginTop: 8 }}>
              <span className="icon">✕</span>
              <div>Live check: the exchange charged closing fees on eligible closes, so <b>Live</b> now uses full-fee economics (the “without” columns). Demo still assumes the offer.</div>
            </div>
          )}
        </div>
        <div>
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                {compare ? (
                  <>
                    <tr>
                      <th rowSpan={2}>Target move</th>
                      <th colSpan={2} className="grp with">With offer (assumed)</th>
                      <th colSpan={2} className="grp without">Without offer</th>
                    </tr>
                    <tr>
                      <th className="num with">Net</th><th className="num with">Win rate needed</th>
                      <th className="num without">Net</th><th className="num without">Win rate needed</th>
                    </tr>
                  </>
                ) : (
                  <tr><th>Target move</th><th className="num">Fees</th><th className="num">Net</th><th className="num">Win rate needed</th></tr>
                )}
              </thead>
              <tbody>
                {withRows.map((r, i) => {
                  const n = compare ? noRows![i] : undefined;
                  return (
                    <tr key={r.moveUsd}>
                      <td>${num(r.moveUsd, 1)}<div className="sub">gross {usd(r.grossReward)}</div></td>
                      {!compare && <td className="num">{usd(r.fees, 3)}</td>}
                      <td className={`num ${compare ? 'with' : ''}`}><b className={r.netReward > 0 ? 'good' : 'bad'}>{signedUsd(r.netReward, 3)}</b>{compare && <div className="sub">fees {usd(r.fees, 3)}</div>}</td>
                      <td className={`num ${compare ? 'with' : ''}`}>{pct(r.requiredWinRate, 0)}</td>
                      {n && <td className="num without"><b className={n.netReward > 0 ? 'good' : 'bad'}>{signedUsd(n.netReward, 3)}</b><div className="sub">fees {usd(n.fees, 3)}</div></td>}
                      {n && <td className="num without">{pct(n.requiredWinRate, 0)}</td>}
                    </tr>
                  );
                })}
                {compare && beWith !== undefined && beWithout !== undefined ? (
                  <tr className="be-row">
                    <td>Break-even<div className="sub">move needed</div></td>
                    <td colSpan={2} className="num with"><b>${num(beWith)}</b></td>
                    <td colSpan={2} className="num without"><b>${num(beWithout)}</b></td>
                  </tr>
                ) : (
                  (beWith ?? beWithout) !== undefined && (
                    <tr className="be-row"><td>Break-even<div className="sub">move needed</div></td><td colSpan={3} className="num"><b>${num((beWith ?? beWithout)!)}</b></td></tr>
                  )
                )}
              </tbody>
            </table>
          </div>
          <p className="sec fee-foot">
            Resting-limit (maker) take-profit. Taker {pct(econ.rates.taker, 3)} / maker {pct(econ.rates.maker, 3)} + GST {pct(econ.rates.gst, 0)}; the opening fee is a taker fee.
            {` ${v.effective ? 'Without the offer a' : 'A'} market (taker) exit would need ≈ $${num(beTakerWithout)}.`} “Win rate needed” is the break-even rate for that target against a ${num(econ.stopUsd)} stop; the bot also blocks trades below your minimum net reward:risk.
            {!econ.verifiedSpec && ' Fee rates shown are documented fallbacks, not read from the exchange.'}
          </p>
        </div>
      </div>
      <p className="muted fee-foot" style={{ marginBottom: 0 }}>
        {v.assumed ? (
          <><b>Assumption:</b> Demo, backtests and these pre-trade numbers assume the offer because it cannot be read through the Delta API. Live P&amp;L always uses the commission the exchange reports.</>
        ) : (
          <><b>Not assumed:</b> Demo, backtests and these numbers count the full closing fee. Live P&amp;L always uses the commission the exchange reports.</>
        )}
      </p>
      <OfferTerms />
    </Card>
  );
}
