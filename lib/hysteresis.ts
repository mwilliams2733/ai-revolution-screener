/**
 * Sticky tier boundaries.
 *
 * Measured across 248 reconstructed sessions, annualised turnover was 1,177%:
 * about five tier changes per session across ~105 names, or a given name moving
 * roughly every three weeks. METRICS_SPEC flags anything above 200% as cutoffs
 * "chasing noise rather than tracking a regime".
 *
 * The move counts showed it was not drift. Hold->Buy 443 against Buy->Hold 426,
 * and Strong Buy->Buy 183 against Buy->Strong Buy 182 — near-perfect symmetry
 * in both directions. Names were oscillating across the 55 and 80 percentile
 * boundaries, which is a property of step-function cutoffs rather than of the
 * market. A name resting at 79.6 becomes Strong Buy at 80.1 and reverts a week
 * later, and every crossing generates an alert.
 *
 * The fix is to make a boundary harder to cross than to hold: enter the tier at
 * the published cutoff plus a band, leave it only at the cutoff minus one.
 *
 * Deliberately NOT applied to the trend gate. Falling below the 200-day average
 * is a regime statement, not a ranking wobble, and should take effect at once.
 */

import { assignTier, tierWeight } from "./tiers";
import { DEFAULT_PARAMS } from "./params";
import type { Params, ScreenRow, Tier } from "./types";

/**
 * Percentile points a name must clear beyond a boundary to change tier.
 *
 * Four points is roughly a fifth of the gap between the 55 and 80 cutoffs —
 * wide enough to absorb ordinary day-to-day rank movement, narrow enough that a
 * real regime change still registers within a session or two.
 */
export const DEFAULT_BAND = 4;

export interface HysteresisFields {
  /** True when the band changed the outcome. */
  readonly held: boolean;
  /**
   * The tier after the band and BEFORE every demoting overlay. This is what
   * tier_history.momentum_tier stores and what tomorrow's band compares
   * against. Capturing it later -- after the stage rule -- made a name that
   * was merely capped look like it had lost the tier, which defeated the band.
   */
  readonly bandTier: Tier | null;
}

/**
 * The tier, with boundaries shifted according to where the name already sat.
 *
 * The trend gate is evaluated first and without a band: no amount of stickiness
 * keeps a name in a buy-side tier once it is below its moving average.
 */
export function hysteresisTier(
  rsPct: number,
  vsMa: number,
  previous: Tier | null,
  p: Params = DEFAULT_PARAMS,
  band: number = DEFAULT_BAND,
): Tier {
  const plain = assignTier(rsPct, vsMa, p);
  if (previous == null || band <= 0) return plain;

  // A name that has lost its trend cannot hold a buy-side tier, whatever it
  // held yesterday.
  if (vsMa <= p.buyTrend) return plain;

  if (previous === "Strong Buy") {
    // Keep it while it is within the band below the cutoff.
    if (rsPct >= p.strongRs - band && vsMa > p.strongTrend) return "Strong Buy";
    return plain;
  }

  if (previous === "Buy") {
    // Promote only on a clear break above; keep while within the band below.
    if (rsPct >= p.strongRs + band && vsMa > p.strongTrend) return "Strong Buy";
    if (rsPct >= p.buyRs - band) return "Buy";
    return plain;
  }

  // Previously Hold: require a clear break to enter Buy at all.
  if (rsPct >= p.strongRs + band && vsMa > p.strongTrend) return "Strong Buy";
  if (rsPct >= p.buyRs + band) return "Buy";
  return "Hold";
}

/**
 * Apply the band across a ranked set.
 *
 * @param previous ticker -> the tier this name held last session
 */
export function applyHysteresis<T extends ScreenRow>(
  rows: readonly T[],
  previous: ReadonlyMap<string, Tier>,
  p: Params = DEFAULT_PARAMS,
  band: number = DEFAULT_BAND,
): (T & HysteresisFields)[] {
  return rows.map((r) => {
    const before = previous.get(r.ticker) ?? null;
    if (before == null || r.rsPct == null) return { ...r, held: false, bandTier: r.tier };

    const sticky = hysteresisTier(r.rsPct, r.vsMa, before, p, band);
    if (sticky === r.tier) return { ...r, held: false, bandTier: r.tier };

    return { ...r, tier: sticky, weight: tierWeight(sticky, p), held: true, bandTier: sticky };
  });
}

/** How many rows the band changed, for reporting. */
export function heldCount(rows: readonly HysteresisFields[]): number {
  return rows.filter((r) => r.held).length;
}

/**
 * Yesterday's band tiers from both stores.
 *
 * tier_history holds the AI book; market_band_tiers holds everyone else. A
 * name can appear in both after it is added to THEME, and the book's record
 * wins because it is the one the book's own band was built from.
 */
export function mergePriorTiers(
  book: ReadonlyMap<string, string>,
  market: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map(market);
  for (const [t, v] of book) out.set(t, v);
  return out;
}
