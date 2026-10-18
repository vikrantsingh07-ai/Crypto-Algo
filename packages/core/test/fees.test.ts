import { describe, expect, it } from 'vitest';
import { SettingsSchema, calcFee, calcPnl, effectiveMaxHoldMs, estimateEconomics, feeConfigFrom, grossPnl, quantityToContracts, validateSettings, hasErrors, defaultSettings } from '../src';
import { settings, spec } from './helpers';

/** Default config: Delta Scalper Offer assumed (exit fee waived when closed inside 30 minutes). */
const cfg = () => feeConfigFrom(settings(), spec());
/** Same fees with the waiver switched off: both legs are charged. */
const noWaiver = () => feeConfigFrom(settings({ execution: { exitFeeWaiver: { enabled: false } } }), spec());

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

  it('Scalper Offer: closing fee is zero inside the 30-minute window, the opening fee is always charged', () => {
    const exit = (holdMs: number, role: 'maker' | 'taker' = 'taker') =>
      calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role, isExit: true, holdMs }, cfg());
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
    const entry = calcFee({ price: 3000, contracts: 20, contractValue: 0.01, role: 'taker', isExit: false, holdMs: 0 }, cfg());
    expect(entry.waived).toBe(false);
    expect(entry.total).toBeCloseTo(0.354, 8);
    // an exit leg with an unknown hold is never assumed free
    expect(calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true }, cfg()).waived).toBe(false);
  });

  it('the waiver can be switched off (account has not joined the offer): both legs are charged', () => {
    const exit = calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 10 * 60_000 }, noWaiver());
    expect(exit.waived).toBe(false);
    expect(exit.total).toBeGreaterThan(0);
    // live override beats the setting (used when the exchange was seen charging a closing fee)
    const overridden = feeConfigFrom(settings(), spec(), { waiverOverride: false });
    expect(calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 1000 }, overridden).waived).toBe(false);
  });

  it('computes net P&L, INR conversion and funding (no waiver)', () => {
    const r = calcPnl(
      { side: 'long', entryPrice: 3000, exitPrice: 3006, contracts: 20, contractValue: 0.01, entryRole: 'taker', exitRole: 'maker', holdMs: 600_000, funding: -0.01 },
      noWaiver(),
    );
    expect(r.grossPnl).toBeCloseTo(1.2, 8);
    // entry taker 0.354 ; exit maker: 3006*0.2=601.2 * 0.0002 = 0.12024 *1.18 = 0.1418832
    expect(r.entryFee).toBeCloseTo(0.354, 6);
    expect(r.exitFee).toBeCloseTo(0.1418832, 6);
    expect(r.netPnl).toBeCloseTo(1.2 - 0.354 - 0.1418832 - 0.01, 6);
    expect(r.netPnlInr).toBeCloseTo(r.netPnl * 88, 2);
  });

  it('net P&L with the Scalper Offer: only the entry fee is paid when the trade closes inside 30 minutes', () => {
    const base = { side: 'long' as const, entryPrice: 3000, contracts: 20, contractValue: 0.01, entryRole: 'taker' as const, funding: 0 };
    // $4 / $5 / $6 take-profit exits (maker) after 10 minutes: gross 0.80 / 1.00 / 1.20 minus 0.354 entry fee
    for (const [move, gross] of [[4, 0.8], [5, 1.0], [6, 1.2]] as const) {
      const r = calcPnl({ ...base, exitPrice: 3000 + move, exitRole: 'maker', holdMs: 10 * 60_000 }, cfg());
      expect(r.grossPnl).toBeCloseTo(gross, 8);
      expect(r.exitFee).toBe(0);
      expect(r.fees).toBeCloseTo(0.354, 8);
      expect(r.netPnl).toBeCloseTo(gross - 0.354, 8);
    }
    // taker exit inside the window is free too ...
    expect(calcPnl({ ...base, exitPrice: 2997, exitRole: 'taker', holdMs: 20 * 60_000 }, cfg()).exitFee).toBe(0);
    // ... but the same trade closed after 31 minutes pays the normal closing fee
    const late = calcPnl({ ...base, exitPrice: 3004, exitRole: 'taker', holdMs: 31 * 60_000 }, cfg());
    expect(late.exitFee).toBeCloseTo(3004 * 0.2 * 0.0005 * 1.18, 6);
    // exchange-reported fees stay authoritative
    expect(calcPnl({ ...base, exitPrice: 3004, exitRole: 'taker', holdMs: 60_000, actualExitFee: 0.07 }, cfg()).exitFee).toBe(0.07);
  });

  it('shows that taker/taker fees consume most of a $4 target when NO waiver applies (fee drag)', () => {
    const e = estimateEconomics(
      { side: 'long', entryPrice: 3000, targetPrice: 3004, stopPrice: 2996, contracts: 20, contractValue: 0.01, entryRole: 'taker', targetRole: 'taker', stopRole: 'taker' },
      noWaiver(),
    );
    expect(e.rewardGross).toBeCloseTo(0.8, 8);
    expect(e.exitFeeWaived).toBe(false);
    expect(e.rewardNet).toBeLessThan(0.1); // practically no edge after fees
    expect(e.breakevenMoveUsd).toBeGreaterThan(3.5);
    expect(e.netRewardRisk).toBeLessThan(0.1);
  });

  it('with the Scalper Offer a $4 / $5 / $6 target nets gross minus the single entry fee; break-even move shrinks to ~$1.77', () => {
    for (const [move, gross] of [[4, 0.8], [5, 1.0], [6, 1.2]] as const) {
      const e = estimateEconomics(
        { side: 'long', entryPrice: 3000, targetPrice: 3000 + move, stopPrice: 2997, contracts: 20, contractValue: 0.01, entryRole: 'taker', targetRole: 'maker', stopRole: 'taker', stopSlippageUsd: 0.25 },
        cfg(),
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
    // the same trade WITHOUT the waiver nets less and needs a bigger move to break even
    const w = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2997, contracts: 20, contractValue: 0.01 }, cfg());
    const n = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2997, contracts: 20, contractValue: 0.01 }, noWaiver());
    expect(w.rewardNet).toBeGreaterThan(n.rewardNet);
    expect(w.breakevenMoveUsd).toBeLessThan(n.breakevenMoveUsd);
    expect(n.exitFeeSaved).toBe(0);
  });

  it('maker take-profit materially improves net reward when no waiver applies', () => {
    const t = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'taker' }, noWaiver());
    const m = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'maker' }, noWaiver());
    expect(m.rewardNet).toBeGreaterThan(t.rewardNet);
  });

  it('short trades get the same waiver', () => {
    const e = estimateEconomics({ side: 'short', entryPrice: 3000, targetPrice: 2995, stopPrice: 3003, contracts: 20, contractValue: 0.01 }, cfg());
    expect(e.rewardGross).toBeCloseTo(1.0, 8);
    expect(e.rewardNet).toBeCloseTo(1.0 - 0.354, 8);
    expect(e.exitFeeWaived).toBe(true);
  });
});

