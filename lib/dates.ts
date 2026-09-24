/**
 * Date helpers shared by every caller that walks backwards from today.
 *
 * Previously duplicated byte-for-byte in lib/screen-service.ts and
 * app/api/refresh/route.ts, and a third near-copy lived in scripts/backfill.ts.
 * Two code paths that must agree should share one implementation rather than
 * two that happen to match today. (Finding M1)
 *
 * Deliberately UTC: Vercel runs UTC, and every date the Polygon endpoints take
 * is a UTC calendar date. Mixing in local time would make the work list depend
 * on where the process happens to run.
 */

/** ISO yyyy-mm-dd for `n` days before now, in UTC. */
export function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * ISO yyyy-mm-dd for "today" as a reader in Phoenix experiences it.
 *
 * Phoenix is UTC-7 with no daylight saving, so the offset is a constant and
 * needs no timezone database. This exists for one purpose: deciding whether
 * the morning digest has already gone out TODAY. That question is asked by a
 * person waking up in Arizona, not by a server in UTC -- and a manual run at
 * 6 PM Phoenix is still "today" to them, whereas in UTC it is already
 * tomorrow and would silence the next morning's email.
 */
export function phoenixToday(now: Date = new Date()): string {
  // en-CA formats as yyyy-mm-dd. Same approach as dayLabel() in
  // lib/refresh-stamp.ts, which already reasons about Phoenix calendar days.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
