import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS as P, withParams } from "./params";
import {
  applyTiers,
  assignTier,
  buildPortfolio,
  isMonotonic,
  tierCap,
  tierSummary,
  tierWeight,
  totalAllocation,
} from "./tiers";
import { CAPEX_SPENDERS, CROWDING_VETO, exclusionReason, themeUniverse } from "./theme";
import type { ScreenRow, Tier } from "./types";

// ---------------------------------------------------------------------------
// The real portfolio, as published in the position-size calculator on
// 2026-08-19, with RS percentiles measured against 2,204 liquid US common
// stocks. This is the regression fixture: if a ruleset change moves the match
// rate, that is signal. See STRATEGY_DECODED.md section 5.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly ticker: string;
  readonly rsPct: number;
  readonly vsMa: number;
  readonly r12m: number;
  readonly published: Tier;
}

const PORTFOLIO: readonly Fixture[] = [
  { ticker: "LITE", rsPct: 99, vsMa: 29.2, r12m: 601.6, published: "Strong Buy" },
  { ticker: "MRVL", rsPct: 98, vsMa: 56.2, r12m: 229.2, published: "Strong Buy" },
  { ticker: "FTNT", rsPct: 89, vsMa: 27.2, r12m: 95.7, published: "Buy" },
  { ticker: "CRS", rsPct: 87, vsMa: 22.1, r12m: 111.1, published: "Buy" },
  { ticker: "AGX", rsPct: 84, vsMa: 10.4, r12m: 147.0, published: "Strong Buy" },
  { ticker: "LLY", rsPct: 82, vsMa: 23.4, r12m: 82.1, published: "Strong Buy" },
  { ticker: "VRT", rsPct: 69, vsMa: 4.6, r12m: 102.2, published: "Buy" },
  { ticker: "PLTR", rsPct: 68, vsMa: 19.0, r12m: 11.1, published: "Hold" },
  { ticker: "RDW", rsPct: 68, vsMa: 19.8, r12m: 40.3, published: "Buy" },
  { ticker: "TOST", rsPct: 67, vsMa: 10.6, r12m: -16.3, published: "Strong Buy" },
  { ticker: "FFIV", rsPct: 59, vsMa: 8.4, r12m: 21.3, published: "Buy" },
  { ticker: "NVDA", rsPct: 47, vsMa: 8.6, r12m: 23.9, published: "Hold" },
  { ticker: "KTOS", rsPct: 15, vsMa: -4.2, r12m: -5.4, published: "Hold" },
  { ticker: "EVLV", rsPct: 12, vsMa: -7.3, r12m: -28.4, published: "Hold" },
  { ticker: "SYM", rsPct: 8, vsMa: -9.3, r12m: -10.2, published: "Buy" },
];

const TIER_ORDER: Record<Tier, number> = { "Strong Buy": 0, Buy: 1, Hold: 2 };

function row(f: Partial<ScreenRow> & { ticker: string }): ScreenRow {
  return {
    name: "", sector: "", price: 100, dollarVolume: 1e8,
    r1m: 0, r3m: 0, r6m: 0, r12m: 0, maProxy: 100, vsMa: 0,
    rsRaw: 0, rsPct: null, tier: null, weight: 0, ...f,
  };
}

// ---------------------------------------------------------------------------

describe("assignTier", () => {
  it("requires both a high RS and a positive trend for Strong Buy", () => {
    expect(assignTier(99, 29.2, P)).toBe("Strong Buy");
    // High RS but below the moving average falls through to Buy.
    expect(assignTier(99, -1, P)).toBe("Hold");
    // Strong trend but weak RS does not promote.
    expect(assignTier(40, 50, P)).toBe("Hold");
  });

  it("handles the exact cutoff boundaries", () => {
    expect(assignTier(80, 0.01, P)).toBe("Strong Buy");
    expect(assignTier(80, 0, P)).toBe("Buy"); // strongTrend is exclusive
    expect(assignTier(79.99, 5, P)).toBe("Buy");
    expect(assignTier(55, 0, P)).toBe("Buy"); // buyTrend is inclusive
    expect(assignTier(54.99, 5, P)).toBe("Hold");
    expect(assignTier(60, -0.01, P)).toBe("Hold");
  });

  it("respects overridden cutoffs", () => {
    const p = withParams({ strongRs: 95, buyRs: 90 });
    expect(assignTier(92, 10, p)).toBe("Buy");
    expect(assignTier(96, 10, p)).toBe("Strong Buy");
  });
});

