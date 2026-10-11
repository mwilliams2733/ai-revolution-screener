/**
 * Split adjustment for share-count history.
 *
 * `dei:EntityCommonStockSharesOutstanding` is a cover-page instant: every
 * filing reports the count as of its own filing date, and the value is NEVER
 * retroactively restated. A 10-for-1 split therefore appears in the raw series
 * as a 900% increase in shares outstanding, indistinguishable from issuing nine
 * times the company.
 *
 * That is not a harmless inaccuracy. Forward splits are done almost exclusively
 * by companies whose stock has appreciated a lot, so an unadjusted dilution
 * metric condemns winners specifically -- exactly the names a momentum screener
 * exists to surface. Measured on the live screen it failed KLAC ("+890%") and
 * NOW ("+397%"), which had split 1:10 and 1:5 respectively and diluted by
 * approximately nothing.
 *
 * The same table fixes a second, latent problem. Polygon re-adjusts price
 * history when a split executes, but scripts/backfill.ts never re-fetches a
 * session it already stored, so any split from now on strands the stored bars
 * for that ticker on a stale basis. A 10:1 reverse split would manufacture a
 * +900% twelve-month return and send the name to RS 99. `tickersNeedingRefetch`
 * is what a split-aware backfill would consult.
 */

export interface Split {
  readonly ticker: string;
  /** ISO date the split took effect. */
  readonly executionDate: string;
  readonly from: number;
  readonly to: number;
}

/**
 * How many of today's shares one share on `date` became.
 *
 * A 1:10 forward split gives 10, so a pre-split count of 131M is restated to
 * 1,310M and compares like with like against a post-split count. A 20:1 reverse
 * split gives 0.05.
 *
 * Only splits executed strictly AFTER `date` apply. One executed on the day
 * itself is already reflected in a count reported that day, and applying it
 * again would double-count.
 */
export function factorSince(splits: readonly Split[], date: string): number {
  const at = Date.parse(date);
  if (!Number.isFinite(at)) return 1;
  let factor = 1;
  for (const s of splits) {
    if (s.from <= 0 || s.to <= 0) continue;
    if (Date.parse(s.executionDate) > at) factor *= s.to / s.from;
  }
  return factor;
}

/** A point on a per-ticker time series, as solvency.ts uses. */
interface Dated {
  readonly end: string;
  readonly val: number;
}

/**
 * Restate a share-count series onto today's basis.
 *
 * Every point is multiplied by the splits that happened after it, so the whole
 * series speaks in current shares and a year-on-year comparison measures
 * issuance rather than arithmetic.
 */
export function adjustSeries<T extends Dated>(
  points: readonly T[],
  splits: readonly Split[],
): T[] {
  if (splits.length === 0) return [...points];
  return points.map((p) => ({ ...p, val: p.val * factorSince(splits, p.end) }));
}

/**
 * Tickers whose stored price history is on a stale split basis.
 *
 * A stored bar is only trustworthy if it was fetched after every split that
 * affects it. Given the last time each ticker's history was written, any split
 * executed since means the whole series for that ticker must be re-fetched --
 * not just the sessions after the split, because Polygon restates the entire
 * history.
 */
export function tickersNeedingRefetch(
  splits: readonly Split[],
  fetchedAt: ReadonlyMap<string, string>,
): string[] {
  const stale = new Set<string>();
  for (const s of splits) {
    const when = fetchedAt.get(s.ticker);
    if (when == null) continue;
    if (Date.parse(s.executionDate) > Date.parse(when)) stale.add(s.ticker);
  }
  return [...stale].sort();
}

/** Key identifying one split, for the handled-ledger. */
export const splitKey = (s: Split): string => `${s.ticker}|${s.executionDate}`;

/**
 * Splits whose price history has not yet been re-fetched.
 *
 * A SET DIFFERENCE, deliberately, not a watermark. A high-water date would
 * assume every split before it was handled, and one failed re-fetch in the
 * middle would be silently skipped forever. Asking "is this particular split
 * done?" survives an interrupted run, a newly discovered split with an older
 * execution date, and a ticker whose bars arrive later than its split.
 *
 * @param held tickers we actually store bars for; the rest need no work
 */
export function pendingRefetches(
  splits: readonly Split[],
  handled: ReadonlySet<string>,
  held: ReadonlySet<string>,
  /**
   * Today (yyyy-mm-dd). Only splits dated BEFORE it are due: repairing an
   * announced split before it executes re-fetches the old basis and marks it
   * handled, so the real restatement is never repaired.
   */
  asOf: string,
): Split[] {
  return splits
    .filter((s) => s.executionDate < asOf && held.has(s.ticker) && !handled.has(splitKey(s)))
    .sort((a, b) => Date.parse(a.executionDate) - Date.parse(b.executionDate));
}

/** One entry per ticker needing work, with its oldest pending split. */
export function refetchTargets(pending: readonly Split[]): { ticker: string; since: string }[] {
  const oldest = new Map<string, string>();
  for (const s of pending) {
    const prev = oldest.get(s.ticker);
    if (prev == null || Date.parse(s.executionDate) < Date.parse(prev)) {
      oldest.set(s.ticker, s.executionDate);
    }
  }
  return [...oldest].map(([ticker, since]) => ({ ticker, since })).sort(
    (a, b) => a.ticker.localeCompare(b.ticker),
  );
}

/** Group a flat split list by ticker, for per-name lookup. */
export function byTicker(splits: readonly Split[]): Map<string, Split[]> {
  const out = new Map<string, Split[]>();
  for (const s of splits) {
    const g = out.get(s.ticker);
    if (g) g.push(s);
    else out.set(s.ticker, [s]);
  }
  for (const [, g] of out) {
    g.sort((a, b) => Date.parse(a.executionDate) - Date.parse(b.executionDate));
  }
  return out;
}
