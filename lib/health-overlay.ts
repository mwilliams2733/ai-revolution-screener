/**
 * Balance-sheet guardrails applied to the screen.
 *
 * Replaces what the $5 price floor was standing in for. That floor bundled
 * several unrelated risks -- shells, illiquidity, dilution, insolvency -- into
 * one crude proxy that was bad at all of them in both directions: it excluded
 * sound companies whose shares happen to be cheap, and admitted a $12 stock
 * with a $40M market cap. lib/solvency.ts measures each risk directly; this
 * applies the verdict.
 *
 * UNIVERSAL, NOT PRICE-CONDITIONAL
 *
 * The obvious implementation is to run these checks only on the names the price
 * floor used to exclude. That reintroduces exactly the price-based special
 * casing the change exists to remove: if dilution matters at $2 it matters at
 * $20. Applied universally, the guardrails cost six of 109 theme names -- four
 * of them Strong Buys -- and that is the point rather than a side effect.
 *
 * A FAILURE CAPS AT HOLD, IT DOES NOT DELETE
 *
 * Nothing is dropped from the screen. A name funding itself with equity at 42%
 * a year keeps its rank, its rail and its row, and carries the reason it was
 * capped. The repo's standing rule is that an excluded name stays visible with
 * its reason attached -- six months from now the explanation is still on
 * screen, which a silent exclusion could never manage.
 *
 * Hold is the right floor because Hold already means "no new money", which is
 * exactly what a balance-sheet failure says. It is a stronger response than the
 * fundamental gate's one-step demotion because it is a stronger statement: a
 * decelerating revenue line is a business slowing down, whereas serial dilution
 * or a year of runway is a question about whether the equity survives.
 */

import { DEFAULT_PARAMS } from "./params";
import { tierWeight } from "./tiers";
import { DEFAULT_THRESHOLDS, assess, type Health, type Thresholds } from "./solvency";
import type { FactPoint } from "./solvency";
import { adjustSeries, type Split } from "./splits";
import type { Params, ScreenRow, Tier } from "./types";

/** Everything cached for one company, as stored by scripts/health.ts. */
export interface HealthFacts {
  readonly shares: readonly FactPoint[];
  readonly cash: number | null;
  readonly ocf: readonly FactPoint[];
  readonly revenue: number | null;
}

export interface HealthFields {
  /** Full assessment, or null when nothing was cached for this name. */
  readonly health: Health | null;
  /** True when a measured breach capped this row's tier. */
  readonly healthCapped: boolean;
  /** Plain-language reason, empty when nothing applied. */
  readonly healthReason: string;
}

const LABELS: Record<string, string> = {
  dilution: "share count growing faster than the limit",
  runway: "less than a year of cash at the current burn",
  "market cap": "too small to be a real company",
};

/** Human-readable summary of why a name failed. */
export function describe(h: Health, t: Thresholds = DEFAULT_THRESHOLDS): string {
  if (h.failures.length === 0) return "";
  const parts = h.failures.map((f) => {
    if (f === "dilution" && h.dilution) {
      return `shares +${(h.dilution.growth * 100).toFixed(0)}% in a year (limit ${(t.maxDilution * 100).toFixed(0)}%)`;
    }
    if (f === "runway" && h.runway != null) {
      return `${h.runway.toFixed(0)} months of cash at the current burn (limit ${t.minRunwayMonths})`;
    }
    if (f === "market cap" && h.marketCap != null) {
      return `$${(h.marketCap / 1e6).toFixed(0)}M market cap (limit $${(t.minMarketCap / 1e6).toFixed(0)}M)`;
    }
    return LABELS[f] ?? f;
  });
  return parts.join("; ");
}

/**
 * Apply the guardrails across a ranked set.
 *
 * @param facts   ticker -> cached EDGAR facts
 * @param splits  ticker -> split history, for adjusting share counts. Cover-page
 *                share counts are never restated, so an unadjusted comparison
 *                reads a 10-for-1 split as +900% dilution and condemns whichever
 *                companies appreciated enough to split. See lib/splits.ts.
 */
export function applyHealth<T extends ScreenRow>(
  rows: readonly T[],
  facts: ReadonlyMap<string, HealthFacts>,
  splits: ReadonlyMap<string, readonly Split[]>,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  p: Params = DEFAULT_PARAMS,
): (T & HealthFields)[] {
  return rows.map((r) => {
    const f = facts.get(r.ticker);
    if (f == null) {
      return { ...r, health: null, healthCapped: false, healthReason: "" };
    }

    const health = assess(
      {
        price: r.price,
        shares: adjustSeries([...f.shares], [...(splits.get(r.ticker) ?? [])]),
        cash: f.cash,
        operatingCashFlow: f.ocf,
        revenue: f.revenue,
      },
      thresholds,
    );

    // Only a MEASURED breach caps. "unknown" passes through untouched: a
    // company we could not measure is not a company that failed, and treating
    // it as one would silently demote every filer we cannot read.
    const cap = health.verdict === "fail" && r.tier !== null && r.tier !== "Hold";
    if (!cap) {
      return { ...r, health, healthCapped: false, healthReason: describe(health, thresholds) };
    }

    return {
      ...r,
      health,
      healthCapped: true,
      healthReason: describe(health, thresholds),
      tier: "Hold" as Tier,
      // Re-weight, or the Hold row keeps a buy-side sleeve and the published
      // 52/35/13 split quietly stops adding up.
      weight: tierWeight("Hold", p),
    };
  });
}

/** How many rows the guardrails capped, for reporting. */
export function healthCappedCount(rows: readonly HealthFields[]): number {
  return rows.filter((r) => r.healthCapped).length;
}

/** How many rows could not be measured at all. */
export function healthUnknownCount(rows: readonly HealthFields[]): number {
  return rows.filter((r) => r.health == null || r.health.verdict === "unknown").length;
}
