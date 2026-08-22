/**
 * Tier-history summaries for the page. (METRICS_SPEC 3.5)
 *
 * Turnover and time-in-tier only become meaningful after several nights of
 * recorded screens. Until then every figure is null and the UI says why rather
 * than rendering a confident zero -- an empty history is not a stable book.
 */

import {
  annualisedTurnover,
  tierTransitions,
  timeInTier,
  type TierRecord,
  type Transition,
} from "./portfolio-risk";

/** Recorded sessions to summarise. */
export const HISTORY_WINDOW = 30;

export interface TierHistorySummary {
  /** How many distinct sessions have been recorded. */
  readonly sessions: number;
  /** Recent moves, newest first. */
  readonly transitions: readonly Transition[];
  /** Tier changes per position per year, or null below two sessions. */
  readonly turnover: number | null;
  /** Median consecutive sessions a name has held its current tier. */
  readonly medianTimeInTier: number | null;
  /** Names oscillating fastest, which is a signal-quality problem. */
  readonly leastStable: readonly { ticker: string; sessions: number }[];
}

const EMPTY: TierHistorySummary = {
  sessions: 0,
  transitions: [],
  turnover: null,
  medianTimeInTier: null,
  leastStable: [],
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summariseTierHistory(records: readonly TierRecord[]): TierHistorySummary {
  const sessions = new Set(records.map((r) => r.session)).size;
  if (sessions === 0) return EMPTY;

  const transitions = [...tierTransitions(records)].reverse();
  const held = timeInTier(records);

  // Only names still on the screen are ranked for stability; a departed name's
  // final streak says nothing about how noisy the ruleset is now.
  const latest = records.filter((r) => r.session === [...new Set(records.map((x) => x.session))].sort().at(-1));
  const current = new Set(latest.filter((r) => r.tier != null).map((r) => r.ticker));

  const streaks = [...held.entries()].filter(([t]) => current.has(t));
  const leastStable = streaks
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([ticker, s]) => ({ ticker, sessions: s }));

  return {
    sessions,
    transitions: transitions.slice(0, 20),
    turnover: annualisedTurnover(records),
    medianTimeInTier: median(streaks.map(([, s]) => s)),
    leastStable,
  };
}
