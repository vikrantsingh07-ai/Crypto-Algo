import { describe, expect, it } from 'vitest';
import {
  SettingsSchema,
  calcFee,
  calcPnl,
  dailyOutlook,
  effectiveMaxHoldMinutes,
  effectiveMaxHoldMs,
  estimateEconomics,
  feeConfigFrom,
  grossPnl,
  quantityToContracts,
  requiredWinRate,
  roundTripFee,
  validateSettings,
  hasErrors,
  defaultSettings,
} from '../src';
import { legacySettings, settings, spec } from './helpers';

/** Default config: brokerage is paid on both legs (the Scalper Offer waiver is dormant and off). */
const cfg = () => feeConfigFrom(settings(), spec());
/** The dormant Scalper Offer switched ON explicitly (exit fee waived when closed inside 30 minutes). */
const waiverCfg = () => feeConfigFrom(legacySettings(), spec());

describe('contract quantity & gross P&L (0.20 ETH)', () => {
  it('maps 0.20 ETH to 20 contracts at 0.01 ETH/contract', () => {
    expect(quantityToContracts(0.2, 0.01)).toBe(20);
    expect(quantityToContracts(0.2, 0.001)).toBe(200);
  });

  it('rejects quantities that are not a whole number of contracts', () => {
    expect(quantityToContracts(0.205, 0.01)).toBeNull();
    expect(quantityToContracts(0.001, 0.01)).toBeNull();
  });

  it('reproduces the stated gross P&L for $4 / $5 / $6 favourable moves', () => {
    expect(grossPnl('long', 3000, 3004, 20, 0.01)).toBeCloseTo(0.8, 10);
    expect(grossPnl('long', 3000, 3005, 20, 0.01)).toBeCloseTo(1.0, 10);
    expect(grossPnl('long', 3000, 3006, 20, 0.01)).toBeCloseTo(1.2, 10);
    expect(grossPnl('short', 3000, 2994, 20, 0.01)).toBeCloseTo(1.2, 10);
    expect(grossPnl('short', 3000, 3004, 20, 0.01)).toBeCloseTo(-0.8, 10);
  });
});

