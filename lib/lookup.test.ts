import { describe, expect, it } from "vitest";
import { describeLookup, isLiquid, whyNotRanked, type LookupFacts } from "./lookup";
import type { MarketRow } from "./market-rows";

const GATES = { minPrice: 1, minMedianDollarVolume: 10_000_000 };

function facts(over: Partial<LookupFacts> = {}): LookupFacts {
  return {
    listed: true,
    now: { close: 50, volume: 1_000_000 },
    median: 50_000_000,
    anchors: ["r3m", "r6m", "r12m"],
    ...over,
  };
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  return {
    ticker: "XOM",
    name: "Exxon Mobil",
    group: "Energy",
    groupKind: "sector",
    badge: null,
    sector: "Energy",
    subsector: "Oil",
    price: 110,
    dollarVolume: 2e9,
    r3m: 5,
    r12m: 10,
    rsPct: 81.6,
    vsMa: 3,
    tier: "Buy",
    bandTier: "Buy",
    stage: null,
    gate: "pass",
    heldDown: [],
    inBook: false,
    bookCapped: false,
    ...over,
  };
}

const SCREEN = {
  asOf: "2026-10-09",
  universeSize: 2336,
  staleness: { freshness: "current" as const, sessionsBehind: 0, label: "Current" },
};

describe("isLiquid", () => {
  it("judges a name with history by its median, not by today", () => {
    expect(isLiquid(9_000_000, { close: 100, volume: 1_000_000 }, 10_000_000)).toBe(false);
    expect(isLiquid(11_000_000, { close: 1, volume: 1 }, 10_000_000)).toBe(true);
  });

  it("falls back to today's dollar volume for a name with no history", () => {
    expect(isLiquid(undefined, { close: 20, volume: 600_000 }, 10_000_000)).toBe(true);
    expect(isLiquid(undefined, { close: 20, volume: 400_000 }, 10_000_000)).toBe(false);
    expect(isLiquid(undefined, undefined, 10_000_000)).toBe(false);
  });
});

describe("whyNotRanked", () => {
  it("names a ticker the reference universe does not carry", () => {
    expect(whyNotRanked(facts({ listed: false }), "2026-10-09", GATES)).toMatch(
      /not in the reference universe/,
    );
    expect(whyNotRanked(facts({ listed: false }), "2026-10-09", GATES)).toMatch(/common stocks and ADRs, not ETFs/);
  });

  it("names a missing bar for the session", () => {
    expect(whyNotRanked(facts({ now: null }), "2026-10-09", GATES)).toMatch(
      /no bar for 2026-10-09/,
    );
  });

  it("reports the 50-session median against the $10M floor", () => {
    const why = whyNotRanked(facts({ median: 4_200_000 }), "2026-10-09", GATES);
    expect(why).toMatch(/median dollar volume \$4\.2M/);
    expect(why).toMatch(/\$10M/);
  });

  it("reports today's dollar volume when there is no history", () => {
    const why = whyNotRanked(
      facts({ median: null, now: { close: 10, volume: 300_000 } }),
      "2026-10-09",
      GATES,
    );
    expect(why).toMatch(/\$3\.0M/);
    expect(why).toMatch(/no stored history/);
  });

  it("reports a price under the $1 floor, not the old $5 one", () => {
    expect(whyNotRanked(facts({ now: { close: 0.8, volume: 1e8 } }), "2026-10-09", GATES)).toMatch(
      /\$0\.80 is below the \$1 floor/,
    );
    expect(whyNotRanked(facts({ now: { close: 3, volume: 1e8 }, anchors: [] }), "2026-10-09", GATES))
      .not.toMatch(/floor/);
  });

  it("names the missing return anchors without guessing at the cause", () => {
    const why = whyNotRanked(facts({ anchors: ["r3m"] }), "2026-10-09", GATES);
    expect(why).toMatch(/no stored 6-month or 12-month price/);
    expect(why).not.toMatch(/likely/);
  });
});

describe("describeLookup", () => {
  it("returns the screen's own row, unchanged", () => {
    const r = row();
    const out = describeLookup("XOM", { ...SCREEN, market: [r] }, null, GATES);
    expect(out.found).toBe(true);
    expect(out.row).toBe(r);
    expect(out.reason).toBeNull();
  });

  it("places a non-theme name in its whole-market group", () => {
    const out = describeLookup("XOM", { ...SCREEN, market: [row()] }, null, GATES);
    expect(out.placement).toMatch(/Energy/);
    expect(out.placement).toMatch(/Whole market by group/);
    expect(out.placement).not.toMatch(/theme/);
  });

  it("says why a theme name is held out of the book", () => {
    const out = describeLookup(
      "MSFT",
      { ...SCREEN, market: [row({ ticker: "MSFT", group: "AI spenders" })] },
      null,
      GATES,
    );
    expect(out.placement).toMatch(/net AI CapEx spender/);
  });

  it("places a book name in the AI book", () => {
    const out = describeLookup(
      "LITE",
      { ...SCREEN, market: [row({ ticker: "LITE", inBook: true, tier: "Strong Buy" })] },
      null,
      GATES,
    );
    expect(out.placement).toBe("In the AI book, under Energy");
  });

  it("explains a missing name from its facts", () => {
    const out = describeLookup("TINY", { ...SCREEN, market: [] }, facts({ median: 1e6 }), GATES);
    expect(out.found).toBe(false);
    expect(out.row).toBeNull();
    expect(out.reason).toMatch(/median dollar volume/);
  });

  it("says plainly when it has no facts to explain with", () => {
    const out = describeLookup("TINY", { ...SCREEN, market: [] }, null, GATES);
    expect(out.reason).toMatch(/not on the ranked screen/i);
  });
});
