import { describe, expect, it } from 'vitest';
import { SettingsSchema, calcFee, calcPnl, estimateEconomics, feeConfigFrom, grossPnl, quantityToContracts, validateSettings, hasErrors, defaultSettings } from '../src';
import { settings, spec } from './helpers';

const cfg = () => feeConfigFrom(settings(), spec());

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

  it('never assumes an exit-fee waiver unless explicitly enabled', () => {
    const exit = calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 10 * 60_000 }, cfg());
    expect(exit.waived).toBe(false);
    expect(exit.total).toBeGreaterThan(0);

    const waiverCfg = feeConfigFrom(settings({ execution: { exitFeeWaiver: { enabled: true, withinMinutes: 30 } } }), spec());
    const waived = calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 10 * 60_000 }, waiverCfg);
    expect(waived.waived).toBe(true);
    expect(waived.total).toBe(0);
    const late = calcFee({ price: 3004, contracts: 20, contractValue: 0.01, role: 'taker', isExit: true, holdMs: 31 * 60_000 }, waiverCfg);
    expect(late.waived).toBe(false);
  });

  it('computes net P&L, INR conversion and funding', () => {
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

  it('shows that taker/taker fees consume most of a $4 target (fee drag)', () => {
    const e = estimateEconomics(
      { side: 'long', entryPrice: 3000, targetPrice: 3004, stopPrice: 2996, contracts: 20, contractValue: 0.01, entryRole: 'taker', targetRole: 'taker', stopRole: 'taker' },
      cfg(),
    );
    expect(e.rewardGross).toBeCloseTo(0.8, 8);
    expect(e.rewardNet).toBeLessThan(0.1); // practically no edge after fees
    expect(e.breakevenMoveUsd).toBeGreaterThan(3.5);
    expect(e.netRewardRisk).toBeLessThan(0.1);
  });

  it('maker take-profit materially improves net reward', () => {
    const t = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'taker' }, cfg());
    const m = estimateEconomics({ side: 'long', entryPrice: 3000, targetPrice: 3005, stopPrice: 2996, contracts: 20, contractValue: 0.01, targetRole: 'maker' }, cfg());
    expect(m.rewardNet).toBeGreaterThan(t.rewardNet);
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