describe('fee engine', () => {
  it('charges commission = notional * rate plus 18% GST', () => {
    // notional = 20 * 0.01 * 3000 = 600 ; taker 0.05% = 0.30 ; GST 0.054
    const f = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker' }, cfg());
    expect(f.notional).toBeCloseTo(600, 8);
    expect(f.commission).toBeCloseTo(0.3, 8);
    expect(f.gst).toBeCloseTo(0.054, 8);
    expect(f.total).toBeCloseTo(0.354, 8);
  });

  it('maker is cheaper than taker', () => {
    const m = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'maker' }, cfg());
    const t = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker' }, cfg());
    expect(m.total).toBeLessThan(t.total);
    expect(m.commission).toBeCloseTo(0.12, 8);
  });

  it('both legs are charged by default, however short the hold (the Scalper Offer is not assumed)', () => {
    const exit = calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 60_000 }, cfg());
    expect(cfg().waiver.enabled).toBe(false);
    expect(exit.waived).toBe(false);
    expect(exit.saved).toBe(0);
    expect(exit.total).toBeCloseTo(3004 * 0.2 * 0.0005 * 1.18, 8);
  });

  it('dormant Scalper Offer (enabled explicitly): closing fee is zero inside the 30-minute window, the opening fee is always charged', () => {
    const exit = (holdMs: number, role: 'maker' | 'taker' = 'taker') =>
      calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role, isExit: true, holdMs }, waiverCfg());
    const w = exit(10 * 60_000);
    expect(w.waived).toBe(true);
    expect(w.total).toBe(0);
    expect(w.commission).toBe(0);
    expect(w.gst).toBe(0);
    // what the waiver saved = the normal taker fee on 3004*0.2 = 600.8 notional
    expect(w.saved).toBeCloseTo(600.8 * 0.0005 * 1.18, 6);
    expect(exit(10 * 60_000, 'maker').waived).toBe(true);
    // boundary: exactly 30:00 is still inside, 30:00.001 is not
    expect(exit(30 * 60_000).waived).toBe(true);
    expect(exit(30 * 60_000 + 1).waived).toBe(false);
    expect(exit(31 * 60_000).total).toBeGreaterThan(0);
    expect(exit(31 * 60_000).saved).toBe(0);
    // an ENTRY leg is never waived, even though it is "inside" the window
    const entry = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker', isExit: false, holdMs: 0 }, waiverCfg());
    expect(entry.waived).toBe(false);
    expect(entry.total).toBeCloseTo(0.354, 8);
    // an exit leg with an unknown hold is never assumed free
    expect(calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true }, waiverCfg()).waived).toBe(false);
  });

  it('the waiver is a setting: off by default, and the override beats it either way', () => {
    const exit = (c: ReturnType<typeof cfg>) => calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 10 * 60_000 }, c);
    expect(exit(cfg()).waived).toBe(false);
    expect(exit(cfg()).total).toBeGreaterThan(0);
    expect(exit(waiverCfg()).waived).toBe(true);
    // live override beats the setting (used when the exchange was seen charging a closing fee)
    expect(exit(feeConfigFrom(legacySettings(), spec(), { waiverOverride: false })).waived).toBe(false);
    expect(exit(feeConfigFrom(settings(), spec(), { waiverOverride: true })).waived).toBe(true);
  });

  it('computes net P&L, INR conversion and funding (default: both legs charged)', () => {
    const r = calcPnl(
      { side: 'long', entryPrice: 3000, exitPrice: 3006, contracts: 20, contractValue: 0.01, entryRole: 'taker', exitRole: 'maker', holdMs: 600_000, funding: -0.01 },
      cfg(),
    );
    expect(r.grossPnl).toBeCloseTo(1.2, 8);
    // entry taker 0.354 ; exit maker: 3006*0.2=601.2 * 0.0002 = 0.12024 *1.18 = 0.1418832
    expect(r.entryFee).toBeCloseTo(0.354, 6);
    expect(r.exitFee).toBeCloseTo(0.1418832, 6);
    expect(r.netPnl).toBeCloseTo(1.2 - 0.354 - 0.1418832 - 0.01, 6);
    expect(r.netPnlInr).toBeCloseTo(r.netPnl * 88, 2);
  });

  it('net P&L with the dormant Scalper Offer: only the entry fee is paid when the trade closes inside 30 minutes', () => {
    const base = { side: 'long' as const, entryPrice: 3000, contracts: 20, contractValue: 0.01, entryRole: 'taker' as const, funding: 0 };
    // $4 / $5 / $6 take-profit exits (maker) after 10 minutes: gross 0.80 / 1.00 / 1.20 minus 0.354 entry fee
    for (const [move, gross] of [[4, 0.8], [5, 1.0], [6, 1.2]] as const) {
      const r = calcPnl({ ...base, exitPrice: 3000 + move, exitRole: 'maker', holdMs: 10 * 60_000 }, waiverCfg());
      expect(r.grossPnl).toBeCloseTo(gross, 8);
      expect(r.exitFee).toBe(0);
      expect(r.fees).toBeCloseTo(0.354, 8);
      expect(r.netPnl).toBeCloseTo(gross - 0.354, 8);
    }
    // taker exit inside the window is free too ...
    expect(calcPnl({ ...base, exitPrice: 2997, exitRole: 'taker', holdMs: 20 * 60_000 }, waiverCfg()).exitFee).toBe(0);
    // ... but the same trade closed after 31 minutes pays the normal closing fee
    const late = calcPnl({ ...base, exitPrice: 3004, exitRole: 'taker', holdMs: 31 * 60_000 }, waiverCfg());
    expect(late.exitFee).toBeCloseTo(3004 * 0.2 * 0.0005 * 1.18, 6);
    // exchange-reported fees stay authoritative
    expect(calcPnl({ ...base, exitPrice: 3004, exitRole: 'taker', holdMs: 60_000, actualExitFee: 0.07 }, waiverCfg()).exitFee).toBe(0.07);
  });

  it('shows that taker/taker fees consume most of a $4 target (fee drag; why the target is $10 now)', () => {
    const e = estimateEconomics(
      { side: 'long', entryPrice: 3000, targetPrice: 3004, stopPrice: 2996, contracts: 20, contractValue: 0.01, entryRole: 'taker', targetRole: 'taker', stopRole: 'taker' },
      cfg(),
    );
    expect(e.rewardGross).toBeCloseTo(0.8, 8);
    expect(e.exitFeeWaived).toBe(false);
    expect(e.rewardNet).toBeLessThan(0.1); // practically no edge after fees
    expect(e.breakevenMoveUsd).toBeGreaterThan(3.5);
    expect(e.netRewardRisk).toBeLessThan(0.1);
  });

  it('with the dormant Scalper Offer ON a $4 / $5 / $6 target nets gross minus the single entry fee; break-even move shrinks to ~$1.77', () => {
    for (const [move, gross] of [[4, 0.8], [5, 1.0], [6, 1.2]] as const) {
      const e = estimateEconomics(
        { side: 'long', entryPrice: 3000, targetPrice: 3000 + move, stopPrice: 2997, contracts: 20, contractValue: 0.01, entryRole: 'taker', targetRole: 'maker', stopRole: 'taker', stopSlippageUsd: 0.25 },
        waiverCfg(),
      );
      expect(e.exitFeeWaived).toBe(true);
      expect(e.entryFee).toBeCloseTo(0.354, 8);
      expect(e.feeIfTarget).toBeCloseTo(0.354, 8);
      expect(e.feeIfStop).toBeCloseTo(0.354, 8);
      expect(e.rewardNet).toBeCloseTo(gross - 0.354, 8);
      // risk: $3 stop + 0.25 slippage on 0.2 ETH = 0.65, plus the entry fee only
      expect(e.riskNet).toBeCloseTo(0.65 + 0.354, 8);
      expect(e.breakevenMoveUsd).toBeCloseTo(0.354 / 0.2, 5);
      expect(e.exitFeeSaved).toBeGreaterThan(0.1);
    }
    // the same trade WITHOUT the waiver (the default) nets less and needs a bigger move to break even
    const w = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2997, contracts: 20, contractValue: 0.01 }, waiverCfg());
    const n = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2997, contracts: 20, contractValue: 0.01 }, cfg());
    expect(w.rewardNet).toBeGreaterThan(n.rewardNet);
    expect(w.breakevenMoveUsd).toBeLessThan(n.breakevenMoveUsd);
    expect(n.exitFeeSaved).toBe(0);
  });

  it('maker take-profit materially improves net reward when no waiver applies', () => {
    const t = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'taker' }, cfg());
    const m = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'maker' }, cfg());
    expect(m.rewardNet).toBeGreaterThan(t.rewardNet);
  });

  it('short trades get the same waiver when it is enabled, and none by default', () => {
    const inp = { side: 'short' as const, entryPrice: 3000, targetPrice: 2995, stopPrice: 3003, contracts: 20, contractValue: 0.01 };
    const e = estimateEconomics(inp, waiverCfg());
    expect(e.rewardGross).toBeCloseTo(1.0, 8);
    expect(e.rewardNet).toBeCloseTo(1.0 - 0.354, 8);
    expect(e.exitFeeWaived).toBe(true);
    const d = estimateEconomics(inp, cfg());
    expect(d.exitFeeWaived).toBe(false);
    expect(d.rewardNet).toBeLessThan(e.rewardNet);
  });
});

