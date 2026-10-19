import { createHash } from 'node:crypto';
import {
  estimateEconomics,
  feeConfigFrom,
  hasErrors,
  quantityToContracts,
  validateSettings,
  waiverGuaranteed,
  type ContractSpec,
  type Settings,
} from '@cryptoalgo/core';
import { explainDeltaError, type DeltaClient, type DeltaEndpoints, type DeltaHttp, type Logger, type MarketFeed } from '@cryptoalgo/delta';
import type { AppConfig } from '../config';
import { hmacHex, safeEqual } from '../crypto';
import type { BotState, Repos } from '../repos';
import type { CredentialStore } from './credentials';
import { maxHoldMinutesOrNull } from './holdLimit';
import type { LiveExecutor } from './liveExecutor';

/**
 * Live activation workflow. Selecting "Live" in the dashboard never sends an order. It starts this
 * sequence, and every step must succeed:
 *
 *   1. preflight   verifies connection, permissions, contract, leverage, quantity, balance, margin,
 *                  risk limits, exchange position/order synchronisation, market-data health, clock
 *   2. review      the operator sees a summary and ticks the risk acknowledgements
 *   3. confirm     operator re-enters their password and types the exact confirmation phrase
 *   4. activate    server re-runs preflight, verifies the review token still matches, then arms live
 *                  execution and writes an audit record
 *
 * A failed check leaves Live disabled and explains why.
 */

export interface PreflightCheck {
  id: string;
  title: string;
  ok: boolean;
  blocker: boolean;
  detail: string;
}

export interface ActivationSummary {
  environment: string;
  realMoney: boolean;
  symbol: string;
  productId: number | null;
  contractValueEth: number;
  contracts: number | null;
  quantityEth: number;
  leverage: number;
  maxLeverage: number;
  referencePrice: number | null;
  estimatedMarginUsd: number | null;
  availableBalanceUsd: number | null;
  stopLossMaxUsd: number;
  targetRangeUsd: [number, number];
  perTradeRiskUsd: number;
  dailyLossLimitUsd: number;
  maxTradesPer24h: number;
  maxDrawdownPct: number;
  /** null = no time limit: a position stays open until its target or its stop-loss is hit. */
  maxHoldMinutes: number | null;
  /** Plain-language statement of the holding rule for the review screen. */
  holdNote: string;
  feeFractionOfTarget: number | null;
  breakevenMoveUsd: number | null;
  credentialFingerprint: string | null;
  positionPolicyOnSwitchToDemo: string;
  killSwitchAction: string;
  /**
   * Delta Scalper Offer (no closing fee when a position is closed within the window): DORMANT, off by default. The
   * economics above assume it only while `assumed` and a time limit guarantees every exit inside the window;
   * `effectiveMaxHoldMinutes` is the time exit live will use (null = none).
   */
  scalperOffer: {
    assumed: boolean;
    windowMinutes: number;
    safetyMarginSeconds: number;
    effectiveMaxHoldMinutes: number | null;
  };
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  summary: ActivationSummary;
  /** Review token to submit with the activation request (valid for 5 minutes, bound to this summary). */
  token: string | null;
  expiresAt: number;
  requiredPhrase: string;
  acknowledgements: string[];
}

export interface ActivationDeps {
  cfg: AppConfig;
  repos: Repos;
  creds: CredentialStore;
  client: DeltaClient;
  http: DeltaHttp;
  endpoints: DeltaEndpoints;
  getSettings: () => Settings;
  getSpec: () => ContractSpec;
  refreshSpec: () => Promise<ContractSpec>;
  executor: LiveExecutor;
  feed: MarketFeed;
  getBotState: () => Promise<BotState>;
  saveBotState: (s: BotState) => Promise<void>;
  now: () => number;
  logger: Logger;
}

const TOKEN_TTL_MS = 5 * 60_000;

/** The plain-language statement of the holding rule: shown in the review and acknowledged by the operator. */
export function holdRuleText(settings: Settings): string {
  const limit = settings.exits.timeExitPolicy === 'none' ? null : settings.exits.maxHoldMinutes;
  return limit === null
    ? 'There is no time limit: a position stays open until its target or its stop-loss is hit (or you close it). It can stay open for hours, through funding payments, and it is not guaranteed to reach its target. The stop-loss is always active.'
    : `A position that has hit neither its target nor its stop-loss is closed at the market price after ${limit} minutes, which can be at a loss. The stop-loss is always active.`;
}

