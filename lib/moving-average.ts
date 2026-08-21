/**
 * True rolling moving averages, replacing the five-point proxy. (Finding C1)
 *
 * `computeMaProxy` in the core averages the current price and four sampled
 * anchors — a deliberate shortcut from the validation build, when only a handful
 * of API calls were available and no daily history was stored. It is a
 * reasonable stand-in for the SIGN of the trend, but it is not a 200-day mean,
 * and every downstream number inherits it: `vsMa`, the Buy/Hold separator, the
 * trend gate in `assignTier`, and the cool/warm colour encoding.
 *
 * This module computes the real thing from stored daily closes and falls back
 * to the proxy for names without enough history — a genuine cold-start case for
 * recent listings, not a silent default.
 *
 * Applied as an overlay rather than a change to lib/factors.ts, for the same
 * reason as the fundamental gate: `tiers.test.ts` measures how well a
 * price-only model reproduces the published book, and rewriting the core's
 * maths would destroy that baseline.
 */

import { pctChange } from "./factors";
import { DEFAULT_PARAMS } from "./params";
import { assignTier, tierWeight } from "./tiers";
import type { Params, ScreenRow } from "./types";

/** Trading days in the moving average the strategy describes. */
export const MA_WINDOW = 200;

export type MaSource = "true" | "proxy";

export interface TrendRow extends ScreenRow {
  /** Which average produced `vsMa`, so the UI never implies false precision. */
  readonly maSource: MaSource;
}

/**
 * Mean of the last `window` closes, or null when there are not enough.
 *
 * Null rather than a partial mean on purpose. A "200-day average" computed from
 * 40 bars is not one, and presenting it as such reports a trend that has not
 * been measured. Non-finite values also return null rather than being skipped,
 * because a gap in the series means the window is not what it claims to be.
 */
export function sma(closes: readonly number[], window: number = MA_WINDOW): number | null {
  if (window <= 0 || closes.length < window) return null;

  const slice = closes.slice(closes.length - window);
  let total = 0;
  for (const c of slice) {
    if (!Number.isFinite(c)) return null;
    total += c;
  }
  return total / window;
}

/**
 * Swap in true moving averages where history allows.
 *
 * Re-runs `assignTier` because the trend gate reads `vsMa`: a corrected average
 * with a stale tier attached would be worse than either alone. Relative-strength
 * percentiles are deliberately untouched — RS is computed from returns, so a
 * different average must not disturb the ranking the cutoffs depend on.
 *
 * @param history ticker -> daily closes, oldest first
 */
export function applyTrueMa(
  rows: readonly ScreenRow[],
  history: ReadonlyMap<string, readonly number[]>,
  p: Params = DEFAULT_PARAMS,
  window: number = MA_WINDOW,
): TrendRow[] {
  return rows.map((r) => {
    const mean = sma(history.get(r.ticker) ?? [], window);

    // A non-positive mean cannot produce a meaningful percentage, so treat it
    // as missing rather than emitting a nonsense trend.
    if (mean == null || mean <= 0) {
      return { ...r, maSource: "proxy" as const };
    }

    const vsMa = pctChange(r.price, mean);
    if (vsMa == null) return { ...r, maSource: "proxy" as const };

    const tier = r.rsPct == null ? r.tier : assignTier(r.rsPct, vsMa, p);
    return {
      ...r,
      maProxy: mean,
      vsMa,
      tier,
      weight: tier ? tierWeight(tier, p) : r.weight,
      maSource: "true" as const,
    };
  });
}

/** How many rows are backed by a real rolling mean, for reporting. */
export function trueMaCount(rows: readonly TrendRow[]): number {
  return rows.filter((r) => r.maSource === "true").length;
}
