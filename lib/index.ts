/**
 * Composed screen pipeline.
 *
 * Order matters: rank against the FULL liquid universe, then filter to the
 * theme. Ranking inside the theme changes what an RS percentile means and
 * invalidates the tier cutoffs.
 */

import { computeRows, rankRows } from "./factors";
import { DEFAULT_PARAMS } from "./params";
import { applyTiers, buildPortfolio } from "./tiers";
import { themeUniverse } from "./theme";
import type { Params, ScreenRow, Snapshots } from "./types";

export * from "./types";
export * from "./factors";
export * from "./tiers";
export * from "./theme";
export { DEFAULT_PARAMS, withParams } from "./params";

export interface ScreenResult {
  /** Every liquid name, ranked and tiered. */
  readonly ranked: readonly ScreenRow[];
  /** Theme-filtered subset, ranked and tiered. */
  readonly themed: readonly ScreenRow[];
  /** Top N of each tier from the themed set, matching the 7/7/5 shape. */
  readonly portfolio: readonly ScreenRow[];
  readonly universeSize: number;
}

export interface ScreenInput {
  readonly snapshots: Snapshots;
  /** ticker -> company name for the full reference universe. */
  readonly names: ReadonlyMap<string, string>;
  readonly params?: Params;
}

export function runScreen({ snapshots, names, params = DEFAULT_PARAMS }: ScreenInput): ScreenResult {
  // 1. Score and rank the full liquid universe. Percentiles derive from here.
  const fullUniverse = new Map<string, string>();
  for (const t of names.keys()) fullUniverse.set(t, "");

  const scored = computeRows(snapshots, fullUniverse, names, params);
  const ranked = applyTiers(rankRows(scored), params);

  // 2. Filter to the theme, preserving the universe-wide percentiles.
  const theme = themeUniverse({ restrictTo: new Set(names.keys()) });
  const themed = ranked
    .filter((r) => theme.has(r.ticker))
    .map((r) => ({ ...r, sector: theme.get(r.ticker) ?? "" }));

  return {
    ranked,
    themed,
    portfolio: buildPortfolio(themed, params),
    universeSize: ranked.length,
  };
}