describe('dormant Scalper Offer exclusions', () => {
  it('never waives a liquidation, and never waives a separately configured transaction tax', () => {
    const exit = { price: 3004, contracts: 20, contractValue: 0.01, role: 'taker' as const, isExit: true, holdMs: 60_000 };
    const liq = calcFee({ ...exit, liquidation: true }, waiverCfg());
    expect(liq.waived).toBe(false);
    expect(liq.total).toBeCloseTo(3004 * 0.2 * 0.0005 * 1.18, 8);
    expect(liq.saved).toBe(0);
    const pnl = calcPnl({ side: 'long', entryPrice: 3000, exitPrice: 2950, contracts: 20, contractValue: 0.01, entryRole: 'taker', exitRole: 'taker', holdMs: 60_000, liquidation: true }, waiverCfg());
    expect(pnl.exitFee).toBeGreaterThan(0);

    const taxed = feeConfigFrom(legacySettings({ execution: { otherTaxRate: 0.001 } }), spec());
    const w = calcFee(exit, taxed);
    expect(w.waived).toBe(true);
    expect(w.commission).toBe(0);
    expect(w.gst).toBe(0);
    expect(w.tax).toBeCloseTo(600.8 * 0.001, 8); // the levy is still charged
    expect(w.total).toBeCloseTo(w.tax, 8);
    expect(w.saved).toBeCloseTo(600.8 * 0.0005 * 1.18, 8); // saved = exchange fee only
  });

  it('settings validation: safety margin must be shorter than the window; a window longer than Delta publishes is flagged', () => {
    const bad = validateSettings(legacySettings({ execution: { exitFeeWaiver: { withinMinutes: 1, safetyMarginSeconds: 90 } }, exits: { maxHoldMinutes: 1, breakevenAfterMinutes: 1 } }), spec(), { referencePrice: 3000 });
    expect(bad.some((i) => i.path === 'execution.exitFeeWaiver.safetyMarginSeconds' && i.severity === 'error')).toBe(true);
    const long = validateSettings(legacySettings({ execution: { exitFeeWaiver: { withinMinutes: 60 } } }), spec(), { referencePrice: 3000 });
    expect(long.some((i) => i.path === 'execution.exitFeeWaiver.withinMinutes' && i.severity === 'warning')).toBe(true);
  });
});

