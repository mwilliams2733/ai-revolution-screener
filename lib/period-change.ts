/**
 * Day, week and month price changes.
 *
 * The screen already carried 3-month and 12-month returns, which are the
 * inputs to the relative-strength score. These are the short horizons a person
 * actually reads first: what did it do today, this week, this month.
 *
 * Pure and I/O-free. A window shorter than requested returns null rather than a
 * truncated one: three sessions is not a week, and reporting it as one
 * understates the move.
 */

import { pctChange } from "./factors";

/** Trading sessions, not calendar days. */
export const WEEK_SESSIONS = 5;
export const MONTH_SESSIONS = 21;

export interface PeriodChanges {
  /** Close against the previous session's close. The conventional "day change". */
  readonly day: number | null;
  /** Close against the open of the same session. */
  readonly intraday: number | null;
  readonly week: number | null;
  readonly month: number | null;
}

const EMPTY: PeriodChanges = { day: null, intraday: null, week: null, month: null };

/** Percentage change between the last close and the one `back` sessions ago. */
function over(closes: readonly number[], back: number): number | null {
  if (closes.length < back + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - back];
  return pctChange(now, then);
}

/**
 * @param closes oldest first; the last element is the current session
 * @param open   the current session's open, or null when not stored
 */
export function periodChanges(
  closes: readonly number[],
  open: number | null,
): PeriodChanges {
  if (closes.length === 0) return EMPTY;

  const close = closes[closes.length - 1];
  return {
    // Deliberately against the previous CLOSE, matching every quote screen.
    // Close-against-open is a different number and is reported separately.
    day: over(closes, 1),
    intraday: open == null ? null : pctChange(close, open),
    week: over(closes, WEEK_SESSIONS),
    month: over(closes, MONTH_SESSIONS),
  };
}
