'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { num, pct, usd } from '@/lib/format';
import type { BotState } from '@/lib/types';
import { Modal, Tag } from './ui';

interface Check {
  id: string;
  title: string;
  ok: boolean;
  blocker: boolean;
  detail: string;
}
interface Preflight {
  ok: boolean;
  checks: Check[];
  summary: any;
  token: string | null;
  expiresAt: number;
  requiredPhrase: string;
  acknowledgements: string[];
}

/**
 * Live activation: 1) automated safety checks  2) review & risk acknowledgements
 * 3) password re-entry + typed phrase  4) done. Selecting "Live" never places an order by itself.
 */
export default function ActivationWizard({ state, onClose, onDone }: { state: BotState; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acks, setAcks] = useState<boolean[]>([]);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [failed, setFailed] = useState<Check[] | null>(null);

  async function runChecks() {
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      const r = await api<Preflight>('POST', 'live/preflight');
      setPre(r);
      setAcks(r.acknowledgements.map(() => false));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!pre?.token) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', 'live/activate', { token: pre.token, phrase, acknowledged: acks.every(Boolean), password });
      onDone();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        if (e.body?.failedChecks?.length) setFailed(e.body.failedChecks);
      } else setError((e as Error).message);
      setBusy(false);
    }
  }

  const s = pre?.summary;
  const blockers = pre?.checks.filter((c) => c.blocker && !c.ok) ?? [];
  const canStep3 = !!pre?.ok && acks.length > 0 && acks.every(Boolean);

  return (
    <Modal
      wide
      title={`Enable Live Trading ${state.deployment.realMoney ? '(REAL FUNDS)' : '(TESTNET)'}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel — stay in Demo</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step === 1 && <button className="btn primary" disabled={busy} onClick={runChecks}>{pre ? 'Re-run checks' : 'Run safety checks'}</button>}
            {step === 1 && pre?.ok && <button className="btn primary" onClick={() => setStep(2)}>Review →</button>}
            {step === 2 && <button className="btn" onClick={() => setStep(1)}>← Back</button>}
            {step === 2 && <button className="btn primary" disabled={!canStep3} onClick={() => setStep(3)}>Continue →</button>}
            {step === 3 && <button className="btn" onClick={() => setStep(2)}>← Back</button>}
            {step === 3 && (
              <button className="btn danger" disabled={busy || phrase !== pre?.requiredPhrase || !password} onClick={activate}>
                {busy ? 'Activating…' : 'ACTIVATE LIVE TRADING'}
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="stepper" aria-label={`Step ${step} of 3`}>
        <span className={step >= 1 ? 'on' : ''} /><span className={step >= 2 ? 'on' : ''} /><span className={step >= 3 ? 'on' : ''} />
      </div>
      <p className="sec" style={{ marginTop: 0 }}>
        Nothing is traded until you finish all three steps. Currently: <b>DEMO MODE — LIVE TRADING DISABLED</b>.
        {!state.deployment.realMoney && ' This server points at a sandbox (no real funds).'}
      </p>

      {error && <div className="banner crit" role="alert"><span className="icon">!</span><div>{error}</div></div>}

      {step === 1 && (
        <div>
          <h3>1 · Safety checks</h3>
          <p className="sec">Verifies the exchange connection and API permissions, the ETH contract, leverage, quantity, balance and margin, risk limits, position/order synchronisation and market-data health.</p>
          {!pre && <div className="muted">Press “Run safety checks”. This reads your account but places no order and changes no settings.</div>}
          {pre && (
            <ul className="checks" style={{ marginTop: 8 }}>
              {pre.checks.map((c) => (
                <li key={c.id}>
                  <span className={`mark ${c.ok ? 'ok' : c.blocker ? 'no' : ''}`}>{c.ok ? '✓' : c.blocker ? '✕' : 'i'}</span>
                  <span><b>{c.title}</b> <span className="sec">— {c.detail}</span></span>
                </li>
              ))}
            </ul>
          )}
          {pre && !pre.ok && (
            <div className="banner crit" style={{ marginTop: 12 }}>
              <span className="icon">✕</span>
              <div><b>Live Trading stays disabled.</b> Fix {blockers.length} blocking item{blockers.length === 1 ? '' : 's'} above, then re-run the checks.</div>
            </div>
          )}
          {pre?.ok && <div className="banner info" style={{ marginTop: 12 }}><span className="icon">✓</span><div>All blocking checks passed. Continue to review the parameters.</div></div>}
        </div>
      )}

      {step === 2 && s && (
        <div>
          <h3>2 · Review & acknowledge</h3>
          <table className="kv">
            <tbody>
              <tr><td className="sec">Environment</td><td className="num">{s.environment} {s.realMoney ? <Tag kind="real">real funds</Tag> : <Tag>sandbox</Tag>}</td></tr>
              <tr><td className="sec">Contract</td><td className="num">{s.symbol} (product {s.productId}) · {s.contractValueEth} ETH per contract</td></tr>
              <tr><td className="sec">Position</td><td className="num">{s.quantityEth} ETH = {s.contracts} contracts · {s.leverage}x (max {s.maxLeverage}x)</td></tr>
              <tr><td className="sec">Est. margin per trade</td><td className="num">{usd(s.estimatedMarginUsd)} of {usd(s.availableBalanceUsd)} available</td></tr>
              <tr><td className="sec">Target · stop (ETH price move)</td><td className="num">${s.targetRangeUsd[0]}–${s.targetRangeUsd[1]} · up to ${s.stopLossMaxUsd}</td></tr>
              <tr><td className="sec">Max hold · trades/24h</td><td className="num">{s.maxHoldMinutes} min · {s.maxTradesPer24h}</td></tr>
              <tr><td className="sec">Per-trade risk · daily loss · max drawdown</td><td className="num">{usd(s.perTradeRiskUsd)} · {usd(s.dailyLossLimitUsd)} · {s.maxDrawdownPct}%</td></tr>
              <tr><td className="sec">Fee break-even move</td><td className="num">${num(s.breakevenMoveUsd)} per ETH — fees take ≈ {pct(s.feeFractionOfTarget, 0)} of a mid-size target</td></tr>
              <tr><td className="sec">API key</td><td className="num">{s.credentialFingerprint}</td></tr>
              <tr><td className="sec">If you switch back to Demo with a position open</td><td className="num">{String(s.positionPolicyOnSwitchToDemo).replace(/_/g, ' ')}</td></tr>
              <tr><td className="sec">Kill switch with a position open</td><td className="num">{String(s.killSwitchAction).replace(/_/g, ' ')}</td></tr>
            </tbody>
          </table>
          <h4 style={{ margin: '14px 0 4px' }}>I acknowledge that…</h4>
          {pre!.acknowledgements.map((a, i) => (
            <label key={i} className="check-row">
              <input type="checkbox" checked={acks[i] ?? false} onChange={(e) => setAcks((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))} />
              <span>{a}</span>
            </label>
          ))}
        </div>
      )}

      {step === 3 && pre && (
        <div>
          <h3>3 · Confirm</h3>
          <p className="sec">Re-enter your password and type the exact phrase to arm {state.deployment.realMoney ? 'REAL-MONEY' : 'sandbox'} order execution. This action is recorded in the audit log.</p>
          <div className="field">
            <label htmlFor="pw">Your password</label>
            <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="ph">Type <code>{pre.requiredPhrase}</code></label>
            <input id="ph" type="text" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          {failed && (
            <ul className="checks" style={{ marginTop: 10 }}>
              {failed.map((c) => <li key={c.id}><span className="mark no">✕</span><span><b>{c.title}</b> <span className="sec">— {c.detail}</span></span></li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
