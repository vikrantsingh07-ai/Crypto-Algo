import { effectiveMaxHoldMs, type Settings } from '@cryptoalgo/core';

/**
 * The time limit of a position in minutes, or null when there is none (the default). Never Infinity or NaN, so the
 * value can go straight into a JSON snapshot. `waiverOn` is the same fee view the caller prices with.
 */
export function maxHoldMinutesOrNull(settings: Settings, waiverOn: boolean): number | null {
  const ms = effectiveMaxHoldMs(settings, waiverOn);
  return Number.isFinite(ms) ? ms / 60_000 : null;
}
