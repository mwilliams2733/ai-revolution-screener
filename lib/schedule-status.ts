/**
 * Has today's scheduled work already been done?
 *
 * Asked by the GitHub backup scheduler before it calls a route, so a run that
 * finds the Vercel cron already finished can skip instead of rebuilding the
 * screen for nothing. Pure, so the decision is testable without a database.
 *
 * Both answers must err towards "not done". A false "not done" costs one
 * redundant call to a route that is idempotent anyway; a false "done" skips
 * real work, and on the digest that means a morning with no email.
 */

export interface Status {
  readonly done: boolean;
  readonly reason: string;
}

export interface RefreshFacts {
  /** Sessions still needing a fetch, from sessionBacklog(). */
  readonly sessionsNeedingFetch: readonly string[];
  /** Split repairs outstanding, from splitBacklog(). */
  readonly splitsPending: number;
  /** Newest session with stored bars; the screen's as-of date. */
  readonly newestStored: string | null;
  /** Does tier_history hold a live snapshot for newestStored? */
  readonly snapshotted: boolean;
}

/**
 * Done only when all three things the refresh produces are in place: every
 * settled session stored, the as-of session snapshotted, no split backlog.
 *
 * The snapshot is checked separately because a run can store the bars and
 * then die building the screen, which leaves the session ledger looking
 * complete while tomorrow's tier diff has no baseline.
 */
export function refreshStatus(f: RefreshFacts): Status {
  if (f.sessionsNeedingFetch.length > 0) {
    return { done: false, reason: `${f.sessionsNeedingFetch.length} session(s) need fetching` };
  }
  if (!f.newestStored) return { done: false, reason: "no stored sessions" };
  if (!f.snapshotted) return { done: false, reason: `no tier snapshot for ${f.newestStored}` };
  if (f.splitsPending > 0) return { done: false, reason: `${f.splitsPending} split repair(s) pending` };
  return { done: true, reason: `${f.newestStored} stored and snapshotted` };
}

/**
 * Done when the ledger holds this morning's key for the current as-of session.
 *
 * Same key the digest route claims, so a refresh that lands after the first
 * digest makes this "not done" again and the corrected digest still goes out.
 */
export function digestStatus(key: string | null, sent: boolean): Status {
  if (!key) return { done: false, reason: "no stored sessions" };
  return sent ? { done: true, reason: `${key} already sent` } : { done: false, reason: `${key} not sent` };
}
