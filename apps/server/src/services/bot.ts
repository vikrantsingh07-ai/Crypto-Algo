import { breakevenWinRate, effectiveMaxHoldMs, estimateEconomics, evaluateLatest, feeConfigFrom, quantityToContracts, riskSummary, type ContractSpec, type Evaluation, type Quote, type Settings } from '@cryptoalgo/core';
import type { DeltaEndpoints, DeltaHttp, Logger, MarketFeed } from '@cryptoalgo/delta';
import type { AppConfig } from '../config';
import { randomId } from '../crypto';
import type { BotState, Repos } from '../repos';
import type { CredentialStore } from './credentials';
import type { DemoEngine } from './demoEngine';
import type { LiveExecutor } from './liveExecutor';
import { PrivateStream } from './privateStream';

export interface BotDeps {
  cfg: AppConfig;
  repos: Repos;
  logger: Logger;
  feed: MarketFeed;
  demo: DemoEngine;
  live: LiveExecutor;
  creds: CredentialStore;
  http: DeltaHttp;
  endpoints: DeltaEndpoints;
  getSettings: () => Settings;
  getSpec: () => ContractSpec;
  refreshSpec: () => Promise<ContractSpec>;
  now: () => number;
}

export interface ModeSwitchResult {
  mode: 'demo';
  policy: string;
  livePositionOpen: boolean;
  action: string;
}

/**
 * Orchestrator. Owns the persisted BotState, wires market data into the demo and live engines, runs
 * the strategy on every closed candle and routes signals to the ACTIVE mode only. Only one instance
 * (the lease holder) trades; others serve read-only API.
 */
export class Bot {
  state!: BotState;
  workerActive = false;
  startedAt = 0;
  lastEvaluation: (Evaluation & { at: number }) | null = null;
  readonly instanceId = randomId('w_', 6);
  private lastSignalTime = { long: 0, short: 0 };
  private timers: NodeJS.Timeout[] = [];
  private lastLiveMonitor = 0;
  private lastLiveAccount = 0;
  private quoteHandler = (q: Quote) => this.onQuote(q);
  private candleHandler = () => void this.onCandle().catch((e) => this.d.logger.error('candle handler failed', { error: (e as Error).message }));
  private lastSpecRefresh = 0;
  private lastError: string | null = null;
  readonly privateStream: PrivateStream;

  constructor(private readonly d: BotDeps) {
    this.privateStream = new PrivateStream({
      endpoints: d.endpoints,
      creds: d.creds,
      symbol: () => d.getSettings().instrument.symbol,
      now: () => this.now(),
      logger: d.logger,
      onEvent: () => void d.live.reconcile().catch((e) => d.logger.warn('event-triggered reconcile failed', { error: (e as Error).message })),
    });
  }

  /** Called when API credentials are added / replaced / removed. */
  onCredentialsChanged(): void {
    if (this.workerActive) this.privateStream.start();
  }

  private now() {
    return this.d.now();
  }

  async reload(): Promise<BotState> {
    this.state = await this.d.repos.getBotState(this.d.cfg.BOT_AUTOSTART);
    return this.state;
  }

  async save(next: BotState): Promise<void> {
    this.state = { ...next, updatedAt: this.now() };
    await this.d.repos.saveBotState(this.state);
  }

  // ------------------------------------------------------------------ lifecycle
  async init(): Promise<void> {
    await this.reload();
    // a fresh install is always Demo with live disarmed
    if (!(await this.d.repos.getDoc('bot_state'))) await this.d.repos.saveBotState(this.state);
    await this.d.repos.failStaleBacktests();
    await this.d.live.loadWaiver(); // standby instances show the persisted Scalper Offer status too
  }

  async start(): Promise<void> {
    const ttl = 30_000;
    this.workerActive = this.d.cfg.WORKER_ENABLED && (await this.d.repos.acquireLease(this.instanceId, ttl, this.now(), { startedAt: this.now() }));
    if (!this.workerActive) {
      this.d.logger.warn('trading worker not active on this instance (disabled or another instance holds the lease)');
      this.timers.push(setInterval(() => void this.tryTakeover(), 15_000));
      return;
    }
    await this.activate();
  }

