/**
 * Weinstein stage as a tier ceiling.
 *
 * The decoded tier rule separates on price-versus-average, which is a one-bit
 * view: above or below. It cannot distinguish a name above a RISING average
 * (Stage 2, an advance) from one above a ROLLING-OVER average (Stage 3,
 * distribution). METRICS_SPEC predicted Stage 3 and 4 names would cluster in
 * Hold if the tier rule already captured this, and measured on 2026-08-22 they
 * did not: 41 Stage-3 names, 21 of them in Buy or better.
 *
 * Stage 4 needed no rule at all -- all seven declining names were already Hold,
 * because a declining chart fails both existing gates. The entire gap was
 * Stage 3.
 *
 * So this caps rather than demotes by a fixed step: a topping name may not hold
 * better than Buy if it was Strong Buy, and may not hold better than Hold if it
 * was Buy. Hold already means "no new money", which is exactly what a topping
 * chart says.
 *
 * An overlay, not a change to assignTier, for the same reason as the fundamental
 * gate: tiers.test.ts measures how well a price-only model reproduces the
 * published book, and folding this into the core would destroy that baseline.
 */

import { DEFAULT_PARAMS } from "./params";
import { tierWeight } from "./tiers";
import type { StageReport } from "./trend-template";
import type { Params, ScreenRow, Tier } from "./types";

export interface StageFields {
  /** True when the stage rule moved this row down. */
  readonly stageCapped: boolean;
  readonly stageReason: string;
}

/** Rows this overlay can read. */
type WithStage = ScreenRow & { readonly stage: StageReport | null };

/** Late-stage charts: topping or declining. */
function isLateStage(s: StageReport | null): boolean {
  return s?.stage === 3 || s?.stage === 4;
}

/** The best tier a late-stage name may hold. */
function ceilingFor(tier: Tier | null): Tier | null {
  if (tier === "Strong Buy") return "Buy";
  if (tier === "Buy") return "Hold";
  // Hold is already the floor; the rule caps, it never pushes below.
  return tier;
}

export function applyStageRule<T extends WithStage>(
  rows: readonly T[],
  p: Params = DEFAULT_PARAMS,
): (T & StageFields)[] {
  return rows.map((r) => {
    // No stage means insufficient history, not a topping chart. Punishing a
    // recent listing for a gap in our data would be the same mistake the
    // fundamental gate refuses to make.
    if (!isLateStage(r.stage)) {
      return { ...r, stageCapped: false, stageReason: "" };
    }

    const capped = ceilingFor(r.tier);
    if (capped === r.tier) {
      return { ...r, stageCapped: false, stageReason: "" };
    }

    const which = r.stage?.stage === 4 ? "Stage 4 (decline)" : "Stage 3 (topping)";
    const slope = r.stage ? ` — 150-day average ${(r.stage.slope150 * 100).toFixed(1)}% over 10 sessions` : "";
    return {
      ...r,
      tier: capped,
      weight: capped ? tierWeight(capped, p) : r.weight,
      stageCapped: true,
      stageReason: `${which}${slope}`,
    };
  });
}

/** How many rows the stage rule moved, for reporting. */
export function stageDemotedCount(rows: readonly StageFields[]): number {
  return rows.filter((r) => r.stageCapped).length;
}
