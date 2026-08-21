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