  private async tryTakeover() {
    if (this.workerActive || !this.d.cfg.WORKER_ENABLED) return;
    const ok = await this.d.repos.acquireLease(this.instanceId, 30_000, this.now(), { startedAt: this.now() }).catch(() => false);
    if (ok) {
      this.d.logger.info('acquired worker lease; starting trading worker');
      this.workerActive = true;
      await this.activate();
    }
  }

  private async activate() {
    this.startedAt = this.now();
    const d = this.d;
    await d.demo.init();
    await d.live.loadHistory();
    await d.creds.refresh();
    // Safety on restart: an armed flag from a previous run is only honoured after reconciliation passes
    // (the live executor blocks entries until `reconciled`), and never for a different API key.
    await this.reload();
    if (this.state.liveArmed && this.state.liveArmedFingerprint && this.state.liveArmedFingerprint !== d.creds.fingerprint()) {
      d.logger.warn('API credentials changed since live activation: disarming live execution');
      await this.save({ ...this.state, liveArmed: false, mode: 'demo', attention: [...this.state.attention, 'API credentials changed; Live trading disarmed'] });
      await d.repos.audit({ actor: 'system', action: 'live_disarmed', details: { reason: 'credentials changed' } });
    }
    if (d.creds.status().configured) await d.live.reconcile().catch((e) => d.logger.warn('initial reconcile failed', { error: (e as Error).message }));
    this.privateStream.start();
    await d.feed.start();
    d.feed.on('quote', this.quoteHandler);
    d.feed.on('candleClosed', this.candleHandler);
    this.timers.push(setInterval(() => void this.housekeeping().catch((e) => d.logger.error('housekeeping failed', { error: (e as Error).message })), 5_000));
    this.timers.push(setInterval(() => void this.snapshotEquity().catch(() => {}), 60_000));
    for (const t of this.timers) t.unref?.();
    await this.housekeeping();
    d.logger.info('trading worker started', { mode: this.state.mode, running: this.state.running, armed: this.state.liveArmed });
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.d.feed.off('quote', this.quoteHandler);
    this.d.feed.off('candleClosed', this.candleHandler);
    this.d.feed.stop();
    this.privateStream.stop();
    if (this.workerActive) await this.d.repos.releaseLease(this.instanceId).catch(() => {});
    this.workerActive = false;
  }

  // ------------------------------------------------------------------ periodic work
  private async housekeeping() {
    const d = this.d;
    const now = this.now();
    if (this.workerActive) {
      const ok = await d.repos.acquireLease(this.instanceId, 30_000, now, { mode: this.state.mode }).catch(() => false);
      if (!ok) {
        d.logger.error('lost the worker lease; stopping trading on this instance');
        this.workerActive = false;
        return;
      }
    }
    await this.reload();
    const s = d.getSettings();
    const st = this.state;

    if (d.creds.status().configured) {
      // Fast cadence while live is armed / a real position exists; a slower account refresh keeps the
      // Live panel's connection status and balances current while in Demo.
      const active = st.liveArmed || st.mode === 'live' || !!d.live.position;
      const every = active ? s.live.reconcileIntervalSeconds * 1000 : 30_000;
      if (now - this.lastLiveAccount >= every) {
        this.lastLiveAccount = now;
        await d.live.reconcile().catch((e) => d.logger.warn('reconcile failed', { error: (e as Error).message }));
      }
    }
    if (now - this.lastSpecRefresh > 30 * 60_000) {
      this.lastSpecRefresh = now;
      await d.refreshSpec().catch((e) => d.logger.warn('contract refresh failed', { error: (e as Error).message }));
    }
    await this.writeStatus();
  }

  private async snapshotEquity() {
    const d = this.d;
    const now = this.now();
    if (!d.demo.account) return;
    const e = d.demo.equity();
    await d.repos.addEquity('demo', now, e.equity, e.balance, e.unrealized);
    if (d.live.account.equityUsd !== null && d.live.account.fetchedAt) {
      await d.repos.addEquity('live', now, d.live.account.equityUsd, d.live.account.equityUsd - (d.live.account.position?.unrealizedPnl ?? 0), d.live.account.position?.unrealizedPnl ?? 0);
    }
  }

