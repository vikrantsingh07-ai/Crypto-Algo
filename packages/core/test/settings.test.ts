import { describe, expect, it } from 'vitest';
import {
  SETTINGS_VERSION,
  SettingsSchema,
  defaultSettings,
  effectiveMaxHoldMs,
  hasErrors,
  migrateSettings,
  validateSettings,
  waiverGuaranteed,
} from '../src';
import { legacySettings, settings, spec } from './helpers';

/** A settings document as the v1 server stored it: no `version`, the 30 minute / waiver / USD 4-6 defaults, a few custom values. */
const storedV1 = () => ({
  instrument: { symbol: 'ETHUSD' },
  position: { quantityEth: 0.2, leverage: 50, maxOpenPositions: 1 },
  targets: { targetMoveMinUsd: 4, targetMoveMaxUsd: 6, targetAtrMultiple: 3.5, stopLossMinUsd: 3, stopLossMaxUsd: 6, stopLossAtrMultiple: 2.5 },
  exits: { maxHoldMinutes: 30, timeExitPolicy: 'breakeven_then_close', breakevenAfterMinutes: 20, takeProfitOrderType: 'limit' },
  limits: { maxTradesPer24h: 8, perTradeRiskUsd: 3, dailyLossLimitUsd: 6, maxDrawdownPct: 15, maxConsecutiveLosses: 3 },
  filters: { maxSpreadUsd: 0.4 },
  strategy: { emaFast: 12, allowShort: false },
  execution: {
    gstRate: 0.18,
    usdInrRate: 90,
    simSlippageUsd: 0.15,
    exitFeeWaiver: { enabled: true, withinMinutes: 30, safetyMarginSeconds: 45, clampTimeExit: true },
  },
  demo: { startingBalanceUsd: 250 },
  live: { modeSwitchPolicy: 'close_at_market' },
});

describe('new-install defaults (SettingsSchema.parse({}))', () => {
  const d = SettingsSchema.parse({});

  it('is the current version and defaultSettings() agrees', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(d.version).toBe(2);
    expect(defaultSettings()).toEqual(d);
    expect(typeof d.version).toBe('number');
  });

  it('has no time limit, no break-even tightening, and the exit-fee waiver off', () => {
    expect(d.exits.maxHoldMinutes).toBeNull();
    expect(d.exits.timeExitPolicy).toBe('none');
    expect(d.exits.takeProfitOrderType).toBe('limit');
    expect(d.execution.exitFeeWaiver.enabled).toBe(false);
    expect(effectiveMaxHoldMs(d)).toBe(Infinity);
    expect(waiverGuaranteed(d)).toBe(false);
  });

  it('takes a fixed USD 10 move (long or short) with a USD 5-8 stop band on 0.20 ETH at 50x', () => {
    expect(d.targets.targetMoveMinUsd).toBe(10);
    expect(d.targets.targetMoveMaxUsd).toBe(10);
    expect(d.targets.stopLossMinUsd).toBe(5);
    expect(d.targets.stopLossMaxUsd).toBe(8);
    expect(d.position.quantityEth).toBe(0.2);
    expect(d.position.leverage).toBe(50);
  });

  it('carries the display-only daily goal of INR 500 and the unchanged risk gates', () => {
    expect(d.goals.dailyProfitInr).toBe(500);
    expect(d.limits.maxTradesPer24h).toBe(10);
    expect(d.limits.perTradeRiskUsd).toBe(2.5);
    expect(d.limits.dailyLossLimitUsd).toBe(6);
    expect(d.limits.maxConsecutiveLosses).toBe(3);
    expect(d.limits.maxDrawdownPct).toBe(15);
    expect(d.execution.usdInrRate).toBe(88);
    expect(() => SettingsSchema.parse({ goals: { dailyProfitInr: -1 } })).toThrow();
    expect(SettingsSchema.parse({ goals: { dailyProfitInr: 0 } }).goals.dailyProfitInr).toBe(0);
  });

  it('keeps the 10 trades / 24h hard ceiling', () => {
    expect(() => SettingsSchema.parse({ limits: { maxTradesPer24h: 11 } })).toThrow();
  });

  it('accepts a null or a numeric time limit and the three policies; rejects nonsense', () => {
    expect(SettingsSchema.parse({ exits: { maxHoldMinutes: null } }).exits.maxHoldMinutes).toBeNull();
    expect(SettingsSchema.parse({ exits: { maxHoldMinutes: 180, timeExitPolicy: 'close_at_market' } }).exits.maxHoldMinutes).toBe(180);
    for (const p of ['none', 'close_at_market', 'breakeven_then_close']) expect(SettingsSchema.parse({ exits: { timeExitPolicy: p } }).exits.timeExitPolicy).toBe(p);
    expect(() => SettingsSchema.parse({ exits: { timeExitPolicy: 'sometimes' } })).toThrow();
    expect(() => SettingsSchema.parse({ exits: { maxHoldMinutes: 0 } })).toThrow();
  });

  it('does not migrate by itself: a partial document keeps exactly what it states', () => {
    const partial = SettingsSchema.parse({ targets: { targetMoveMinUsd: 4, targetMoveMaxUsd: 6 }, execution: { exitFeeWaiver: { enabled: true } } });
    expect(partial.targets.targetMoveMinUsd).toBe(4);
    expect(partial.targets.targetMoveMaxUsd).toBe(6);
    expect(partial.execution.exitFeeWaiver.enabled).toBe(true);
  });
});

