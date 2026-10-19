import { duration } from './format';
import type { BotState, ScalperStatus } from './types';

/**
 * Delta "Scalper Offer": a position closed within the window (30 min for BTCUSD/ETHUSD futures) pays NO closing
 * fee, only the opening fee. It is DORMANT and OFF by default (settings.execution.exitFeeWaiver.enabled = false):
 * brokerage is paid on both legs and positions have no time limit. Nothing here is shown to the user unless the
 * switch is turned on in the developer view. The offer cannot be read through the Delta API, so while it is on
 * Demo / backtests / pre-trade economics assume it, and Live P&L always uses the commission the exchange reports.
 * Terms below are as supplied by the operator, not verified against Delta.
 */
export const DIWALI_NOTE =
  'The separate “Diwali Scalper Offer” (opening fee returned as a Fee Voucher; BTCUSD only; from 25 Sep 2026; capped at $100 per user per month) does not apply to this ETHUSD bot and is not modelled.';

export const OFFER_TERMS: string[] = [
  'Close within 30 minutes (BTCUSD and ETHUSD; 15 minutes for other futures) and Delta charges no closing fee on eligible trades. The opening fee is still paid.',
  'Your Delta account must have joined the offer; trades taken before joining are not eligible, and it cannot be deactivated once activated.',
  'Liquidations are not eligible. Partially closed positions are eligible. Not available to internal, corporate, RMM/MM/KOL or other fixed-fee accounts.',
  'Delta may change or end the offer without notice. It is not visible through the Delta API, so the bot cannot confirm it up front.',
];

export interface ScalperView {
  /** Settings switch (the assumption). Off by default. */
  assumed: boolean;
  /** Whether the waiver is applied to the numbers on this side (Live drops it once the exchange shows fees charged). */
  effective: boolean;
  windowMin: number;
  marginSec: number;
  /** Time-exit limit in minutes (clamped to window - margin while the waiver is applied); null = NO time limit. */
  effectiveMaxHoldMin: number | null;
  /** exits.maxHoldMinutes as configured; null = no limit. */
  configuredMaxHoldMin: number | null;
  /** True when a time limit exists (the default is none). */
  hasTimeLimit: boolean;
  clamped: boolean;
}

interface HoldSettings { exits: { maxHoldMinutes?: number | null; timeExitPolicy?: string }; execution: { exitFeeWaiver?: Partial<WaiverSettings> } }

/**
 * Mirrors core's effectiveMaxHoldMinutes for servers that do not send it; the server's number wins when present.
 * null = no time limit: nothing is set, or the policy is "none" (a stored limit is then ignored by the bot).
 */
export function effectiveMaxHoldMinutes(s: HoldSettings, waiverOn: boolean = !!s.execution.exitFeeWaiver?.enabled): number | null {
  const hold = s.exits.maxHoldMinutes;
  if (hold === null || hold === undefined || !Number.isFinite(hold) || s.exits.timeExitPolicy === 'none') return null;
  const w = waiverSettings(s.execution.exitFeeWaiver);
  if (!waiverOn || !w.clampTimeExit) return hold;
  return Math.max(1, Math.min(hold, w.withinMinutes - w.safetyMarginSeconds / 60));
}

interface WaiverSettings { enabled: boolean; withinMinutes: number; safetyMarginSeconds: number; clampTimeExit: boolean }
/** Settings from a server that predates some waiver fields still render: missing fields take the documented defaults. */
export function waiverSettings(w?: Partial<WaiverSettings>): WaiverSettings {
  return { enabled: w?.enabled ?? false, withinMinutes: w?.withinMinutes ?? 30, safetyMarginSeconds: w?.safetyMarginSeconds ?? 90, clampTimeExit: w?.clampTimeExit ?? true };
}

/** A number or null; undefined (field missing on an older backend) and NaN/Infinity count as "no limit". */
const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function scalperView(state: BotState, side: 'demo' | 'live'): ScalperView {
  const w = waiverSettings(state.settings.execution.exitFeeWaiver);
  const configured = finiteOrNull(state.settings.exits.maxHoldMinutes);
  const e = state.economics?.scalper;
  const l = state.live.scalper;
  const assumed = (side === 'live' ? l?.assumed : e?.assumed) ?? e?.assumed ?? w.enabled;
  const effective = side === 'live' ? (l?.effective ?? e?.liveEffective ?? assumed) : (e?.effective ?? assumed);
  const fromServer = side === 'live' ? l?.effectiveMaxHoldMinutes : e?.effectiveMaxHoldMinutes;
  // `undefined` = the server did not say (older backend): work it out; an explicit null from the server = no limit.
  const effectiveMaxHoldMin = fromServer === undefined ? effectiveMaxHoldMinutes(state.settings, effective) : finiteOrNull(fromServer);
  return {
    assumed,
    effective,
    windowMin: (side === 'live' ? l?.windowMinutes : e?.windowMinutes) ?? w.withinMinutes,
    marginSec: (side === 'live' ? l?.safetyMarginSeconds : e?.safetyMarginSeconds) ?? w.safetyMarginSeconds,
    effectiveMaxHoldMin,
    configuredMaxHoldMin: configured,
    hasTimeLimit: effectiveMaxHoldMin !== null,
    clamped: effectiveMaxHoldMin !== null && configured !== null && effectiveMaxHoldMin < configured - 1e-9,
  };
}

/** Minutes as the user thinks of them: 28.5, 30, 12. */
export const minutes = (m: number): string => `${Number.isInteger(m) ? m : +m.toFixed(1)} min`;

/** mm:ss countdown (falls back to the long form past an hour). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return duration(ms);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** HH:MM clock time in the viewer's timezone (floored to the minute, so it never overstates the window). */
export const clockHm = (ts: number): string => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export type WindowTone = 'ok' | 'warn' | 'crit';
/** The window is "nearly gone" for the last 3 minutes; the bot's own time exit fires 90 s before it ends. */
export const NEARLY_GONE_MS = 3 * 60_000;

export function feeWindow(entryTs: number, windowMin: number, now: number): { endsAt: number; remainingMs: number; tone: WindowTone } {
  const endsAt = entryTs + windowMin * 60_000;
  const remainingMs = endsAt - now;
  return { endsAt, remainingMs, tone: remainingMs <= 0 ? 'crit' : remainingMs <= NEARLY_GONE_MS ? 'warn' : 'ok' };
}

export const STATUS_TEXT: Record<ScalperStatus, string> = {
  unverified: 'Assumed — unverified',
  confirmed: 'Confirmed',
  not_applied: 'NOT APPLIED — closing fees are being charged, using full-fee economics',
};