  private async writeStatus() {
    await this.d.repos.setDoc('worker_status', { instance: this.instanceId, at: this.now(), mode: this.state.mode, running: this.state.running, lastError: this.lastError });
  }

  // ------------------------------------------------------------------ market data handlers
  private onQuote(q: Quote) {
    if (!this.workerActive) return;
    void this.d.demo.onQuote(q).catch((e) => this.d.logger.error('demo quote handler failed', { error: (e as Error).message }));
    const now = this.now();
    if (this.d.live.position && now - this.lastLiveMonitor >= 1_000) {
      this.lastLiveMonitor = now;
      void this.d.live.monitor(q).catch((e) => {
        this.lastError = (e as Error).message;
        this.d.logger.error('live monitor failed', { error: this.lastError });
      });
    }
  }

  private async onCandle() {
    if (!this.workerActive) return;
    const settings = this.d.getSettings();
    const candles = this.d.feed.getClosedCandles();
    if (candles.length === 0) return;
    const i = candles.length - 1;
    const idxOf = (t: number) => (t ? i - Math.round((candles[i].t - t) / 60_000) : -Infinity);
    const ev = evaluateLatest(candles, settings, { lastSignalIndex: { long: idxOf(this.lastSignalTime.long), short: idxOf(this.lastSignalTime.short) } });
    if (!ev) return;
    this.lastEvaluation = { ...ev, at: this.now() };

    const st = await this.reload();
    if (!st.running || st.killSwitch || !ev.signal) return;
    const quote = this.d.feed.getQuote();
    if (!quote) return;
    this.lastSignalTime[ev.signal.side] = ev.signal.candleTime;
    const health = this.d.feed.health();

    if (st.mode === 'demo') {
      await this.d.demo.tryEnter(ev.signal, quote, { killSwitch: st.killSwitch, apiHealthy: health.mode !== 'down', lastTickTs: quote.ts });
    } else if (st.mode === 'live') {
      const res = await this.d.live.tryEnter(ev.signal, quote);
      if (!res.allowed) this.d.logger.info('live entry not taken', { reasons: res.reasons });
    }
  }

  // ------------------------------------------------------------------ operator commands
  async setRunning(running: boolean, actor: string, role: string, ip?: string | null): Promise<BotState> {
    const st = await this.reload();
    await this.save({ ...st, running });
    await this.d.repos.audit({ actor, role, ip, action: running ? 'bot_started' : 'bot_stopped', details: { mode: st.mode } });
    return this.state;
  }

  /** Emergency stop. Blocks every new entry (demo and live), disarms live, applies the configured live position policy. */
  async engageKillSwitch(actor: string, role: string, ip?: string | null, reason = 'manual'): Promise<{ state: BotState; action: string }> {
    const st = await this.reload();
    const settings = this.d.getSettings();
    await this.save({ ...st, killSwitch: true, killSwitchAt: this.now(), liveArmed: false, mode: 'demo', attention: [...st.attention, `Kill switch engaged (${reason})`] });
    await this.d.repos.audit({ actor, role, ip, action: 'kill_switch_engaged', details: { reason, policy: settings.live.killSwitchAction, previousMode: st.mode, wasArmed: st.liveArmed } });
    this.d.logger.error('KILL SWITCH ENGAGED', { by: actor, reason });

    let action = 'none';
    if (this.d.creds.status().configured) {
      try {
        const cancelled = await this.d.live.cancelEntryOrders();
        if (cancelled) action = `cancelled ${cancelled} entry order(s)`;
      } catch (e) {
        this.d.logger.error('could not cancel entry orders during kill switch', { error: (e as Error).message });
      }
      const hasPos = !!this.d.live.position || (this.d.live.account.position?.size ?? 0) !== 0;
      if (hasPos && settings.live.killSwitchAction === 'flatten_positions') {
        try {
          await this.d.live.closeNow('kill_switch');
          action = 'flattened live position';
        } catch (e) {
          action = `FAILED to flatten live position: ${(e as Error).message}`;
          await this.save({ ...this.state, attention: [...this.state.attention, action] });
        }
      } else if (hasPos) {
        action = 'live position left under exchange-side protective stop';
      }
    }
    return { state: this.state, action };
  }