describe("reproduction of the published portfolio", () => {
  const results = PORTFOLIO.map((f) => ({
    ...f,
    model: assignTier(f.rsPct, f.vsMa, P),
  }));

  it("matches at least 10 of 15 tiers exactly", () => {
    const exact = results.filter((r) => r.model === r.published).length;
    expect(exact).toBe(10);
    expect(exact / results.length).toBeGreaterThanOrEqual(0.66);
  });

  it("is never off by more than one tier", () => {
    for (const r of results) {
      const d = Math.abs(TIER_ORDER[r.model] - TIER_ORDER[r.published]);
      expect(d, `${r.ticker}: model=${r.model} published=${r.published}`).toBeLessThanOrEqual(1);
    }
  });

  it("identifies the known overrides", () => {
    const misses = results.filter((r) => r.model !== r.published).map((r) => r.ticker);
    // FTNT/CRS held back and TOST promoted are the fundamental overlay.
    // PLTR is the buy-up-to mechanism. SYM is the flagged drop candidate.
    expect(misses.sort()).toEqual(["CRS", "FTNT", "PLTR", "SYM", "TOST"]);
  });

  it("keeps mean RS percentile monotonic across published tiers", () => {
    const mean = (t: Tier) => {
      const g = PORTFOLIO.filter((f) => f.published === t);
      return g.reduce((a, f) => a + f.rsPct, 0) / g.length;
    };
    const strong = mean("Strong Buy");
    const buy = mean("Buy");
    const hold = mean("Hold");
    expect(strong).toBeGreaterThan(buy);
    expect(buy).toBeGreaterThan(hold);
    // The headline finding: 86.0 / 63.3 / 35.5.
    expect(strong).toBeCloseTo(86.0, 1);
    expect(buy).toBeCloseTo(63.3, 1);
    expect(hold).toBeCloseTo(35.5, 1);
  });

  it("confirms 12-month return separates the published tiers too", () => {
    const mean = (t: Tier) => {
      const g = PORTFOLIO.filter((f) => f.published === t);
      return g.reduce((a, f) => a + f.r12m, 0) / g.length;
    };
    expect(mean("Strong Buy")).toBeGreaterThan(mean("Buy"));
    expect(mean("Buy")).toBeGreaterThan(mean("Hold"));
  });
});

describe("tier weights", () => {
  it("reproduces the published 52/35/13 split", () => {
    expect(P.nStrong * tierWeight("Strong Buy", P) * 100).toBeCloseTo(52.0, 1);
    expect(P.nBuy * tierWeight("Buy", P) * 100).toBeCloseTo(35.0, 1);
    expect(P.nHold * tierWeight("Hold", P) * 100).toBeCloseTo(13.0, 1);
  });

  it("fully allocates the sleeve", () => {
    const total =
      P.nStrong * P.wStrong + P.nBuy * P.wBuy + P.nHold * P.wHold;
    expect(total * 100).toBeCloseTo(100, 1);
  });

  it("preserves the 2.86 : 1.92 : 1.00 ratio", () => {
    expect(P.wStrong / P.wHold).toBeCloseTo(2.858, 2);
    expect(P.wBuy / P.wHold).toBeCloseTo(1.923, 2);
  });

  it("exposes per-tier caps", () => {
    expect(tierCap("Strong Buy", P)).toBe(7);
    expect(tierCap("Buy", P)).toBe(7);
    expect(tierCap("Hold", P)).toBe(5);
  });
});

describe("applyTiers", () => {
  it("fills tier and weight from rsPct and vsMa", () => {
    const out = applyTiers([row({ ticker: "A", rsPct: 90, vsMa: 10 })], P);
    expect(out[0].tier).toBe("Strong Buy");
    expect(out[0].weight).toBeCloseTo(P.wStrong, 10);
  });

  it("leaves unranked rows untouched", () => {
    const out = applyTiers([row({ ticker: "A", rsPct: null })], P);
    expect(out[0].tier).toBeNull();
    expect(out[0].weight).toBe(0);
  });
});