describe('time limit (none by default) and the dormant Scalper Offer window', () => {
  it('has NO time limit by default and the waiver is off', () => {
    const s = settings();
    expect(s.exits.maxHoldMinutes).toBeNull();
    expect(s.exits.timeExitPolicy).toBe('none');
    expect(s.execution.exitFeeWaiver).toEqual({ enabled: false, withinMinutes: 30, safetyMarginSeconds: 90, clampTimeExit: true });
    expect(effectiveMaxHoldMs(s)).toBe(Infinity);
    expect(effectiveMaxHoldMinutes(s)).toBeNull();
    // JSON snapshots must not carry Infinity
    expect(JSON.parse(JSON.stringify({ m: effectiveMaxHoldMinutes(s) })).m).toBeNull();
  });

  it('a set maxHoldMinutes only applies with a policy other than "none"', () => {
    expect(effectiveMaxHoldMs(settings({ exits: { maxHoldMinutes: 120 } }))).toBe(Infinity);
    expect(effectiveMaxHoldMs(settings({ exits: { maxHoldMinutes: 120, timeExitPolicy: 'close_at_market' } }))).toBe(120 * 60_000);
    expect(effectiveMaxHoldMs(settings({ exits: { maxHoldMinutes: null, timeExitPolicy: 'close_at_market' } }))).toBe(Infinity);
    expect(effectiveMaxHoldMinutes(settings({ exits: { maxHoldMinutes: 90, timeExitPolicy: 'breakeven_then_close' } }))).toBe(90);
  });

  it('waiver ON with a configured limit: 30 min window, 90 s safety margin, time exit clamped to 28.5 min', () => {
    const s = legacySettings();
    expect(s.execution.exitFeeWaiver).toEqual({ enabled: true, withinMinutes: 30, safetyMarginSeconds: 90, clampTimeExit: true });
    expect(effectiveMaxHoldMs(s)).toBe(28.5 * 60_000);
    expect(effectiveMaxHoldMinutes(s)).toBe(28.5);
  });

  it('does not clamp when the waiver is off or clamping is disabled, never extends the configured hold, never goes below 1 minute, never invents a limit', () => {
    expect(effectiveMaxHoldMs(legacySettings({ execution: { exitFeeWaiver: { enabled: false } } }))).toBe(30 * 60_000);
    expect(effectiveMaxHoldMs(legacySettings({ execution: { exitFeeWaiver: { clampTimeExit: false } } }))).toBe(30 * 60_000);
    expect(effectiveMaxHoldMs(legacySettings({ exits: { maxHoldMinutes: 10 } }))).toBe(10 * 60_000);
    expect(effectiveMaxHoldMs(legacySettings({ execution: { exitFeeWaiver: { safetyMarginSeconds: 600, withinMinutes: 5 } } }))).toBe(60_000);
    // explicit override (live fallback to "no waiver") wins over the setting
    expect(effectiveMaxHoldMs(legacySettings(), false)).toBe(30 * 60_000);
    // the waiver clamp shortens an existing limit only: with no limit it stays unlimited
    expect(effectiveMaxHoldMs(settings({ execution: { exitFeeWaiver: { enabled: true } } }))).toBe(Infinity);
    expect(effectiveMaxHoldMs(settings(), true)).toBe(Infinity);
  });

  it('settings validation: the default has no errors and explains the no-time-limit consequence (funding every 8 h) as a warning', () => {
    const v = validateSettings(settings(), spec(), { referencePrice: 3390 });
    expect(hasErrors(v)).toBe(false);
    const w = v.find((i) => i.path === 'exits.maxHoldMinutes');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toMatch(/no time limit/i);
    expect(w?.message).toMatch(/funding/i);
    expect(w?.message).toMatch(/8 hours/);
    // nothing about the 30-minute scalping profile or the dormant waiver
    expect(v.some((i) => /30 minutes|Scalper|waiver/i.test(i.message))).toBe(false);
    expect(v.some((i) => i.path.startsWith('execution.exitFeeWaiver'))).toBe(false);
  });

  it('settings validation (waiver ON): explains the clamp and rejects a break-even time that is not before it', () => {
    const v = validateSettings(legacySettings(), spec(), { referencePrice: 3000 });
    expect(hasErrors(v)).toBe(false);
    expect(v.some((i) => i.path === 'exits.maxHoldMinutes' && /clamped to 28\.5/.test(i.message))).toBe(true);
    expect(v.some((i) => /No time limit/.test(i.message))).toBe(false);
    const bad = validateSettings(legacySettings({ exits: { breakevenAfterMinutes: 29, maxHoldMinutes: 30 } }), spec(), { referencePrice: 3000 });
    expect(hasErrors(bad)).toBe(true);
    // older stored settings without the new keys are completed from defaults
    const legacy = SettingsSchema.parse({ execution: { exitFeeWaiver: { enabled: false, withinMinutes: 30 } } });
    expect(legacy.execution.exitFeeWaiver.safetyMarginSeconds).toBe(90);
    expect(legacy.execution.exitFeeWaiver.enabled).toBe(false);
  });
});

