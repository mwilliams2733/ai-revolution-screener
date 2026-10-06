/**
 * What the refresh still has to do: sessions to (re)fetch and split repairs.
 *
 * The refresh route and its status probe both call these, so "is today's
 * refresh done" is answered by the same work list the refresh itself acts on
 * rather than by a second definition that could drift from it.
 */

import { tradingCalendar } from "./polygon";
import { handledSplits, sessionFetchTimes, splitHistory, tickersWithBars } from "./db";
import { sessionsNeedingFetch } from "./session-ledger";
import { isoDaysAgo } from "./dates";
import { pendingRefetches } from "./splits";

/**
 * How far back to look for gaps. (Finding M4)
 *
 * Must be comfortably wider than the refresh's per-run session cap or a
 * backlog can never drain: with a 10-session window and 3 fetched per night,
 * an outage longer than about two weeks left the oldest gaps permanently
 * outside the window, and `remaining` reported a number that never fell.
 */
export const CATCHUP_WINDOW = 60;

/**
 * Sessions still needing a fetch, newest first: missing ones AND ones stored
 * before they settled. See sessionsNeedingFetch in lib/session-ledger.ts.
 */
export async function sessionBacklog(): Promise<string[]> {
  // Real session dates, newest first, over a window wide enough that a
  // backlog drains instead of falling off the end.
  const calendar = await tradingCalendar(isoDaysAgo(CATCHUP_WINDOW * 2), isoDaysAgo(0));
  const recent = calendar.slice(0, CATCHUP_WINDOW);
  return sessionsNeedingFetch(recent, await sessionFetchTimes(recent));
}

/** Splits whose stranded history has not been repaired yet. */
export async function splitBacklog() {
  const [allSplits, handled, held] = await Promise.all([
    splitHistory(),
    handledSplits(),
    tickersWithBars(),
  ]);
  return pendingRefetches([...allSplits.values()].flat(), handled, held);
}
