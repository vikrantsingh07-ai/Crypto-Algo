import { describe, expect, it } from 'vitest';
import { computeDomain, niceStep, spreadLabels, timeStepMinutes, yTicks } from './chartMath';
import { fmtAge, fmtPct, fmtPrice, fmtSize, prettySymbol } from './format';

const cd = (l: number, h: number) => ({ t: 0, o: l, h, l, c: h, v: 0 });

describe('chart math', () => {
  it('niceStep', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3.7)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
  });

  it('domain covers candles and extras, with padding, on a grid', () => {
    const d = computeDomain([cd(3380, 3392), cd(3384, 3396)], [3375, 3400, null, NaN]);
    expect(d).not.toBeNull();
    expect(d!.min).toBeLessThanOrEqual(3375);
    expect(d!.max).toBeGreaterThanOrEqual(3400);
    expect(d!.max - d!.min).toBeLessThan(60);
  });

  it('domain is stable under tiny tick moves (so memoised paths are not rebuilt every frame)', () => {
    const base = [cd(3380, 3392), cd(3384, 3396)];
    const a = computeDomain(base, [3390.05]);
    const b = computeDomain(base, [3390.1]);
    expect(a).toEqual(b);
  });

  it('flat or empty input still gives a usable domain / null', () => {
    const flat = computeDomain([cd(3390, 3390)]);
    expect(flat!.max).toBeGreaterThan(flat!.min);
    expect(computeDomain([])).toBeNull();
    expect(computeDomain([], [3390])!.max).toBeGreaterThan(3390);
  });

  it('ticks lie inside the domain', () => {
    const d = { min: 3372, max: 3404 };
    const t = yTicks(d);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.every((v) => v >= d.min && v <= d.max)).toBe(true);
  });

  it('time labels are spaced by at least the minimum pixel gap', () => {
    expect(timeStepMinutes(6)).toBe(15);
    expect(timeStepMinutes(20)).toBe(5);
    expect(timeStepMinutes(0.1)).toBe(360);
  });

  it('labels never overlap and stay in range', () => {
    const out = spreadLabels([100, 104, 106, 200], 14, 10, 220);
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(14);
    expect(spreadLabels([215, 218], 14, 10, 220).every((y) => y <= 220 && y >= 10)).toBe(true);
  });
});

describe('formatting', () => {
  it('never prints NaN', () => {
    for (const f of [fmtPrice, fmtSize, fmtPct]) {
      expect(f(null)).toBe('—');
      expect(f(undefined)).toBe('—');
      expect(f(NaN)).toBe('—');
      expect(f(Infinity)).toBe('—');
    }
  });
  it('prices, sizes, percentages', () => {
    expect(fmtPrice(3390.4)).toBe('3,390.40');
    expect(fmtSize(12.345)).toBe('12.35');
    expect(fmtSize(123.45)).toBe('123.5');
    expect(fmtSize(1234)).toBe('1.2k');
    expect(fmtSize(25000)).toBe('25k');
    expect(fmtPct(0.456)).toBe('+0.46%');
    expect(fmtPct(-0.456)).toBe('−0.46%');
    expect(fmtPct(0.001)).toBe('0.00%');
  });
  it('ages and symbols', () => {
    expect(fmtAge(12_400)).toBe('12s');
    expect(fmtAge(185_000)).toBe('3m 05s');
    expect(prettySymbol('ETHUSD')).toBe('ETH / USD');
    expect(prettySymbol('WEIRD')).toBe('WEIRD');
  });
});