describe('round-trip brokerage, daily outlook and required win rate', () => {
  // ETH 3,390, 0.20 ETH (20 contracts): notional 678; taker 0.05% = 0.339 + 18% GST (0.06102) = 0.40002 per leg
  const rt = (over: Partial<Parameters<typeof roundTripFee>[0]> = {}) => roundTripFee({ price: 3390, contracts: 20, contractValue: 0.01, cfg: cfg(), ...over });

  it('taker/taker round trip at ETH 3,390 is about USD 0.80 including 18% GST', () => {
    const r = rt();
    expect(r.notional).toBeCloseTo(678, 8);
    expect(r.entry).toBeCloseTo(0.40002, 8);
    expect(r.exit).toBeCloseTo(0.40002, 8);
    expect(r.total).toBeCloseTo(0.80004, 8);
    expect(r.total).toBeGreaterThan(0.79);
    expect(r.total).toBeLessThan(0.81);
    // a USD 10 move on 0.20 ETH is USD 2.00 gross, about USD 1.20 net of that brokerage
    expect(2.0 - r.total).toBeCloseTo(1.19996, 8);
  });

  it('follows the fee model instead of a hard-coded number: maker exit, price, and the exchange rates', () => {
    expect(rt({ exitRole: 'maker' }).exit).toBeCloseTo(678 * 0.0002 * 1.18, 8); // 0.160008
    expect(rt({ exitRole: 'maker' }).total).toBeLessThan(rt().total);
    expect(rt({ price: 3500 }).total).toBeCloseTo(0.80004 * (3500 / 3390), 6);
    expect(rt({ cfg: feeConfigFrom(settings({ execution: { takerFeeRate: 0.0003 } }), spec()) }).total).toBeCloseTo(2 * 678 * 0.0003 * 1.18, 8);
    // the waiver is never applied to a round trip, even when it is switched on
    expect(rt({ cfg: waiverCfg() }).total).toBeCloseTo(0.80004, 8);
  });

  it('matches calcPnl for the same USD 10 long (entry 3390, exit 3400, taker/taker)', () => {
    const pnl = calcPnl({ side: 'long', entryPrice: 3390, exitPrice: 3400, contracts: 20, contractValue: 0.01, entryRole: 'taker', exitRole: 'taker', holdMs: 3 * 3_600_000 }, cfg());
    expect(pnl.grossPnl).toBeCloseTo(2.0, 8);
    expect(pnl.exitFee).toBeCloseTo(680 * 0.0005 * 1.18, 8); // paid in full after 3 hours, and equally after 3 minutes
    expect(pnl.netPnl).toBeCloseTo(2.0 - 0.40002 - 0.4012, 8);
    expect(pnl.netPnl).toBeGreaterThan(1.19);
    expect(pnl.netPnl).toBeLessThan(1.21);
  });

  it('dailyOutlook is plain arithmetic on the supplied win rate (a scenario, not a forecast)', () => {
    const win = 2.0 - 0.80004;
    const loss = 1.25 + 0.80004; // stop 6 + 0.25 stop slippage on 0.20 ETH, plus brokerage
    expect(win).toBeCloseTo(1.19996, 8);
    expect(loss).toBeCloseTo(2.05004, 8);
    // 10 trades, 80% wins: 10 * (0.8 * 1.19996 - 0.2 * 2.05004) = 10 * (0.959968 - 0.410008) = 5.4996
    // (about INR 484 at 88: an 80% win rate falls just short of INR 500, see requiredWinRate below)
    const o = dailyOutlook({ trades: 10, winRate: 0.8, winNetUsd: win, lossNetUsd: loss, usdInrRate: 88 });
    expect(o.expectedNetUsd).toBeCloseTo(5.4996, 5);
    expect(o.expectedNetInr).toBeCloseTo(5.4996 * 88, 2);
    expect(o.expectedNetInr).toBeLessThan(500);
    // a lower assumed win rate turns the same day negative: 10 * (0.5 * 1.19996 - 0.5 * 2.05004) = -4.2504
    expect(dailyOutlook({ trades: 10, winRate: 0.5, winNetUsd: win, lossNetUsd: loss, usdInrRate: 88 }).expectedNetUsd).toBeCloseTo(-4.2504, 5);
    // sign of the loss input does not flip the result; out-of-range inputs are clamped
    expect(dailyOutlook({ trades: 10, winRate: 0.8, winNetUsd: win, lossNetUsd: -loss, usdInrRate: 88 })).toEqual(o);
    expect(dailyOutlook({ trades: 0, winRate: 0.8, winNetUsd: win, lossNetUsd: loss, usdInrRate: 88 }).expectedNetUsd).toBe(0);
    expect(dailyOutlook({ trades: 10, winRate: 2, winNetUsd: win, lossNetUsd: loss, usdInrRate: 88 }).expectedNetUsd).toBeCloseTo(10 * win, 5);
  });

  it('requiredWinRate: break-even by default, and the rate needed for INR 500/day over 10 trades at 88 INR/USD', () => {
    const win = 2.0 - 0.80004;
    const loss = 1.25 + 0.80004;
    // break-even: p = loss / (win + loss) = 2.05004 / 3.25 = 0.630782
    expect(requiredWinRate({ winNetUsd: win, lossNetUsd: loss })).toBeCloseTo(2.05004 / 3.25, 8);
    expect(requiredWinRate({ winNetUsd: win, lossNetUsd: loss })).toBeCloseTo(0.6308, 4);
    expect(requiredWinRate({ winNetUsd: win, lossNetUsd: loss, targetNetPerTradeUsd: 0 })).toBeCloseTo(requiredWinRate({ winNetUsd: win, lossNetUsd: loss }), 12);
    // INR 500 / day / 10 trades / 88 = 0.568182 USD per trade: p = (0.568182 + 2.05004) / 3.25 = 0.805606
    const target = 500 / 88 / 10;
    expect(target).toBeCloseTo(0.568182, 6);
    const p = requiredWinRate({ winNetUsd: win, lossNetUsd: loss, targetNetPerTradeUsd: target });
    expect(p).toBeCloseTo((0.568182 + 2.05004) / 3.25, 5);
    expect(p).toBeCloseTo(0.8056, 3);
    // and it round-trips through dailyOutlook: at exactly that rate the day nets the INR 500 goal
    expect(dailyOutlook({ trades: 10, winRate: p, winNetUsd: win, lossNetUsd: loss, usdInrRate: 88 }).expectedNetInr).toBeCloseTo(500, 1);
    // the honest comparison: a driftless walk reaches +10 before -6 only 6 / (10 + 6) = 37.5% of the time
    expect(p).toBeGreaterThan(6 / (10 + 6));
    // a wider stop raises the rate needed (stop 8: loss 1.65 + 0.80004 = 2.45004)
    expect(requiredWinRate({ winNetUsd: win, lossNetUsd: 1.65 + 0.80004, targetNetPerTradeUsd: target })).toBeGreaterThan(p);
  });

  it('requiredWinRate above 1 means the target is out of reach, and degenerate inputs stay finite or Infinity, never NaN', () => {
    expect(requiredWinRate({ winNetUsd: 1, lossNetUsd: 2, targetNetPerTradeUsd: 1.5 })).toBeGreaterThan(1);
    expect(requiredWinRate({ winNetUsd: 1, lossNetUsd: 2, targetNetPerTradeUsd: -100 })).toBe(0);
    expect(requiredWinRate({ winNetUsd: 0, lossNetUsd: 0 })).toBe(Infinity);
  });
});

