/**
 * Deciding what to fetch and what an empty response means. (Finding H1)
 *
 * The grouped-daily endpoint answers HTTP 200 with zero results for weekends,
 * market holidays, AND for a session that has not happened yet. Those three are
 * indistinguishable in the response, but they are not the same fact:
 *
 *   weekend/holiday  -> record it, so it is never retried
 *   not yet traded   -> retry later, because bars WILL exist
 *
 * The original code collapsed both into "record is_trading = false". Running the
 * backfill at 06:33 UTC on a Friday therefore fetched that Friday, got an empty
 * response because New York was asleep, and buried a real trading session
 * permanently — missingSessions skips anything already in the ledger, so those
 * 12,500 bars would never be fetched and nothing would report a gap.
 *
 * The fix is to stop guessing: take the work list from the real trading
 * calendar, and treat an empty response for a KNOWN session as a transient
 * failure rather than as a holiday.
 */

export type SessionOutcome = "store" | "retry" | "non-session";

/**
 * What to do with a grouped-daily response.
 *
 * @param barCount           rows returned
 * @param isKnownTradingDay  did this date come from the real session calendar?
 */
export function classifySession(barCount: number, isKnownTradingDay: boolean): SessionOutcome {
  if (barCount > 0) return "store";
  return isKnownTradingDay ? "retry" : "non-session";
}

/**
 * Sessions still needing a fetch, newest first.
 *
 * Deliberately a set difference against what is stored, not a high-water mark:
 * after an interrupted run the gaps are not a contiguous prefix, so "resume
 * from the newest missing" would skip holes in the middle.
 *
 * @param calendar real trading sessions, newest first
 * @param stored   sessions already in the ledger
 * @param target   how many sessions the caller wants in total
 */
export function sessionsToFetch(
  calendar: readonly string[],
  stored: readonly string[],
  target: number,
): string[] {
  const have = new Set(stored);
  return calendar.slice(0, target).filter((d) => !have.has(d));
}