  async releaseKillSwitch(actor: string, role: string, ip?: string | null): Promise<BotState> {
    const st = await this.reload();
    await this.save({ ...st, killSwitch: false, killSwitchAt: null });
    await this.d.repos.audit({ actor, role, ip, action: 'kill_switch_released', details: {} });
    return this.state;
  }

  /** Live -> Demo. Stops NEW live entries immediately and applies the configured position policy. */
  async switchToDemo(actor: string, role: string, ip?: string | null): Promise<ModeSwitchResult> {
    const st = await this.reload();
    const policy = this.d.getSettings().live.modeSwitchPolicy;
    await this.save({ ...st, mode: 'demo', liveArmed: false });
    const positionOpen = !!this.d.live.position || (this.d.live.account.position?.size ?? 0) !== 0;
    let action = positionOpen ? '' : 'no live position open';
    if (positionOpen) {
      if (policy === 'close_at_market') {
        try {
          await this.d.live.closeNow('mode_switch');
          action = 'live position closed at market (reduce-only)';
        } catch (e) {
          action = `FAILED to close live position: ${(e as Error).message}`;
          await this.save({ ...this.state, attention: [...this.state.attention, action] });
        }
      } else if (policy === 'keep_managing') {
        action = 'new live entries stopped; open live position continues to be managed by its stop, target and time exit';
        await this.save({ ...this.state, attention: [...this.state.attention, 'Live position still open after switching to Demo (managed by exit rules)'] });
      } else {
        action = 'new live entries stopped; open live position left under its exchange-side stop for manual review';
        await this.save({ ...this.state, attention: [...this.state.attention, 'Live position open: manual review required (exchange-side stop remains)'] });
      }
    }
    await this.d.repos.audit({ actor, role, ip, action: 'mode_switched_to_demo', details: { previousMode: st.mode, policy, positionOpen, action } });
    return { mode: 'demo', policy, livePositionOpen: positionOpen, action };
  }

  async addAttention(message: string): Promise<void> {
    const st = await this.reload();
    if (!st.attention.includes(message)) await this.save({ ...st, attention: [...st.attention, message].slice(-20) });
  }

  async clearAttention(actor: string, role: string, ip?: string | null) {
    const st = await this.reload();
    await this.save({ ...st, attention: [] });
    await this.d.repos.audit({ actor, role, ip, action: 'attention_cleared', details: {} });
  }

