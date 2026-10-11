/**
 * Keep the splits table current for the Signal Trader universe.
 *
 * The engine restates open positions on a split (engine.ts), but only for
 * splits in the `splits` table, and nothing scheduled used to fill it: only the
 * manual `npm run splits`. A split it missed would read as a gap through the
 * stop and book a permanent fake loss. So the job fetches recent splits itself
 * before every run, and a failed fetch fails the run (the retry tries again)
 * rather than trading on a stale table.
 */
import { splitsSince, type PolygonSplit } from "../polygon";
import { upsertSplits } from "../db";
import { isoDaysAgo } from "../dates";
import type { Split } from "../splits";
import { ST_CONFIG } from "./config";

/** Look back far enough to cover a missed week of runs; Polygon also lists announced future splits. */
export const SPLIT_LOOKBACK_DAYS = 60;

export function universeSplits(raw: readonly PolygonSplit[], universe: readonly string[]): Split[] {
  const wanted = new Set(universe);
  const byKey = new Map<string, Split>();
  for (const r of raw) {
    if (!wanted.has(r.ticker)) continue;
    byKey.set(`${r.ticker}|${r.execution_date}`, {
      ticker: r.ticker,
      executionDate: r.execution_date,
      from: Number(r.split_from),
      to: Number(r.split_to),
    });
  }
  return [...byKey.values()];
}

export async function refreshUniverseSplits(): Promise<number> {
  const rows = universeSplits(await splitsSince(isoDaysAgo(SPLIT_LOOKBACK_DAYS)), ST_CONFIG.universe);
  return upsertSplits(rows);
}
