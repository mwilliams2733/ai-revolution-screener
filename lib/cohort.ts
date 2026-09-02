/**
 * "What did the top 10 look like on a given day, and what happened next?"
 *
 * WHY THIS IS NOT THE BACKTEST
 *
 * lib/backtest.ts answers a statistical question -- does the tier rank names
 * correctly -- and goes to real trouble to do it honestly: non-overlapping
 * windows, a minimum sample before any t-statistic is read aloud, and no
 * "significant" verdict on offer at all.
 *
 * This module answers a REPORTING question instead: show me one day's cohort
 * and how it has moved since. Every cohort measured this way ends on the same
 * day, so the cohorts overlap almost completely -- seven cohorts are close to
 * the same price movements counted seven times, and the effective sample size
 * is nearer 1 than 7.
 *
 * That is fine for watching and useless for concluding, so nothing here
 * produces a t-statistic or a verdict. If a caller ever wants to make a claim
 * about whether the tier WORKS, it must go through lib/backtest.ts, which is
 * built to refuse.
 *
 * A cohort is only meaningful for a LIVE session. Replayed sessions were
 * reconstructed under a different ruleset -- no fundamental gate, today's theme
 * map, a universe pruned with hindsight -- so a "top 10 on a replayed day" is
 * fiction wearing a date. Callers filter to live before they get here.
 */

/** One name as it stood on the cohort's session. */
export interface Pick {
  readonly ticker: string;
  readonly rsPct: number | null;
}

/** Closes keyed by ticker, for the two sessions being compared. */
export type Closes = ReadonlyMap<string, number | null>;

export interface CohortRow {
  readonly ticker: string;
  readonly entryRs: number | null;
  readonly entryClose: number | null;
  readonly nowClose: number | null;
  /** Percent change from entry to now; null when either end is unmeasured. */
  readonly pct: number | null;
  /** Still in the current top 10? */
  readonly stillHeld: boolean;
}

/**
 * Null, never zero, when a bar is missing.
 *
 * The same rule lib/backtest.ts uses, and for the same reason: a missing bar is
 * an UNMEASURED return, and scoring it flat drags every average toward zero in
 * exactly the names with the patchiest data. A delisting would otherwise read
 * as a harmless 0% instead of the hole it is.
 */
export function changePct(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from <= 0) return null;
  return (to / from - 1) * 100;
}

export function cohortRows(
  picks: readonly Pick[],
  entry: Closes,
  now: Closes,
  currentTop: ReadonlySet<string>,
): CohortRow[] {
  return picks.map((p) => {
    const entryClose = entry.get(p.ticker) ?? null;
    const nowClose = now.get(p.ticker) ?? null;
    return {
      ticker: p.ticker,
      entryRs: p.rsPct,
      entryClose,
      nowClose,
      pct: changePct(entryClose, nowClose),
      stillHeld: currentTop.has(p.ticker),
    };
  });
}

export interface Summary {
  /** How many names had a measurable return. Not the cohort size. */
  readonly measured: number;
  readonly missing: number;
  readonly mean: number | null;
  readonly median: number | null;
  /** Share of measured names that rose, 0-100. */
  readonly winRate: number | null;
  readonly best: CohortRow | null;
  readonly worst: CohortRow | null;
}

const EMPTY: Summary = {
  measured: 0, missing: 0, mean: null, median: null,
  winRate: null, best: null, worst: null,
};

/**
 * Median over an even count averages the middle PAIR.
 *
 * Taking the upper of the two is a common shortcut and it biases every
 * even-sized cohort upward -- which is every cohort here, because the cap is 10.
 */
function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarise(rows: readonly CohortRow[]): Summary {
  const measured = rows.filter((r) => r.pct != null);
  if (measured.length === 0) return { ...EMPTY, missing: rows.length };

  const vals = measured.map((r) => r.pct as number);
  const ascending = [...vals].sort((a, b) => a - b);
  const byReturn = [...measured].sort((a, b) => (b.pct as number) - (a.pct as number));

  return {
    measured: measured.length,
    missing: rows.length - measured.length,
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    median: medianOf(ascending),
    winRate: (vals.filter((v) => v > 0).length / vals.length) * 100,
    best: byReturn[0],
    worst: byReturn[byReturn.length - 1],
  };
}

/**
 * Equal-weight mean move of a whole set of names -- the benchmark the cohort is
 * read against.
 *
 * An absolute cohort return is close to meaningless on its own: every live
 * cohort so far is negative while the theme fell further, which is the signal
 * working, not failing. The page must never show one without the other.
 */
export function benchmarkPct(
  tickers: readonly string[],
  entry: Closes,
  now: Closes,
): number | null {
  const vals = tickers
    .map((t) => changePct(entry.get(t) ?? null, now.get(t) ?? null))
    .filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
