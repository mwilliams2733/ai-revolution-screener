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

/**
 * When a session's daily bar can be trusted: 18:00 New York time on its date.
 *
 * Polygon returns an IN-PROGRESS daily aggregate while the market is open, so
 * a session fetched before the close is a mid-morning snapshot -- right open,
 * wrong close, a third of the volume. The refresh used to accept today as a
 * session whenever the proxy ticker had a bar for it, and from 2026-08-31 the
 * late backup scheduler landed during market hours every day, storing 17
 * sessions that were never re-fetched.
 *
 * Two hours after the close: bars fetched ~1.4 h after the close matched the
 * final closes exactly and held >99% of final volume, and 18:00 ET is when
 * the old afternoon refresh ran. New York observes DST, so this resolves the
 * real offset for the date rather than assuming one.
 */
export const SETTLE_HOUR_NY = 18;

/** The UTC instant of hour:minute New York wall-clock time on `session`. */
export function nyInstant(session: string, hour: number, minute = 0): Date {
  // Guess the instant assuming UTC, read back what New York's wall clock says
  // at that instant, and correct by the difference. One correction is exact
  // for any time away from a DST switch (02:00), and no caller asks for one.
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const guess = new Date(`${session}T${hh}:${mm}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() + (guess.getTime() - wall));
}

/** The UTC instant at which `session` (yyyy-mm-dd) is settled. */
export function settleInstant(session: string, hourNy: number = SETTLE_HOUR_NY): Date {
  return nyInstant(session, hourNy);
}

/** The regular-session open, 09:30 New York. */
export function marketOpenInstant(session: string): Date {
  return nyInstant(session, 9, 30);
}

/** Sessions whose bars are final as of `now`. Order is preserved. */
export function settledSessions(calendar: readonly string[], now: Date): string[] {
  return calendar.filter((d) => settleInstant(d).getTime() <= now.getTime());
}

/**
 * Sessions the refresh must (re)fetch, in calendar order (newest first).
 *
 * A session needs fetching when it is missing from the ledger OR was fetched
 * before it settled. Asking "is each session done" rather than "is it present"
 * is what lets the 17 mid-morning snapshots repair themselves, and keeps any
 * future early fetch from becoming permanent.
 *
 * @param calendar   settled sessions, newest first
 * @param fetchedAt  session -> when it was last fetched, for stored sessions
 */
export function sessionsNeedingFetch(
  calendar: readonly string[],
  fetchedAt: ReadonlyMap<string, Date>,
): string[] {
  return calendar.filter((d) => {
    const f = fetchedAt.get(d);
    return f == null || f.getTime() < settleInstant(d).getTime();
  });
}