describe('migrateSettings (v1 -> v2)', () => {
  it('moves a stored v1 document to the new defaults and keeps every other stored value', () => {
    const m = migrateSettings(storedV1()) as ReturnType<typeof storedV1> & { version: number; goals: unknown };
    // changed
    expect(m.version).toBe(2);
    expect(m.exits.maxHoldMinutes).toBeNull();
    expect(m.exits.timeExitPolicy).toBe('none');
    expect(m.execution.exitFeeWaiver.enabled).toBe(false);
    expect(m.targets.targetMoveMinUsd).toBe(10);
    expect(m.targets.targetMoveMaxUsd).toBe(10);
    expect(m.targets.stopLossMinUsd).toBe(5);
    expect(m.targets.stopLossMaxUsd).toBe(8);
    expect(m.goals).toEqual({ dailyProfitInr: 500 });
    // kept, including the customised ones
    expect(m.execution.usdInrRate).toBe(90);
    expect(m.execution.simSlippageUsd).toBe(0.15);
    expect(m.execution.exitFeeWaiver.safetyMarginSeconds).toBe(45);
    expect(m.execution.exitFeeWaiver.withinMinutes).toBe(30);
    expect(m.targets.targetAtrMultiple).toBe(3.5);
    expect(m.targets.stopLossAtrMultiple).toBe(2.5);
    expect(m.exits.breakevenAfterMinutes).toBe(20);
    expect(m.exits.takeProfitOrderType).toBe('limit');
    expect(m.limits).toEqual(storedV1().limits);
    expect(m.filters).toEqual({ maxSpreadUsd: 0.4 });
    expect(m.strategy).toEqual({ emaFast: 12, allowShort: false });
    expect(m.position).toEqual(storedV1().position);
    expect(m.demo).toEqual({ startingBalanceUsd: 250 });
    expect(m.live).toEqual({ modeSwitchPolicy: 'close_at_market' });
    expect(m.instrument).toEqual({ symbol: 'ETHUSD' });
  });

  it('is pure: the stored document is not modified', () => {
    const raw = storedV1();
    const before = JSON.stringify(raw);
    migrateSettings(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is idempotent: migrate(migrate(x)) equals migrate(x)', () => {
    const once = migrateSettings(storedV1());
    const twice = migrateSettings(once);
    expect(twice).toEqual(once);
    expect(migrateSettings(twice)).toEqual(once);
    // also for a minimal and an empty v1 document
    for (const raw of [{}, { exits: { maxHoldMinutes: 15 } }, { version: 1 }, { version: 0 }]) {
      const m = migrateSettings(raw);
      expect(migrateSettings(m)).toEqual(m);
    }
  });

  it('parses into a valid current-version Settings object', () => {
    const parsed = SettingsSchema.parse(migrateSettings(storedV1()));
    expect(parsed.version).toBe(2);
    expect(parsed.exits.maxHoldMinutes).toBeNull();
    expect(parsed.execution.exitFeeWaiver.enabled).toBe(false);
    expect(parsed.execution.usdInrRate).toBe(90);
    expect(parsed.limits.maxTradesPer24h).toBe(8);
    expect(effectiveMaxHoldMs(parsed)).toBe(Infinity);
    expect(hasErrors(validateSettings(parsed, spec(), { referencePrice: 3390 }))).toBe(false);
  });

  it('handles an empty or partial v1 document by filling the new defaults', () => {
    const m = SettingsSchema.parse(migrateSettings({}));
    expect(m).toEqual(defaultSettings());
    const partial = SettingsSchema.parse(migrateSettings({ exits: { maxHoldMinutes: 15, timeExitPolicy: 'close_at_market' } }));
    expect(partial.exits.maxHoldMinutes).toBeNull();
    expect(partial.exits.timeExitPolicy).toBe('none');
  });

  it('leaves a document that is already at the current version untouched (including a time limit set on purpose)', () => {
    const v2 = { ...defaultSettings(), exits: { ...defaultSettings().exits, maxHoldMinutes: 90, timeExitPolicy: 'close_at_market' }, targets: { ...defaultSettings().targets, targetMoveMinUsd: 8, targetMoveMaxUsd: 12 } };
    const m = migrateSettings(v2);
    expect(m).toBe(v2);
    expect(SettingsSchema.parse(m).exits.maxHoldMinutes).toBe(90);
    expect(SettingsSchema.parse(m).targets.targetMoveMaxUsd).toBe(12);
    // a version above the current one is also left alone
    expect(migrateSettings({ version: 3, exits: { maxHoldMinutes: 5 } })).toEqual({ version: 3, exits: { maxHoldMinutes: 5 } });
  });

  it('passes non-objects through unchanged', () => {
    expect(migrateSettings(null)).toBeNull();
    expect(migrateSettings(undefined)).toBeUndefined();
    expect(migrateSettings('x')).toBe('x');
    expect(migrateSettings([1])).toEqual([1]);
  });

  it('treats a non-numeric version as a pre-v2 document', () => {
    const m = migrateSettings({ version: '1', exits: { maxHoldMinutes: 30 } }) as { version: number; exits: { maxHoldMinutes: number | null } };
    expect(m.version).toBe(2);
    expect(m.exits.maxHoldMinutes).toBeNull();
  });
});

describe('validateSettings for the no-time-limit setup', () => {
  const codes = (s = settings(), ref: number | null = 3390) => validateSettings(s, spec(), { referencePrice: ref });
  const find = (issues: ReturnType<typeof codes>, path: string) => issues.filter((i) => i.path === path);

  it('defaults: no errors, one warning that explains funding, and nothing about the waiver or 30 minutes', () => {
    const v = codes();
    expect(hasErrors(v)).toBe(false);
    const w = find(v, 'exits.maxHoldMinutes');
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('warning');
    expect(w[0].message).toMatch(/funding/i);
    expect(v.filter((i) => i.path.startsWith('execution.exitFeeWaiver'))).toEqual([]);
    expect(v.some((i) => /30[- ]min/i.test(i.message))).toBe(false);
  });

  it('the no-limit warning goes away when a real time limit is configured', () => {
    const v = codes(settings({ exits: { timeExitPolicy: 'close_at_market', maxHoldMinutes: 240 } }));
    expect(find(v, 'exits.maxHoldMinutes')).toEqual([]);
    expect(hasErrors(v)).toBe(false);
  });

  it('a limit left over under the policy "none" is called out as ignored; close_at_market without a limit does nothing', () => {
    const ignored = find(codes(settings({ exits: { maxHoldMinutes: 120 } })), 'exits.timeExitPolicy');
    expect(ignored).toHaveLength(1);
    expect(ignored[0].message).toMatch(/ignored/);
    const idle = find(codes(settings({ exits: { timeExitPolicy: 'close_at_market' } })), 'exits.timeExitPolicy');
    expect(idle).toHaveLength(1);
    expect(idle[0].severity).toBe('warning');
  });

  it('the break-even time is compared with the maximum hold only when both apply', () => {
    // break-even policy without a limit: fine, however late the break-even time is
    expect(hasErrors(codes(settings({ exits: { timeExitPolicy: 'breakeven_then_close', breakevenAfterMinutes: 600 } })))).toBe(false);
    // both apply and break-even is not earlier: error
    expect(hasErrors(codes(settings({ exits: { timeExitPolicy: 'breakeven_then_close', maxHoldMinutes: 60, breakevenAfterMinutes: 60 } })))).toBe(true);
    expect(hasErrors(codes(settings({ exits: { timeExitPolicy: 'breakeven_then_close', maxHoldMinutes: 60, breakevenAfterMinutes: 59 } })))).toBe(false);
    // the other policies never compare them
    expect(hasErrors(codes(settings({ exits: { timeExitPolicy: 'close_at_market', maxHoldMinutes: 10, breakevenAfterMinutes: 100 } })))).toBe(false);
    expect(hasErrors(codes(settings({ exits: { timeExitPolicy: 'none', maxHoldMinutes: 10, breakevenAfterMinutes: 100 } })))).toBe(false);
  });

  it('warns (not errors) when the stop band can lose more than the per-trade limit', () => {
    // default: stop 8 -> (8 + 0.1 + 0.25) * 0.2 = 1.67 + ~0.80 brokerage = ~2.47, inside 2.5 at ETH 3,390
    expect(find(codes(), 'limits.perTradeRiskUsd')).toEqual([]);
    // a tighter limit trips it, with brokerage included in the figure
    const tight = find(codes(settings({ limits: { perTradeRiskUsd: 2 } })), 'limits.perTradeRiskUsd');
    expect(tight).toHaveLength(1);
    expect(tight[0].severity).toBe('warning');
    expect(tight[0].message).toMatch(/brokerage/);
    expect(tight[0].message).toMatch(/\$2\.4\d/);
    // so does a higher price (fees scale with the notional) or a wider stop
    expect(find(codes(settings(), 3700), 'limits.perTradeRiskUsd')).toHaveLength(1);
    expect(find(codes(settings({ targets: { stopLossMaxUsd: 12 } })), 'limits.perTradeRiskUsd')).toHaveLength(1);
    // without a reference price only the stop and slippage are known, and the message says so
    const noPx = find(codes(settings({ limits: { perTradeRiskUsd: 1.5 } }), null), 'limits.perTradeRiskUsd');
    expect(noPx).toHaveLength(1);
    expect(noPx[0].message).toMatch(/before brokerage/);
    expect(hasErrors(codes(settings({ limits: { perTradeRiskUsd: 1 } })))).toBe(false);
  });

  it('the waiver rules apply only while the waiver is enabled', () => {
    // disabled: odd waiver parameters are irrelevant
    const off = codes(settings({ execution: { exitFeeWaiver: { withinMinutes: 1, safetyMarginSeconds: 90 } } }));
    expect(find(off, 'execution.exitFeeWaiver.safetyMarginSeconds')).toEqual([]);
    expect(hasErrors(off)).toBe(false);
    // enabled with no time limit: warned that the estimates keep full fees
    const unlimited = find(codes(settings({ execution: { exitFeeWaiver: { enabled: true } } })), 'execution.exitFeeWaiver.enabled');
    expect(unlimited).toHaveLength(1);
    expect(unlimited[0].severity).toBe('warning');
    // enabled with a limit: the clamp is explained
    const clamped = codes(legacySettings());
    expect(clamped.some((i) => i.path === 'exits.maxHoldMinutes' && /clamped to 28\.5/.test(i.message))).toBe(true);
    // enabled and misconfigured: errors as before
    expect(hasErrors(codes(legacySettings({ execution: { exitFeeWaiver: { withinMinutes: 1, safetyMarginSeconds: 90 } } })))).toBe(true);
  });
});

describe('waiverGuaranteed (when the dormant waiver may be assumed in estimates)', () => {
  it('needs the waiver on AND a time exit inside its window', () => {
    expect(waiverGuaranteed(settings())).toBe(false);
    expect(waiverGuaranteed(settings({ execution: { exitFeeWaiver: { enabled: true } } }))).toBe(false); // no time limit
    expect(waiverGuaranteed(legacySettings())).toBe(true);
    expect(waiverGuaranteed(legacySettings({ execution: { exitFeeWaiver: { enabled: false } } }))).toBe(false);
    expect(waiverGuaranteed(legacySettings({ exits: { maxHoldMinutes: 120 } }))).toBe(true); // clamped to 28.5 min
    expect(waiverGuaranteed(legacySettings({ exits: { maxHoldMinutes: 120 }, execution: { exitFeeWaiver: { clampTimeExit: false } } }))).toBe(false);
    expect(waiverGuaranteed(legacySettings({ exits: { timeExitPolicy: 'none' } }))).toBe(false);
  });
});
