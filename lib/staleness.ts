/**
 * How old is the data, and does that matter? (Finding H3)
 *
 * The as-of date was displayed but never assessed. This plan serves delayed
 * end-of-day bars, so the screen is ALWAYS showing the previous session's close
 * — that is normal and should not alarm anyone. What must be visible is the
 * abnormal case: a cron outage or an API failure leaving the screen frozen on a
 * week-old session while looking exactly as it does when fresh.
 *
 * Staleness is measured in trading sessions, not calendar days. Monday morning
 * showing Friday's close is current; a calendar-day rule would call it three
 * days old and cry wolf every weekend.
 */

export type Freshness = "current" | "stale" | "very-stale";

export interface StalenessReport {
  readonly freshness: Freshness;
  /** Trading sessions between the data and the latest available one. */
  readonly sessionsBehind: number;
  /** Plain-language summary for the UI. */
  readonly label: string;
}

/**
 * Compare the screen's as-of date against the real trading calendar.
 *
 * @param asOf     session the data represents
 * @param calendar real trading sessions, newest first
 */
export function assessStaleness(asOf: string, calendar: readonly string[]): StalenessReport {
  const idx = calendar.indexOf(asOf);

  if (idx === -1) {
    // Not a known session at all: either far older than the calendar window or
    // a date that never traded. Either way it cannot be vouched for.
    return {
      freshness: "very-stale",
      sessionsBehind: Number.POSITIVE_INFINITY,
      label: "Data is from an unrecognised session",
    };
  }

  if (idx === 0) {
    return { freshness: "current", sessionsBehind: 0, label: "Latest close" };
  }
  if (idx === 1) {
    return { freshness: "stale", sessionsBehind: 1, label: "One session behind" };
  }
  return {
    freshness: "very-stale",
    sessionsBehind: idx,
    label: `${idx} sessions behind — the refresh may have stopped`,
  };
}