/** The risk acknowledgements for the CURRENT settings (the review screen shows exactly these). */
export function acknowledgementsFor(settings: Settings): string[] {
  const t = settings.targets;
  const move = t.targetMoveMinUsd === t.targetMoveMaxUsd ? `$${t.targetMoveMinUsd}` : `$${t.targetMoveMinUsd}–$${t.targetMoveMaxUsd}`;
  const limit = settings.exits.timeExitPolicy === 'none' ? null : settings.exits.maxHoldMinutes;
  const acks = [
    'I understand Live Trading places REAL orders using real funds and can lose money, including my entire deposit.',
    `I understand ${settings.position.leverage}x leverage amplifies losses, and that brokerage (maker/taker fees plus GST) is paid on both the entry and the exit and takes a part of a ${move} price move.`,
    'I have run this strategy in Demo mode and reviewed the results; I do not rely on backtests as a guarantee of profit.',
    'I understand the bot can be stopped with the Emergency Kill Switch and that I am responsible for monitoring my account.',
    limit === null
      ? 'I understand a position has no time limit: it can stay open for hours and through funding payments, it ends only when its target or its stop-loss is hit (or I close it), and it is not guaranteed to reach its target.'
      : `I understand a position that has hit neither its target nor its stop-loss is closed at the market price after ${limit} minutes, possibly at a loss.`,
  ];
  // The Scalper Offer is dormant (off by default): it is only mentioned when it has been switched on.
  if (settings.execution.exitFeeWaiver.enabled) {
    acks.push('I understand the zero closing fee depends on my Delta account having joined the Scalper Offer; if it has not, closing fees apply and results will be lower than shown.');
  }
  return acks;
}

export class LiveActivation {
  constructor(private readonly d: ActivationDeps) {}

  requiredPhrase(): string {
    return this.d.endpoints.realMoney ? 'ENABLE LIVE TRADING' : 'ENABLE TESTNET TRADING';
  }

