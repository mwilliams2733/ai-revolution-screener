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
 */

import { DEFAULT_PARAMS } from "./params";
import type { OverlaidRow } from "./fundamental-gate";
import type { Params, Tier } from "./types";

export interface CappedRow extends OverlaidRow {
  /** True when this name met every rule but fell outside the top N. */
  readonly capped: boolean;
}

/**
 * Rank order for the cap: relative strength first, then trend, then ticker.
 *
 * The ticker tiebreak is not decoration. Percentiles are tie-averaged, so
 * genuine ties at the boundary are common, and without a stable final key the
 * membership of the tier would depend on input ordering — the list would appear
 * to change between runs when nothing had moved.
 */
function byRank(a: OverlaidRow, b: OverlaidRow): number {
  const rs = (b.rsPct ?? -Infinity) - (a.rsPct ?? -Infinity);
  if (rs !== 0) return rs;
  const trend = b.vsMa - a.vsMa;
  if (trend !== 0) return trend;
  return a.ticker.localeCompare(b.ticker);
}

/**
 * Keep the highest-ranked `limit` Strong Buys; demote the remainder to Buy.
 *
 * Only current Strong Buys compete. Buy and Hold are untouched: the cap tightens
 * the top tier, it does not promote anything into it.
 */
export function capStrongBuy(
  rows: readonly OverlaidRow[],
  limit: number = DEFAULT_PARAMS.nStrong,
  p: Params = DEFAULT_PARAMS,
): CappedRow[] {
  const contenders = rows.filter((r) => r.tier === "Strong Buy").sort(byRank);
  const keep = new Set(contenders.slice(0, limit).map((r) => r.ticker));

  return rows.map((r) => {
    const capped = r.tier === "Strong Buy" && !keep.has(r.ticker);
    return {
      ...r,
      capped,
      tier: capped ? ("Buy" as Tier) : r.tier,
      // Same reasoning as the gate: a demoted name must not keep the Strong Buy
      // sleeve, or the published 52/35/13 split quietly stops adding up.
      weight: capped ? p.wBuy : r.weight,
    };
  });
}

/** How many names the cap moved down, for reporting. */
export function cappedCount(rows: readonly CappedRow[]): number {
  return rows.filter((r) => r.capped).length;
}
