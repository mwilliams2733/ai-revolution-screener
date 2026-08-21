/**
 * Tier assignment and position sizing.
 *
 * The decoded rule, from STRATEGY_DECODED.md section 2: tiers track relative
 * strength, not volatility. The published calculator is sold as a risk model but
 * the delivered book runs the other way, with the Strong Buy bucket averaging
 * 71.5% annualized vol against the Hold bucket's 52.0%. What separates the tiers
 * cleanly is RS percentile (86 / 63 / 36) and position against the moving
 * average (+22.6% / +12.0% / -0.8%).
 *
 * Pure and network-free. Ported from screener.py.
 */

import type { Params, ScreenRow, Tier } from "./types";
import { TIERS } from "./types";

/**
 * Assign a tier from RS percentile and trend position.
 *
 * Reproduces 10 of 15 published tier assignments exactly, and 15 of 15 within
 * one tier. The residual is the analysts' fundamental overlay, which price data
 * alone cannot recover. Treat 67% as the baseline to beat, and be suspicious of
 * any tweak that pushes it much higher without new inputs: that is curve-fitting
 * to nineteen data points.
 */
export function assignTier(rsPct: number, vsMa: number, p: Params): Tier {
  if (rsPct >= p.strongRs && vsMa > p.strongTrend) return "Strong Buy";
  if (rsPct >= p.buyRs && vsMa >= p.buyTrend) return "Buy";
  return "Hold";
}

/** Sleeve fraction for a tier. */
export function tierWeight(tier: Tier, p: Params): number {
  switch (tier) {
    case "Strong Buy":
      return p.wStrong;
    case "Buy":
      return p.wBuy;
    case "Hold":
      return p.wHold;
  }
}

/** Target position count for a tier. */
export function tierCap(tier: Tier, p: Params): number {
  switch (tier) {
    case "Strong Buy":
      return p.nStrong;
    case "Buy":
      return p.nBuy;
    case "Hold":
      return p.nHold;
  }
}

/** Fill in tier and weight on ranked rows. Requires rsPct to be set. */
export function applyTiers(rows: readonly ScreenRow[], p: Params): ScreenRow[] {
  return rows.map((r) => {
    if (r.rsPct == null) return r;
    const tier = assignTier(r.rsPct, r.vsMa, p);
    return { ...r, tier, weight: tierWeight(tier, p) };
  });
}

/**
 * Take the top N of each tier, matching the delivered 7/7/5 shape.
 * Input must be sorted strongest first, which rankRows guarantees.
 */
export function buildPortfolio(rows: readonly ScreenRow[], p: Params): ScreenRow[] {
  const seen = new Map<Tier, number>(TIERS.map((t) => [t, 0]));
  const out: ScreenRow[] = [];
  for (const r of rows) {
    if (r.tier == null) continue;
    const n = seen.get(r.tier) ?? 0;
    if (n >= tierCap(r.tier, p)) continue;
    out.push(r);
    seen.set(r.tier, n + 1);
  }
  return out;
}

/** Total allocated fraction of the sleeve. The remainder is cash. */
export function totalAllocation(rows: readonly ScreenRow[]): number {
  return rows.reduce((a, r) => a + r.weight, 0);
}

export interface TierStats {
  readonly tier: Tier;
  readonly count: number;
  readonly weight: number;
  readonly meanRsPct: number | null;
  readonly meanVsMa: number | null;
  readonly meanR12m: number | null;
}

/**
 * Per-tier summary. Use this as the regression check when you change the
 * ruleset: meanRsPct must stay monotonically decreasing across the tiers, which
 * is the core finding the whole strategy rests on.
 */
export function tierSummary(rows: readonly ScreenRow[]): TierStats[] {
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

  return TIERS.map((tier) => {
    const g = rows.filter((r) => r.tier === tier);
    return {
      tier,
      count: g.length,
      weight: g.reduce((a, r) => a + r.weight, 0),
      meanRsPct: mean(g.map((r) => r.rsPct).filter((v): v is number => v != null)),
      meanVsMa: mean(g.map((r) => r.vsMa)),
      meanR12m: mean(g.map((r) => r.r12m)),
    };
  });
}

/** True when mean RS percentile decreases across Strong Buy -> Buy -> Hold. */
export function isMonotonic(stats: readonly TierStats[]): boolean {
  const vals = stats
    .map((s) => s.meanRsPct)
    .filter((v): v is number => v != null);
  return vals.every((v, i) => i === 0 || vals[i - 1] > v);
}