  async preflight(actor: string): Promise<PreflightResult> {
    const d = this.d;
    const settings = d.getSettings();
    const checks: PreflightCheck[] = [];
    const add = (id: string, title: string, ok: boolean, detail: string, blocker = true) => checks.push({ id, title, ok, detail, blocker });
    const guard = async (id: string, title: string, fn: () => Promise<{ ok: boolean; detail: string; blocker?: boolean }>) => {
      try {
        const r = await fn();
        add(id, title, r.ok, r.detail, r.blocker ?? true);
      } catch (e) {
        add(id, title, false, explainDeltaError(e));
      }
    };

    const bot = await d.getBotState();
    add('hard_disable', 'Deployment allows live trading', !d.cfg.LIVE_HARD_DISABLE, d.cfg.LIVE_HARD_DISABLE ? 'LIVE_HARD_DISABLE=true is set on the server; remove it and restart to allow Live Trading.' : 'No deployment-level lock.');
    add('kill_switch', 'Kill switch released', !bot.killSwitch, bot.killSwitch ? 'The emergency kill switch is engaged; release it first.' : 'Kill switch is not engaged.');
    add('market_data_real', 'Market data is real', !d.feed.synthetic, d.feed.synthetic ? 'The server is running on SYNTHETIC development data. Live trading is impossible.' : 'Real exchange market data.');
    const cs = d.creds.status();
    add('credentials', 'API credentials configured on the server', cs.configured, cs.configured ? `Key ${cs.keyHint} (${cs.fingerprint}) from ${cs.source}.` : 'No API key/secret configured for this environment. Add them in Settings → Exchange connection.');
    this.addScalperCheck(add);
    add('holding_rule', 'Holding rule', true, holdRuleText(settings), false);
    add('environment', 'Exchange environment', true, `${d.endpoints.label}${d.endpoints.realMoney ? ' — REAL FUNDS' : ' — sandbox, no real funds'}`, false);

    let spec = d.getSpec();
    await guard('exchange_reachable', 'Exchange API reachable & contract fetched', async () => {
      spec = await d.refreshSpec();
      return { ok: spec.verified, detail: spec.verified ? `${spec.symbol} (product ${spec.productId}) read from the exchange.` : 'Contract specification could not be read from the exchange.' };
    });
    add('contract_status', 'Contract is tradable', spec.verified && spec.tradingStatus === 'operational', `Trading status: ${spec.tradingStatus}`);
    add('contract_type', 'Linear contract (P&L formulas valid)', spec.verified && spec.notionalType === 'vanilla' && spec.contractType === 'perpetual_futures', `notional_type=${spec.notionalType}, contract_type=${spec.contractType}`);

    const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
    add('quantity', 'Quantity maps to whole contracts', contracts !== null, contracts !== null ? `${settings.position.quantityEth} ETH = ${contracts} contracts × ${spec.contractValue} ETH` : `${settings.position.quantityEth} ETH is not a multiple of ${spec.contractValue} ETH per contract`);
    add('leverage', 'Leverage within exchange limit', settings.position.leverage <= spec.maxLeverage, `${settings.position.leverage}x configured; exchange maximum ${spec.maxLeverage}x`);

    const quote = d.feed.getQuote();
    const quoteAge = quote ? d.now() - quote.ts : null;
    add('market_data_fresh', 'Market data fresh', quote !== null && quoteAge !== null && quoteAge <= settings.filters.staleDataSeconds * 1000, quote ? `Last quote ${(quoteAge! / 1000).toFixed(1)}s ago (limit ${settings.filters.staleDataSeconds}s)` : 'No market data received yet');

    const issues = validateSettings(settings, spec, { referencePrice: quote?.last ?? null });
    add('settings_valid', 'Settings valid for this contract', !hasErrors(issues), hasErrors(issues) ? issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ') : issues.length ? `${issues.length} warning(s): ${issues.map((i) => i.message).join(' ')}` : 'All settings pass exchange validation.');

    const L = settings.limits;
    add('risk_limits', 'Risk limits sane', L.dailyLossLimitUsd > 0 && L.maxTradesPer24h <= 10 && L.perTradeRiskUsd <= L.dailyLossLimitUsd, `per-trade risk ${L.perTradeRiskUsd}, daily loss limit ${L.dailyLossLimitUsd}, max ${L.maxTradesPer24h} trades/24h`);

    const offset = Math.abs(d.http.clockOffset);
    add('clock', 'Server clock in sync', offset < 2000, `Estimated clock offset ${(offset / 1000).toFixed(1)}s (signatures are valid for 5s)`);

    let availableUsd = null as number | null;
    if (cs.configured) {
      await guard('auth', 'Authenticated API access (balances)', async () => {
        const acct = await d.executor.refreshAccount();
        if (acct.error) return { ok: false, detail: acct.error };
        availableUsd = acct.availableUsd;
        return { ok: true, detail: `Wallet readable. Available balance ≈ ${acct.availableUsd?.toFixed(2)} (USD-equivalent).` };
      });
      await guard('trading_permission', 'API key has Trading permission', async () => {
        const pid = spec.productId;
        if (!pid) return { ok: false, detail: 'Unknown product id' };
        // Re-sending the CURRENT leverage requires Trading permission but changes nothing and places no order.
        const cur = await d.client.getOrderLeverage(pid);
        await d.client.setOrderLeverage(pid, cur);
        return { ok: true, detail: `Trading permission confirmed (current order leverage ${cur}x, unchanged).` };
      });
      await guard('exchange_state', 'Exchange positions & orders synchronised', async () => {
        await d.executor.reconcile();
        const e = d.executor;
        return { ok: e.reconciled, detail: e.reconciled ? 'No untracked position or stray orders; database matches the exchange.' : `Not synchronised: ${e.reconcileReason}` };
      });
    } else {
      add('auth', 'Authenticated API access (balances)', false, 'Skipped: no credentials');
      add('trading_permission', 'API key has Trading permission', false, 'Skipped: no credentials');
      add('exchange_state', 'Exchange positions & orders synchronised', false, 'Skipped: no credentials');
    }

    const price = quote?.last ?? null;
    const estMargin = contracts !== null && price ? (contracts * spec.contractValue * price) / settings.position.leverage : null;
    const need = estMargin !== null ? estMargin * 1.5 + settings.live.minAvailableBalanceUsd : null;
    add('balance', 'Sufficient margin & balance', availableUsd !== null && need !== null && availableUsd >= need, estMargin !== null ? `Needs ≈ ${estMargin.toFixed(2)} margin (+50% buffer = ${need!.toFixed(2)}); available ${availableUsd === null ? 'unknown' : availableUsd.toFixed(2)}` : 'Cannot estimate margin without a price');

    let breakeven: number | null = null;
    let feeFrac: number | null = null;
    if (contracts !== null && price) {
      const e = estimateEconomics(
        { side: 'long', entryPrice: price, targetPrice: price + (settings.targets.targetMoveMinUsd + settings.targets.targetMoveMaxUsd) / 2, stopPrice: price - settings.targets.stopLossMaxUsd, contracts, contractValue: spec.contractValue, targetRole: settings.exits.takeProfitOrderType === 'limit' ? 'maker' : 'taker' },
        // the same fee view live gates on: waiver assumed unless the exchange has been seen charging a closing fee
        feeConfigFrom(settings, spec, { waiverOverride: d.executor.waiverEffective() && waiverGuaranteed(settings) }),
      );
      breakeven = e.breakevenMoveUsd;
      feeFrac = e.rewardGross > 0 ? e.feeIfTarget / e.rewardGross : null;
    }

    const summary: ActivationSummary = {
      environment: d.endpoints.label,
      realMoney: d.endpoints.realMoney,
      symbol: spec.symbol,
      productId: spec.productId,
      contractValueEth: spec.contractValue,
      contracts,
      quantityEth: settings.position.quantityEth,
      leverage: settings.position.leverage,
      maxLeverage: spec.maxLeverage,
      referencePrice: price,
      estimatedMarginUsd: estMargin,
      availableBalanceUsd: availableUsd,
      stopLossMaxUsd: settings.targets.stopLossMaxUsd,
      targetRangeUsd: [settings.targets.targetMoveMinUsd, settings.targets.targetMoveMaxUsd],
      perTradeRiskUsd: L.perTradeRiskUsd,
      dailyLossLimitUsd: L.dailyLossLimitUsd,
      maxTradesPer24h: L.maxTradesPer24h,
      maxDrawdownPct: L.maxDrawdownPct,
      maxHoldMinutes: settings.exits.timeExitPolicy === 'none' ? null : settings.exits.maxHoldMinutes,
      holdNote: holdRuleText(settings),
      feeFractionOfTarget: feeFrac,
      breakevenMoveUsd: breakeven,
      credentialFingerprint: cs.fingerprint,
      positionPolicyOnSwitchToDemo: settings.live.modeSwitchPolicy,
      killSwitchAction: settings.live.killSwitchAction,
      scalperOffer: {
        assumed: settings.execution.exitFeeWaiver.enabled,
        windowMinutes: settings.execution.exitFeeWaiver.withinMinutes,
        safetyMarginSeconds: settings.execution.exitFeeWaiver.safetyMarginSeconds,
        effectiveMaxHoldMinutes: maxHoldMinutesOrNull(settings, d.executor.waiverEffective()),
      },
    };

    const ok = checks.filter((c) => c.blocker).every((c) => c.ok);
    const expiresAt = d.now() + TOKEN_TTL_MS;
    const token = ok ? this.signToken(actor, this.summaryHash(summary, settings), expiresAt) : null;
    return { ok, checks, summary, token, expiresAt, requiredPhrase: this.requiredPhrase(), acknowledgements: acknowledgementsFor(settings) };
  }

  /** The waiver settings are part of what the operator reviewed: changing any of them invalidates the review token. */
  private summaryHash(s: ActivationSummary, settings: Settings): string {
    const { referencePrice: _p, availableBalanceUsd: _a, estimatedMarginUsd: _m, feeFractionOfTarget: _f, breakevenMoveUsd: _b, ...stable } = s;
    return createHash('sha256').update(JSON.stringify({ ...stable, exitFeeWaiver: settings.execution.exitFeeWaiver })).digest('hex').slice(0, 32);
  }

  /** Non-blocking: the offer can not be read through the API, so this only informs (and shows the current evidence). */
  private addScalperCheck(add: (id: string, title: string, ok: boolean, detail: string, blocker?: boolean) => void) {
    const w = this.d.getSettings().execution.exitFeeWaiver;
    const status = this.d.executor.waiver.status;
    const diwali = 'The separate "Diwali Scalper Offer" (opening fee returned as a voucher, BTCUSD only) does not apply to this ETHUSD bot and is not modelled.';
    if (!w.enabled) return; // dormant and off: brokerage is paid on both legs and there is nothing to report
    const limit = maxHoldMinutesOrNull(this.d.getSettings(), this.d.executor.waiverEffective());
    const exitText = limit === null ? 'no time limit is set, so a position can outlive the window and then pays the full closing fee; estimates keep the full fee' : `the time exit fires at ${limit.toFixed(1)} min`;
    const base = `Estimates assume Delta's Scalper Offer: no closing fee when a position is closed within ${w.withinMinutes} minutes (the opening fee is still paid; ${exitText}). The offer must be joined in your Delta account (trades taken before joining are not eligible, liquidations are not eligible), it cannot be verified through the API and will be verified on the first eligible live close. ${diwali}`;
    if (status === 'not_applied') {
      add('scalper_offer', 'Scalper Offer (zero closing fee)', false, `Delta already charged a closing fee on an eligible trade, so live is using full-fee economics. Join the offer in your Delta account and use "Reset & re-check" on the Live panel to verify again. ${base}`, false);
    } else if (status === 'confirmed') {
      add('scalper_offer', 'Scalper Offer (zero closing fee)', true, `Confirmed on ${this.d.executor.waiver.confirmedCount} live close(s). ${base}`, false);
    } else {
      add('scalper_offer', 'Scalper Offer (zero closing fee)', true, base, false);
    }
  }

  private signToken(actor: string, hash: string, exp: number): string {
    const body = Buffer.from(JSON.stringify({ a: actor, h: hash, e: exp })).toString('base64url');
    return `${body}.${hmacHex(this.d.cfg.sessionSecret, 'activation:' + body)}`;
  }

  /** Cheap stage: signature, expiry and operator. Returns the bound summary hash, or an error string. */
  private openToken(token: string, actor: string): { hash: string } | { error: string } {
    const [body, sig] = token.split('.');
    if (!body || !sig) return { error: 'malformed activation token' };
    if (!safeEqual(sig, hmacHex(this.d.cfg.sessionSecret, 'activation:' + body))) return { error: 'invalid activation token' };
    let p: { a: string; h: string; e: number };
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return { error: 'malformed activation token' };
    }
    if (p.e < this.d.now()) return { error: 'activation review expired; run the checks again' };
    if (p.a !== actor) return { error: 'activation token belongs to a different user' };
    return { hash: p.h };
  }