describe('Scalper Offer exclusions', () => {
  it('never waives a liquidation, and never waives a separately configured transaction tax', () => {
    const exit = { price: 3004, contracts: 20, contractValue: 0.01, role: 'taker' as const, isExit: true, holdMs: 60_000 };
    const liq = calcFee({ ...exit, liquidation: true }, cfg());
    expect(liq.waived).toBe(false);
    expect(liq.total).toBeCloseTo(3004 * 0.2 * 0.0005 * 1.18, 8);
    expect(liq.saved).toBe(0);
    const pnl = calcPnl({ side: 'long', entryPrice: 3000, exitPrice: 2950, contracts: 20, contractValue: 0.01, entryRole: 'taker', exitRole: 'taker', holdMs: 60_000, liquidation: true }, cfg());
    expect(pnl.exitFee).toBeGreaterThan(0);

    const taxed = feeConfigFrom(settings({ execution: { otherTaxRate: 0.001 } }), spec());
    const w = calcFee(exit, taxed);
    expect(w.waived).toBe(true);
    expect(w.commission).toBe(0);
    expect(w.gst).toBe(0);
    expect(w.tax).toBeCloseTo(600.8 * 0.001, 8); // the levy is still charged
    expect(w.total).toBeCloseTo(w.tax, 8);
    expect(w.saved).toBeCloseTo(600.8 * 0.0005 * 1.18, 8); // saved = exchange fee only
  });

  it('settings validation: safety margin must be shorter than the window; a window longer than Delta publishes is flagged', () => {
    const bad = validateSettings(settings({ execution: { exitFeeWaiver: { withinMinutes: 1, safetyMarginSeconds: 90 } }, exits: { maxHoldMinutes: 1, breakevenAfterMinutes: 1 } }), spec(), { referencePrice: 3000 });
    expect(bad.some((i) => i.path === 'execution.exitFeeWaiver.safetyMarginSeconds' && i.severity === 'error')).toBe(true);
    const long = validateSettings(settings({ execution: { exitFeeWaiver: { withinMinutes: 60 } } }), spec(), { referencePrice: 3000 });
    expect(long.some((i) => i.path === 'execution.exitFeeWaiver.withinMinutes' && i.severity === 'warning')).toBe(true);
  });
});

