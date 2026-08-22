/**
 * Hard cap on the size of the Strong Buy tier.
 *
 * The momentum cutoffs alone qualify ~42 of 103 theme names, and the
 * fundamental gate only removes the handful that are decelerating — in this
 * universe momentum and fundamental acceleration overlap almost completely.
 * A count cap cuts on a different axis: rank position rather than score.
 *
 * Runs AFTER the fundamental gate on purpose. The gate removes names that do
 * not deserve the tier on merit; the cap then takes the best of what remains.
 * Reversing the order would let a fundamentally weak name consume a slot on its
 * way out, pushing a sounder name down for no reason.
 *
 * Note this makes the tier partly relative: a name can lose Strong Buy without
 * anything about it changing, because two others overtook it. That is the
 * intended behaviour of a top-N list, but it means tier changes will be noisier
 * than under the pure threshold rule, which matters for the alerting in step 8.
 *
 * That prediction held. Adding hysteresis to the percentile boundaries halved
 * momentum-tier turnover (1,177% -> 598%) but the FINAL tier only fell to 973%,
 * and the gap is this cap: a rank cut has no threshold to make sticky, so the
 * names at ranks 10 and 11 trade places on fractions of a percentile and every
 * swap is a Strong Buy <-> Buy transition. The fix is incumbency, below.
 */

import { DEFAULT_PARAMS } from "./params";
import type { OverlaidRow } from "./fundamental-gate";
import type { Params, Tier } from "./types";

/**
 * Percentile points a challenger must beat an incumbent by to take its slot.
 *
 * Deliberately narrower than the tier band (4). The band defends a published
 * cutoff; this defends an arbitrary rank boundary, so it only has to absorb the
 * noise separating adjacent names rather than a whole tier's worth of drift.
 * Two points stops the daily shuffle without letting a genuinely stronger name
 * queue behind a fading one for more than a session or two.
 */
export const CAP_MARGIN = 2;

/** Field the cap attaches. Separate so the overlay can stay generic. */
export interface CapFields {
  /** True when this name met every rule but fell outside the top N. */
  readonly capped: boolean;
  /** True when incumbency alone decided this row's slot, in either direction. */
  readonly capHeld: boolean;
}

export type CappedRow = OverlaidRow & CapFields;

/**
 * Rank order for the cap: relative strength first, then trend, then ticker.
 *
 * The ticker tiebreak is not decoration. Percentiles are tie-averaged, so
 * genuine ties at the boundary are common, and without a stable final key the
 * membership of the tier would depend on input ordering — the list would appear
 * to change between runs when nothing had moved.
 */
function byRank(bonus: (r: OverlaidRow) => number) {
  return (a: OverlaidRow, b: OverlaidRow): number => {
    const rs =
      (b.rsPct ?? -Infinity) + bonus(b) - ((a.rsPct ?? -Infinity) + bonus(a));
    if (rs !== 0) return rs;
    const trend = b.vsMa - a.vsMa;
    if (trend !== 0) return trend;
    return a.ticker.localeCompare(b.ticker);
  };
}

/** The `limit` highest-ranked tickers, with each row's rank bonus applied. */
function survivors(
  contenders: readonly OverlaidRow[],
  limit: number,
  bonus: (r: OverlaidRow) => number,
): Set<string> {
  return new Set([...contenders].sort(byRank(bonus)).slice(0, limit).map((r) => r.ticker));
}

/**
 * Keep the highest-ranked `limit` Strong Buys; demote the remainder to Buy.
 *
 * Only current Strong Buys compete. Buy and Hold are untouched: the cap tightens
 * the top tier, it does not promote anything into it.
 */
export function capStrongBuy<T extends OverlaidRow>(
  rows: readonly T[],
  limit: number = DEFAULT_PARAMS.nStrong,
  p: Params = DEFAULT_PARAMS,
  incumbents: ReadonlySet<string> = new Set(),
  margin: number = CAP_MARGIN,
): (T & CapFields)[] {
  const contenders = rows.filter((r) => r.tier === "Strong Buy");

  // Incumbency is a bonus on the ranking key, not a reserved seat. A reserved
  // seat would need an eviction order, and the outcome would then depend on
  // which incumbent was considered first; a bonus is one total ordering, so the
  // result is the same however the rows arrive.
  const bonus = (r: OverlaidRow) => (incumbents.has(r.ticker) ? margin : 0);
  const keep = survivors(contenders, limit, bonus);
  // Only computed to explain WHY a row sits where it does; decides nothing.
  const plain =
    margin > 0 && incumbents.size > 0 ? survivors(contenders, limit, () => 0) : keep;

  return rows.map((r) => {
    const capped = r.tier === "Strong Buy" && !keep.has(r.ticker);
    return {
      ...r,
      capped,
      capHeld: r.tier === "Strong Buy" && keep.has(r.ticker) !== plain.has(r.ticker),
      tier: capped ? ("Buy" as Tier) : r.tier,
      // Same reasoning as the gate: a demoted name must not keep the Strong Buy
      // sleeve, or the published 52/35/13 split quietly stops adding up.
      weight: capped ? p.wBuy : r.weight,
    };
  });
}

/** How many names the cap moved down, for reporting. */
export function cappedCount(rows: readonly CapFields[]): number {
  return rows.filter((r) => r.capped).length;
}

/** How many slots incumbency decided, for reporting. */
export function capHeldCount(rows: readonly CapFields[]): number {
  return rows.filter((r) => r.capHeld).length;
}
