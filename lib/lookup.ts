/**
 * The ad-hoc ticker lookup, as a reading of the screen rather than a second
 * screen.
 *
 * The lookup used to rank its own universe with the default parameters ($5
 * floor, same-day dollar volume, raw momentum tiers), so it disagreed with the
 * table it sat under: NVDA read Buy in the box and Hold on the screen. Now a
 * ranked name returns the screen's own MarketRow, and an unranked one is
 * explained with the same gates computeScreen applies -- isLiquid is the gate
 * itself, not a copy of it.
 */

import type { MarketRow } from "./market-rows";
import type { StalenessReport } from "./staleness";
import { exclusionReason } from "./theme";
import { REQUIRED_ANCHORS, type AnchorLabel } from "./types";

/** The screen's admission rules, as computeScreen applies them. */
export interface LookupGates {
  readonly minPrice: number;
  readonly minMedianDollarVolume: number;
}

/** What the store knows about one ticker, for explaining an absence. */
export interface LookupFacts {
  /** In the reference universe the screen ranks from. */
  readonly listed: boolean;
  /** The as-of session's bar, or null when it did not trade. */
  readonly now: { readonly close: number; readonly volume: number } | null;
  /** Median dollar volume over the liquidity window; null with no stored history. */
  readonly median: number | null;
  /** Anchors with a usable (positive) close. */
  readonly anchors: readonly AnchorLabel[];
}

/**
 * The persistent liquidity gate. A name with stored history is judged by its
 * median; a name with none falls back to today's dollar volume, because a
 * recent listing is unmeasured, not illiquid.
 */
export function isLiquid(
  median: number | null | undefined,
  today: { readonly close: number; readonly volume: number } | null | undefined,
  floor: number,
): boolean {
  const dv = today ? today.close * today.volume : 0;
  return median != null ? median >= floor : dv >= floor;
}

const ANCHOR_WORDS: Record<AnchorLabel, string> = {
  r1m: "1-month",
  r3m: "3-month",
  r6m: "6-month",
  r12m: "12-month",
};

const millions = (v: number) => `$${(v / 1e6).toFixed(1)}M`;

/** The first gate a ticker fails, in the order the screen applies them. */
export function whyNotRanked(f: LookupFacts, asOf: string, g: LookupGates): string {
  if (!f.listed) {
    // Stated, not diagnosed: ETFs, funds and unlisted symbols all land here,
    // while delisted names the backfill stored do not.
    return "not in the screen's reference list of US common stocks and ADRs";
  }
  if (!isLiquid(f.median, f.now, g.minMedianDollarVolume)) {
    const floor = `$${g.minMedianDollarVolume / 1e6}M`;
    if (f.median != null) {
      return `50-session median dollar volume ${millions(f.median)} is below the ${floor} floor`;
    }
    const today = f.now ? f.now.close * f.now.volume : 0;
    return `no stored history, and today's dollar volume ${millions(today)} is below the ${floor} floor`;
  }
  if (!f.now) return `no bar for ${asOf} — it did not trade that session`;
  if (f.now.close < g.minPrice) {
    return `price $${f.now.close.toFixed(2)} is below the $${g.minPrice} floor`;
  }
  const missing = REQUIRED_ANCHORS.filter((a) => !f.anchors.includes(a));
  if (missing.length > 0) {
    // Stated, not diagnosed: a new listing, a ticker change and a gap in the
    // stored bars all look the same from here.
    return `no stored ${missing.map((a) => ANCHOR_WORDS[a]).join(" or ")} price to measure from — a recent listing, a ticker change, or a gap in stored history`;
  }
  return "it passes every admission gate on stored data, but the screen did not rank it";
}

/** Where a ranked name appears on the page. */
function placementOf(r: MarketRow): string {
  // The book's 10-slot cap is a row note (bookCapped), shown with the others.
  if (r.inBook) return `In the AI book, under ${r.group}`;
  const where = `shown under ${r.group} in Whole market by group`;
  const held = exclusionReason(r.ticker);
  return held ? `Held out of the AI book (${held}); ${where}` : `Not an AI book name; ${where}`;
}

export interface LookupResult {
  readonly ticker: string;
  readonly found: boolean;
  /** The screen's own row, when ranked. */
  readonly row: MarketRow | null;
  /** Where a ranked name appears on the page. */
  readonly placement: string | null;
  /** Why an unranked name is absent. */
  readonly reason: string | null;
  readonly universeSize: number;
  readonly staleness: StalenessReport;
  readonly asOf: string;
}

/**
 * Answer a lookup from the screen. `facts` is consulted only when the name is
 * not ranked; null means they could not be loaded.
 */
export function describeLookup(
  ticker: string,
  screen: {
    readonly asOf: string;
    readonly universeSize: number;
    readonly staleness: StalenessReport;
    readonly market: readonly MarketRow[];
  },
  facts: LookupFacts | null,
  gates: LookupGates,
): LookupResult {
  const row = screen.market.find((r) => r.ticker === ticker) ?? null;
  return {
    ticker,
    found: row !== null,
    row,
    placement: row ? placementOf(row) : null,
    reason: row
      ? null
      : facts
        ? whyNotRanked(facts, screen.asOf, gates)
        : "Not on the ranked screen, and its stored data could not be read to say why.",
    universeSize: screen.universeSize,
    staleness: screen.staleness,
    asOf: screen.asOf,
  };
}
