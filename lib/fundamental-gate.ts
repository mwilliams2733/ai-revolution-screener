/**
 * Fundamental overlay on the momentum tiers.
 *
 * Deliberately NOT folded into lib/tiers.ts assignTier. The regression fixture
 * in tiers.test.ts encodes the real 19-position portfolio and measures how well
 * a PRICE-ONLY model reproduces it (10 of 15 exact, the honest 67% ceiling).
 * Fold fundamentals into the core and that number stops measuring what it was
 * built to measure. As a separate pass, the price-only baseline stays intact and
 * the tighter list is still produced.
 *
 * The rule, per STRATEGY_DECODED.md section 6: a Strong Buy should show either
 * accelerating revenue or expanding operating margin. Failing both is what
 * demotes it.
 */

import type { Fundamentals } from "./edgar";
import { DEFAULT_PARAMS } from "./params";
import type { Params, ScreenRow, Tier } from "./types";

export type GateVerdict = "pass" | "demote" | "unverified";

export interface GateResult {
  readonly verdict: GateVerdict;
  readonly reason: string;
}

export interface OverlaidRow extends ScreenRow {
  /** Tier from price data alone, before the fundamental overlay. */
  readonly momentumTier: Tier | null;
  readonly gate: GateVerdict;
  readonly gateReason: string;
}

/**
 * Judge one name's fundamentals.
 *
 * Missing data returns `unverified`, never `demote`. Foreign issuers and OTC
 * names simply do not file with the SEC, and a not-yet-fetched name has not
 * failed anything. Treating absence as failure would quietly punish companies
 * for a gap in our data rather than a gap in their results.
 */
export function fundamentalGate(f: Fundamentals | null | undefined): GateResult {
  if (!f) return { verdict: "unverified", reason: "no SEC filings available" };

  const accel = f.revAccel;
  const margin = f.opMarginDelta;

  if (accel == null && margin == null) {
    return { verdict: "unverified", reason: "insufficient quarterly history" };
  }

  const accelerating = accel != null && accel > 0;
  const expanding = margin != null && margin > 0;

  if (accelerating && expanding) {
    return {
      verdict: "pass",
      reason: `revenue accelerating ${accel.toFixed(1)}pp, margin expanding ${margin.toFixed(1)}pp`,
    };
  }
  if (accelerating) {
    return { verdict: "pass", reason: `revenue growth accelerating ${accel.toFixed(1)}pp` };
  }
  if (expanding) {
    return { verdict: "pass", reason: `operating margin expanding ${margin.toFixed(1)}pp` };
  }

  const parts: string[] = [];
  if (accel != null) parts.push(`revenue growth decelerating ${accel.toFixed(1)}pp`);
  if (margin != null) parts.push(`margin compressing ${margin.toFixed(1)}pp`);
  return { verdict: "demote", reason: parts.join(", ") };
}

/**
 * Apply the gate across a ranked set.
 *
 * Only Strong Buy is at stake. The gate exists to tighten the top tier, not to
 * re-litigate Buy and Hold, which the momentum rank already separates.
 */
export function applyFundamentalOverlay(
  rows: readonly ScreenRow[],
  fundamentals: ReadonlyMap<string, Fundamentals>,
  p: Params = DEFAULT_PARAMS,
): OverlaidRow[] {
  return rows.map((r) => {
    const result = fundamentalGate(fundamentals.get(r.ticker));
    const demote = r.tier === "Strong Buy" && result.verdict === "demote";

    return {
      ...r,
      momentumTier: r.tier,
      gate: result.verdict,
      gateReason: result.reason,
      tier: demote ? ("Buy" as Tier) : r.tier,
      // Re-weight on demotion. Leaving the 7.43% sleeve on a name that is now
      // Buy-tier would quietly break the published 52/35/13 split.
      weight: demote ? p.wBuy : r.weight,
    };
  });
}

/** Count of names the gate actually moved, for reporting. */
export function demotedCount(rows: readonly OverlaidRow[]): number {
  return rows.filter((r) => r.momentumTier === "Strong Buy" && r.tier !== "Strong Buy").length;
}