describe('optional extra tax', () => {
  it('is zero by default and, when configured, is charged on each leg notional and included in the break-even move', () => {
    const base = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker' }, cfg());
    expect(base.tax).toBe(0);
    const taxed = feeConfigFrom(settings({ execution: { otherTaxRate: 0.001 } }), spec());
    const f = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker' }, taxed);
    expect(f.tax).toBeCloseTo(0.6, 8); // 600 notional * 0.1%
    expect(f.total).toBeCloseTo(0.354 + 0.6, 8);
    const e0 = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01 }, cfg());
    const e1 = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01 }, taxed);
    expect(e1.breakevenMoveUsd).toBeGreaterThan(e0.breakevenMoveUsd);
  });
});

describe('settings validation against exchange rules', () => {
  it('accepts the default configuration', () => {
    expect(hasErrors(validateSettings(defaultSettings(), spec(), { referencePrice: 3000 }))).toBe(false);
  });

  it('rejects leverage above the exchange maximum', () => {
    const issues = validateSettings(settings({ position: { leverage: 150 } }), spec({ maxLeverage: 100 }));
    expect(issues.some((i) => i.path === 'position.leverage' && i.severity === 'error')).toBe(true);
  });

  it('rejects quantity that is not a multiple of the contract value', () => {
    const issues = validateSettings(settings({ position: { quantityEth: 0.205 } }), spec());
    expect(issues.some((i) => i.path === 'position.quantityEth' && i.severity === 'error')).toBe(true);
  });

  it('rejects inverted target/stop bands and EMA ordering', () => {
    const issues = validateSettings(settings({ targets: { targetMoveMinUsd: 7, targetMoveMaxUsd: 6 }, strategy: { emaFast: 30 } }), spec());
    expect(issues.filter((i) => i.severity === 'error').length).toBeGreaterThanOrEqual(2);
  });

  it('caps maxTradesPer24h at 10 (hard safety ceiling)', () => {
    expect(() => SettingsSchema.parse({ limits: { maxTradesPer24h: 11 } })).toThrow();
    expect(SettingsSchema.parse({ limits: { maxTradesPer24h: 10 } }).limits.maxTradesPer24h).toBe(10);
  });
});