  // ------------------------------------------------------------------ dashboard snapshot
  /**
   * "Fee reality check": what each target size is worth after maker/taker fees + GST at the current price.
   * The main tables follow the DEMO fee configuration (Scalper Offer waiver while it is assumed); the `*NoWaiver`
   * tables show the same trades with a full closing fee, which is what live falls back to if Delta turns out not to
   * waive it. `scalper.liveEffective` says which of the two live is currently gating on.
   */
  private economics(settings: Settings, spec: ContractSpec, quote: Quote | null) {
    const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
    if (!contracts || !quote) return null;
    const px = quote.last;
    const fees = feeConfigFrom(settings, spec);
    const noWaiver = feeConfigFrom(settings, spec, { waiverOverride: false });
    const waived = feeConfigFrom(settings, spec, { waiverOverride: true });
    const t = settings.targets;
    const stop = (t.stopLossMinUsd + t.stopLossMaxUsd) / 2;
    const moves = [t.targetMoveMinUsd, (t.targetMoveMinUsd + t.targetMoveMaxUsd) / 2, t.targetMoveMaxUsd];
    const row = (move: number, targetRole: 'maker' | 'taker', cfg = fees) => {
      const e = estimateEconomics({ side: 'long', entryPrice: px, targetPrice: px + move, stopPrice: px - stop, contracts, contractValue: spec.contractValue, targetRole, stopSlippageUsd: settings.execution.simStopSlippageUsd }, cfg);
      return { moveUsd: move, grossReward: e.rewardGross, fees: e.feeIfTarget, netReward: e.rewardNet, netRewardRisk: e.netRewardRisk, requiredWinRate: breakevenWinRate(e.rewardNet, e.riskNet) };
    };
    const be = (role: 'maker' | 'taker', cfg = fees) => estimateEconomics({ side: 'long', entryPrice: px, targetPrice: px + 5, stopPrice: px - stop, contracts, contractValue: spec.contractValue, targetRole: role }, cfg).breakevenMoveUsd;
    const w = settings.execution.exitFeeWaiver;
    return {
      referencePrice: px,
      contracts,
      stopUsd: stop,
      makerTarget: moves.map((m) => row(m, 'maker')),
      takerTarget: moves.map((m) => row(m, 'taker')),
      breakevenMoveMakerExitUsd: be('maker'),
      breakevenMoveTakerExitUsd: be('taker'),
      rates: { maker: fees.makerRate, taker: fees.takerRate, gst: fees.gstRate },
      verifiedSpec: spec.verified,
      scalper: {
        assumed: w.enabled,
        effective: w.enabled,
        liveEffective: this.d.live.waiverEffective(),
        windowMinutes: w.withinMinutes,
        safetyMarginSeconds: w.safetyMarginSeconds,
        effectiveMaxHoldMinutes: effectiveMaxHoldMs(settings, w.enabled) / 60_000,
      },
      makerTargetNoWaiver: moves.map((m) => row(m, 'maker', noWaiver)),
      takerTargetNoWaiver: moves.map((m) => row(m, 'taker', noWaiver)),
      breakevenMoveNoWaiverMakerExitUsd: be('maker', noWaiver),
      breakevenMoveWaivedUsd: be('taker', waived),
    };
  }

  snapshot() {
    const d = this.d;
    const settings = d.getSettings();
    const spec = d.getSpec();
    const quote = d.feed.getQuote();
    const now = this.now();
    const age = quote ? now - quote.ts : null;
    const health = d.feed.health();
    const st = this.state;
    const demoState = d.demo.account ? d.demo.riskState({ killSwitch: st.killSwitch, apiHealthy: health.mode !== 'down', lastTickTs: quote?.ts ?? null }) : null;
    const liveRs = d.live.riskState();
    liveRs.killSwitch = st.killSwitch;
    liveRs.liveArmed = st.liveArmed;
    return {
      now,
      mode: st.mode,
      running: st.running,
      killSwitch: st.killSwitch,
      killSwitchAt: st.killSwitchAt,
      liveArmed: st.liveArmed,
      liveArmedAt: st.liveArmedAt,
      liveArmedBy: st.liveArmedBy,
      attention: st.attention,
      workerActive: this.workerActive,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      deployment: {
        exchange: d.endpoints.label,
        env: d.endpoints.env,
        realMoney: d.endpoints.realMoney,
        marketData: d.feed.synthetic ? 'synthetic' : 'delta',
        liveHardDisabled: d.cfg.LIVE_HARD_DISABLE,
        restUrl: d.endpoints.restUrl,
      },
      feed: { health, quote, ageMs: age, stale: age === null || age > settings.filters.staleDataSeconds * 1000, synthetic: !!d.feed.synthetic, fundingRate: d.feed.getFundingRate() },
      spec,
      evaluation: this.lastEvaluation,
      demo: d.demo.account ? { ...d.demo.summary(), risk: riskSummary(settings, spec, demoState!) } : null,
      live: {
        ...d.live.snapshot(),
        credentials: d.creds.status(),
        risk: riskSummary(settings, spec, liveRs),
        clockOffsetMs: d.http.clockOffset,
        apiLastSuccessAt: d.http.lastSuccessAt,
        apiLastError: d.http.lastError,
        privateStream: this.privateStream.status(),
      },
      economics: this.economics(settings, spec, quote),
      spark: [...d.feed.getClosedCandles().slice(-90).map((c) => [c.t, c.c]), ...(d.feed.getFormingCandle() ? [[d.feed.getFormingCandle()!.t, d.feed.getFormingCandle()!.c]] : [])],
      settings,
    };
  }
}
