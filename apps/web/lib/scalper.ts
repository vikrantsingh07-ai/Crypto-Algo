import { duration } from './format';
import type { BotState, ScalperStatus } from './types';

/**
 * Delta "Scalper Offer": a position closed within the window (30 min for BTCUSD/ETHUSD futures) pays NO closing
 * fee, only the opening fee. The offer cannot be read through the Delta API, so Demo / backtests / pre-trade
 * economics ASSUME it while settings.execution.exitFeeWaiver.enabled, and Live P&L always uses the commission the
 * exchange reports. Terms below are as supplied by the operator, not verified against Delta.
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
  /** Settings switch (the assumption). */
  assumed: boolean;
  /** Whether the waiver is applied to the numbers on this side (Live drops it once the exchange shows fees charged). */
  effective: boolean;
  windowMin: number;
  marginSec: number;
  /** Time-exit limit in minutes, clamped to window - margin while the waiver is applied. */
  effectiveMaxHoldMin: number;
  configuredMaxHoldMin: number;
  clamped: boolean;
}

/** Mirrors core's effectiveMaxHoldMs for servers that do not send it; the server's number wins when present. */
export function effectiveMaxHoldMinutes(s: { exits: { maxHoldMinutes: number }; execution: { exitFeeWaiver?: Partial<WaiverSettings> } }, waiverOn: boolean = !!s.execution.exitFeeWaiver?.enabled): number {
  const w = waiverSettings(s.execution.exitFeeWaiver);
  const hold = s.exits.maxHoldMinutes;
  if (!waiverOn || !w.clampTimeExit) return hold;
  return Math.max(1, Math.min(hold, w.withinMinutes - w.safetyMarginSeconds / 60));
}

interface WaiverSettings { enabled: boolean; withinMinutes: number; safetyMarginSeconds: number; clampTimeExit: boolean }
/** Settings from a server that predates some waiver fields still render: missing fields take the documented defaults. */
export function waiverSettings(w?: Partial<WaiverSettings>): WaiverSettings {
  return { enabled: w?.enabled ?? false, withinMinutes: w?.withinMinutes ?? 30, safetyMarginSeconds: w?.safetyMarginSeconds ?? 90, clampTimeExit: w?.clampTimeExit ?? true };
}

export function scalperView(state: BotState, side: 'demo' | 'live'): ScalperView {
  const w = waiverSettings(state.settings.execution.exitFeeWaiver);
  const configured = state.settings.exits.maxHoldMinutes;
  const e = state.economics?.scalper;
  const l = state.live.scalper;
  const assumed = (side === 'live' ? l?.assumed : e?.assumed) ?? e?.assumed ?? w.enabled;
  const effective = side === 'live' ? (l?.effective ?? e?.liveEffective ?? assumed) : (e?.effective ?? assumed);
  const fromServer = side === 'live' ? l?.effectiveMaxHoldMinutes : e?.effectiveMaxHoldMinutes;
  const effectiveMaxHoldMin = fromServer ?? effectiveMaxHoldMinutes(state.settings, effective);
  return {
    assumed,
    effective,
    windowMin: (side === 'live' ? l?.windowMinutes : e?.windowMinutes) ?? w.withinMinutes,
    marginSec: (side === 'live' ? l?.safetyMarginSeconds : e?.safetyMarginSeconds) ?? w.safetyMarginSeconds,
    effectiveMaxHoldMin,
    configuredMaxHoldMin: configured,
    clamped: effectiveMaxHoldMin < configured - 1e-9,
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