describe("buildPortfolio", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    row({ ticker: `T${i}`, rsPct: 100 - i * 2.5, vsMa: 50 - i, rsRaw: 1000 - i }),
  );

  it("caps each tier at its target count", () => {
    const port = buildPortfolio(applyTiers(many, P), P);
    const count = (t: Tier) => port.filter((r) => r.tier === t).length;
    expect(count("Strong Buy")).toBeLessThanOrEqual(P.nStrong);
    expect(count("Buy")).toBeLessThanOrEqual(P.nBuy);
    expect(count("Hold")).toBeLessThanOrEqual(P.nHold);
    expect(port.length).toBeLessThanOrEqual(P.nStrong + P.nBuy + P.nHold);
  });

  it("takes the strongest names in each tier", () => {
    const port = buildPortfolio(applyTiers(many, P), P);
    const strong = port.filter((r) => r.tier === "Strong Buy");
    expect(strong[0].ticker).toBe("T0");
  });

  it("skips rows with no tier", () => {
    expect(buildPortfolio([row({ ticker: "X", rsPct: null })], P)).toHaveLength(0);
  });

  it("never over-allocates beyond the published rounding", () => {
    // A full 7/7/5 book sums to 100.01%, not 100%: their published tier weights
    // are rounded (7 x 7.43% = 52.01%, not 52.00%). Anything materially above
    // this means the tier caps leaked.
    const port = buildPortfolio(applyTiers(many, P), P);
    expect(totalAllocation(port)).toBeLessThanOrEqual(1.0002);
  });

  it("sums a full book to the published 100.01%", () => {
    const port = buildPortfolio(applyTiers(many, P), P);
    if (port.length === P.nStrong + P.nBuy + P.nHold) {
      expect(totalAllocation(port) * 100).toBeCloseTo(100.01, 2);
    }
  });
});

describe("tierSummary", () => {
  const rows = applyTiers(
    PORTFOLIO.map((f) =>
      row({ ticker: f.ticker, rsPct: f.rsPct, vsMa: f.vsMa, r12m: f.r12m }),
    ),
    P,
  );

  it("reports one entry per tier in strength order", () => {
    const s = tierSummary(rows);
    expect(s.map((x) => x.tier)).toEqual(["Strong Buy", "Buy", "Hold"]);
  });

  it("produces a monotonic RS ladder", () => {
    expect(isMonotonic(tierSummary(rows))).toBe(true);
  });

  it("counts and weights add up", () => {
    const s = tierSummary(rows);
    expect(s.reduce((a, x) => a + x.count, 0)).toBe(PORTFOLIO.length);
    expect(s.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(totalAllocation(rows), 10);
  });
});

describe("theme gate", () => {
  const uni = themeUniverse();

  it("excludes every CapEx spender", () => {
    for (const t of ["MSFT", "GOOGL", "META", "AMZN"]) {
      expect(uni.has(t), `${t} should be excluded`).toBe(false);
      expect(exclusionReason(t)).toBe("net AI CapEx spender");
    }
  });

  it("excludes the memory and storage cohort", () => {
    for (const t of ["SNDK", "MU", "WDC", "STX"]) {
      expect(uni.has(t), `${t} should be vetoed`).toBe(false);
      expect(exclusionReason(t)).toBe("crowding veto: memory/storage");
    }
  });

  it("can opt back into vetoed names", () => {
    expect(themeUniverse({ includeVetoed: true }).has("MU")).toBe(true);
  });

  // Regression: this previously passed while surfacing only MU. Every other
  // vetoed ticker sat in CROWDING_VETO but in no THEME sector, so themeUniverse
  // could never return it and the "grey out, do not drop" requirement was
  // silently unimplementable. Assert the whole set, not one sample of it.
  it("can opt back into EVERY vetoed name", () => {
    const withVeto = themeUniverse({ includeVetoed: true });
    for (const t of CROWDING_VETO) {
      expect(withVeto.has(t), `${t} must be recoverable for the UI`).toBe(true);
    }
  });

  it("keeps every vetoed name hidden by default", () => {
    for (const t of CROWDING_VETO) {
      expect(uni.has(t), `${t} should be vetoed by default`).toBe(false);
      expect(exclusionReason(t)).toBe("crowding veto: memory/storage");
    }
  });

  it("keeps the CapEx-taker core", () => {
    for (const t of ["NVDA", "MRVL", "ARM", "LITE", "VRT", "AGX", "CRS", "FTNT", "KTOS"]) {
      expect(uni.has(t), `${t} should be present`).toBe(true);
    }
  });

  it("resolves each ticker to exactly one sector", () => {
    expect(uni.get("PLTR")).toBe("data_infra_software"); // declared before defense
    expect(new Set(uni.keys()).size).toBe(uni.size);
  });

  it("honours a reference-universe restriction", () => {
    const restricted = themeUniverse({ restrictTo: new Set(["NVDA", "MRVL"]) });
    expect(restricted.size).toBe(2);
  });

  it("has no overlap between the veto and spender sets", () => {
    for (const t of CROWDING_VETO) expect(CAPEX_SPENDERS.has(t)).toBe(false);
  });

  it("is large enough to rank meaningfully", () => {
    expect(uni.size).toBeGreaterThan(90);
  });
});
