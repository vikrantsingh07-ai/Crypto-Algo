import { round } from '@cryptoalgo/core';

/** India Standard Time, UTC+5:30 (no daylight saving). The operator's "today" is an IST calendar day. */
export const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;

/** Epoch ms of 00:00 IST of the IST calendar day that contains `ts`. */
export function istDayStart(ts: number): number {
  return Math.floor((ts + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** "YYYY-MM-DD" of the IST calendar day that contains `ts`. */
export function istDayLabel(ts: number): string {
  return new Date(istDayStart(ts) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The few fields of a closed trade that the daily summary needs. */
export interface DayTrade {
  exitTs: number;
  netPnl: number;
  netPnlInr: number;
  fees: number;
}

/** `state.demo.today`: the simulated account's results for the current IST day. */
export interface DemoToday {
  /** IST calendar day, "YYYY-MM-DD". */
  day: string;
  /** Trades closed today. */
  trades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  netPnlInr: number;
  feesUsd: number;
  /** The daily goal in INR from the settings. A goal only; nothing in the bot trades towards it. */
  goalInr: number;
  /** Ceiling of new trades per rolling 24h from the settings. */
  tradesLimit: number;
}

/** Summarise the trades closed on the IST day of `now`. Pass the CURRENT demo epoch's trades only. */
export function summariseToday(trades: readonly DayTrade[], now: number, goalInr: number, tradesLimit: number): DemoToday {
  const from = istDayStart(now);
  const to = from + DAY_MS;
  let n = 0;
  let wins = 0;
  let losses = 0;
  let usd = 0;
  let inr = 0;
  let fees = 0;
  for (const t of trades) {
    if (t.exitTs < from || t.exitTs >= to) continue;
    n++;
    if (t.netPnl > 0) wins++;
    else if (t.netPnl < 0) losses++;
    usd += t.netPnl;
    inr += t.netPnlInr;
    fees += t.fees;
  }
  return { day: istDayLabel(now), trades: n, wins, losses, netPnlUsd: round(usd, 4), netPnlInr: round(inr, 4), feesUsd: round(fees, 4), goalInr, tradesLimit };
}
