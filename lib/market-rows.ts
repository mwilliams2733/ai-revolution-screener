/**
 * The market-wide row, and the AI book as a filter of the same rows.
 *
 * Every ranked name runs the same overlays. The book is not computed
 * separately -- splitBook filters the overlaid rows -- so a tier means the same
 * thing in the grouped view and in the book, except for the 10-slot cap, which
 * only the book applies.
 */

import { groupOf, type GroupKind } from "./groups";
import type { TrendFields } from "./trend-overlay";
import type { StageFields } from "./stage-overlay";
import type { HysteresisFields } from "./hysteresis";
import type { GateFields, GateVerdict } from "./fundamental-gate";
import type { HealthFields } from "./health-overlay";
import type { Stage } from "./trend-template";
import type { SectorLabels } from "./sic";
import type { ScreenRow, Tier } from "./types";

/** A ranked row after every overlay and before the cap. */
export type GuardedRow = ScreenRow &
  TrendFields &
  StageFields &
  HysteresisFields &
  GateFields &
  HealthFields;

/** Trimmed for transport: ~2,300 of these go to the browser. */
export interface MarketRow {
  readonly ticker: string;
  readonly name: string;
  readonly group: string;
  readonly groupKind: GroupKind;
  readonly badge: string | null;
  /** SIC sector and subsector, kept for the ticker detail and the health script. */
  readonly sector: string;
  readonly subsector: string;
  readonly price: number;
  readonly dollarVolume: number;
  readonly r3m: number;
  readonly r12m: number;
  readonly rsPct: number | null;
  readonly vsMa: number;
  /** Final tier after every overlay, with no Strong Buy cap. */
  readonly tier: Tier | null;
  /** Tier after the band and before the overlays; tomorrow's hysteresis input. */
  readonly bandTier: Tier | null;
  readonly stage: Stage | null;
  readonly gate: GateVerdict;
  readonly heldDown: readonly string[];
  /** In the AI book (theme member, not a spender, not vetoed). */
  readonly inBook: boolean;
  /** A book Strong Buy that the 10-slot cap moved to Buy. */
  readonly bookCapped: boolean;
}

export function heldDownReasons(r: GuardedRow): string[] {
  const out: string[] = [];
  if (r.stageCapped && r.stageReason) out.push(r.stageReason);
  if (r.momentumTier === "Strong Buy" && r.gate === "demote") {
    out.push(`Momentum Strong Buy, held at Buy — ${r.gateReason}`);
  }
  if (r.healthCapped && r.healthReason) out.push(r.healthReason);
  return out;
}

export function toMarketRow(
  r: GuardedRow,
  labels: SectorLabels | undefined,
  book: { inBook: boolean; bookCapped: boolean },
): MarketRow {
  const group = groupOf(r.ticker, labels);
  return {
    ticker: r.ticker,
    name: r.name,
    group: group.name,
    groupKind: group.kind,
    badge: group.badge,
    sector: labels?.sector ?? "Other",
    subsector: labels?.subsector ?? "Unclassified",
    price: r.price,
    dollarVolume: r.dollarVolume,
    r3m: r.r3m,
    r12m: r.r12m,
    rsPct: r.rsPct,
    vsMa: r.vsMa,
    tier: r.tier,
    bandTier: r.bandTier,
    stage: r.stage?.stage ?? null,
    gate: r.gate,
    heldDown: heldDownReasons(r),
    inBook: book.inBook,
    bookCapped: book.bookCapped,
  };
}

/** The AI book: rows whose ticker is in `theme`, with the theme sector set. Order preserved. */
export function splitBook<T extends ScreenRow>(
  rows: readonly T[],
  theme: ReadonlyMap<string, string>,
): T[] {
  return rows
    .filter((r) => theme.has(r.ticker))
    .map((r) => ({ ...r, sector: theme.get(r.ticker) as string }));
}
