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

/**
 * Recorded sessions to summarise.
 *
 * Every session there is, not a recent slice. Turnover is a property of the
 * RULESET, so measuring it over a short window measures whichever month you
 * happened to land in: the same data gave 1303% over the last 30 sessions and
 * 758% over all 248, and only one of those is a statement about the rules.
 *
 * The page quoted the 30-session figure while every commit message and the
 * README quoted the 248-session one -- two numbers for one concept, differing
 * by a factor of nearly two, with nothing on screen saying which was which.
 *
 * "Recent moves" stays recent; it is sliced separately below, because there
 * "recent" is the whole point.
 */
export const HISTORY_WINDOW = 10_000;

/** Tier changes listed under "recent moves". */
export const RECENT_MOVES = 20;

export interface TierHistorySummary {
  /**
   * How many distinct sessions the stability figures cover.
   *
   * Rendered next to them on purpose. A turnover number without its window is
   * not a number -- it is two different numbers wearing the same label.
   */
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
    transitions: transitions.slice(0, RECENT_MOVES),
    turnover: annualisedTurnover(records),
    medianTimeInTier: median(streaks.map(([, s]) => s)),
    leastStable,
  };
}