  async activate(input: { actor: string; role: string; ip?: string | null; token: string; phrase: string; acknowledged: boolean }): Promise<{ ok: boolean; error?: string; failedChecks?: PreflightCheck[]; state?: BotState }> {
    const d = this.d;
    const fail = async (error: string, extra: Record<string, unknown> = {}) => {
      await d.repos.audit({ actor: input.actor, role: input.role, ip: input.ip, action: 'live_activation_failed', success: false, details: { error, ...extra } });
      return { ok: false as const, error };
    };

    if (input.role !== 'admin') return fail('Only an administrator can activate Live Trading');
    if (!input.acknowledged) return fail('Risk acknowledgements must be accepted');
    if (input.phrase !== this.requiredPhrase()) return fail(`Confirmation phrase must be exactly "${this.requiredPhrase()}"`);

    // cheap checks first: a forged / expired / foreign token never triggers exchange calls
    const opened = this.openToken(input.token, input.actor);
    if ('error' in opened) return fail(opened.error);

    const pre = await this.preflight(input.actor);
    if (!pre.ok) {
      const failed = pre.checks.filter((c) => c.blocker && !c.ok);
      await d.repos.audit({ actor: input.actor, role: input.role, ip: input.ip, action: 'live_activation_failed', success: false, details: { error: 'preflight failed', failed: failed.map((c) => ({ id: c.id, detail: c.detail })) } });
      return { ok: false, error: 'Safety checks failed; Live Trading remains disabled', failedChecks: failed };
    }
    if (opened.hash !== this.summaryHash(pre.summary, d.getSettings())) return fail('settings or exchange parameters changed since review; run the checks again');

    const bot = await d.getBotState();
    const next: BotState = {
      ...bot,
      mode: 'live',
      liveArmed: true,
      liveArmedAt: d.now(),
      liveArmedBy: input.actor,
      liveArmedFingerprint: d.creds.fingerprint(),
      liveArmedEnv: d.endpoints.env,
      running: true,
      attention: [],
    };
    await d.saveBotState(next);
    await d.repos.audit({ actor: input.actor, role: input.role, ip: input.ip, action: 'live_activated', success: true, details: { environment: d.endpoints.label, realMoney: d.endpoints.realMoney, summary: pre.summary, checks: pre.checks.map((c) => ({ id: c.id, ok: c.ok })) } });
    d.logger.warn('LIVE TRADING ACTIVATED', { by: input.actor, env: d.endpoints.env });
    return { ok: true, state: next };
  }
}