describe('time exit and the Scalper Offer window', () => {
  it('is on by default: 30-minute window, 90 s safety margin, time exit clamped to 28.5 min', () => {
    const s = settings();
    expect(s.execution.exitFeeWaiver).toEqual({ enabled: true, withinMinutes: 30, safetyMarginSeconds: 90, clampTimeExit: true });
    expect(effectiveMaxHoldMs(s)).toBe(28.5 * 60_000);
  });

  it('does not clamp when the waiver is off or clamping is disabled, never extends the configured hold, never goes below 1 minute', () => {
    expect(effectiveMaxHoldMs(settings({ execution: { exitFeeWaiver: { enabled: false } } }))).toBe(30 * 60_000);
    expect(effectiveMaxHoldMs(settings({ execution: { exitFeeWaiver: { clampTimeExit: false } } }))).toBe(30 * 60_000);
    expect(effectiveMaxHoldMs(settings({ exits: { maxHoldMinutes: 10 } }))).toBe(10 * 60_000);
    expect(effectiveMaxHoldMs(settings({ execution: { exitFeeWaiver: { safetyMarginSeconds: 600, withinMinutes: 5 } } }))).toBe(60_000);
    // explicit override (live fallback to "no waiver") wins over the setting
    expect(effectiveMaxHoldMs(settings(), false)).toBe(30 * 60_000);
  });

  it('settings validation explains the clamp and rejects a break-even time that is not before it', () => {
    const v = validateSettings(settings(), spec(), { referencePrice: 3000 });
    expect(hasErrors(v)).toBe(false);
    expect(v.some((i) => i.path === 'exits.maxHoldMinutes' && /clamped to 28\.5/.test(i.message))).toBe(true);
    const bad = validateSettings(settings({ exits: { breakevenAfterMinutes: 29, maxHoldMinutes: 30 } }), spec(), { referencePrice: 3000 });
    expect(hasErrors(bad)).toBe(true);
    // older stored settings without the new keys are completed from defaults
    const legacy = SettingsSchema.parse({ execution: { exitFeeWaiver: { enabled: false, withinMinutes: 30 } } });
    expect(legacy.execution.exitFeeWaiver.safetyMarginSeconds).toBe(90);
    expect(legacy.execution.exitFeeWaiver.enabled).toBe(false);
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
