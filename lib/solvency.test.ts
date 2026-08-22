import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  assess,
  dedupe,
  dilution,
  latest,
  quarterlySeries,
  runwayMonths,
  trailingBurn,
  yearEarlier,
  type FactPoint,
} from "./solvency";

/**
 * A cumulative year-to-date series, the shape a 10-Q actually reports.
 *
 * Values are given in millions and scaled here, so a fixture's cash and its
 * cash flow are always in the same unit. The first draft of this file mixed
 * dollars and bare millions and produced a two-million-month runway.
 */
const ytd = (year: number, millions: number[]): FactPoint[] =>
  millions.map((m, i) => ({
    start: `${year}-01-01`,
    end: [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`][i],
    val: m * 1e6,
    fp: ["Q1", "Q2", "Q3", "FY"][i],
  }));

describe("dedupe", () => {
  it("keeps one point per period, the last one filed", () => {
    const out = dedupe([
      { end: "2026-03-31", start: "2026-01-01", val: -100 },
      { end: "2026-03-31", start: "2026-01-01", val: -110 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].val).toBe(-110);
  });

  it("does not merge periods that share an end but not a start", () => {
    const out = dedupe([
      { end: "2026-06-30", start: "2026-01-01", val: -200 },
      { end: "2026-06-30", start: "2026-04-01", val: -90 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("drops non-finite values rather than propagating them", () => {
    expect(dedupe([{ end: "2026-03-31", val: Number.NaN }])).toHaveLength(0);
  });

  it("returns points oldest first", () => {
    const out = dedupe([
      { end: "2026-06-30", val: 2 },
      { end: "2025-06-30", val: 1 },
    ]);
    expect(out.map((p) => p.val)).toEqual([1, 2]);
  });
});

describe("yearEarlier", () => {
  /**
   * The trap this exists for: quarterly XBRL series skip fiscal Q4, because the
   * 10-K carries the annual figure instead. Counting four points back is
   * therefore NOT a year back, and the error compounds every year.
   */
  it("matches by date, not by counting points back", () => {
    const points: FactPoint[] = [
      { end: "2025-02-10", val: 100 },
      { end: "2025-05-10", val: 105 },
      { end: "2025-08-10", val: 110 },
      // no Q4 point -- the gap that breaks index arithmetic
      { end: "2026-02-10", val: 120 },
      { end: "2026-05-10", val: 130 },
    ];
    const found = yearEarlier(points, "2026-05-10");
    expect(found!.end).toBe("2025-05-10");
    expect(found!.val).toBe(105);
  });

  it("refuses a match that is not close to a year away", () => {
    const points: FactPoint[] = [
      { end: "2024-01-01", val: 50 },
      { end: "2026-05-10", val: 130 },
    ];
    expect(yearEarlier(points, "2026-05-10")).toBeNull();
  });

  it("accepts a near miss inside the tolerance", () => {
    const points: FactPoint[] = [
      { end: "2025-06-15", val: 100 },
      { end: "2026-05-10", val: 130 },
    ];
    expect(yearEarlier(points, "2026-05-10")!.val).toBe(100);
  });
});

describe("dilution", () => {
  const shares: FactPoint[] = [
    { end: "2025-07-24", val: 100e6 },
    { end: "2026-07-24", val: 140e6 },
  ];

  it("measures share count growth over a year", () => {
    expect(dilution(shares)!.growth).toBeCloseTo(0.4, 10);
    expect(dilution(shares)!.asOf).toBe("2026-07-24");
  });

  it("reports a buyback as negative growth", () => {
    const out = dilution([
      { end: "2025-07-24", val: 100e6 },
      { end: "2026-07-24", val: 92e6 },
    ]);
    expect(out!.growth).toBeCloseTo(-0.08, 10);
  });

  it("is null without a comparable point a year back", () => {
    expect(dilution([{ end: "2026-07-24", val: 100e6 }])).toBeNull();
  });

  it("refuses nonsense share counts", () => {
    expect(dilution([{ end: "2025-07-24", val: 0 }, { end: "2026-07-24", val: 10 }])).toBeNull();
  });
});

describe("quarterlySeries", () => {
  /**
   * The core correction. MRNA's real 2026 filings: Q1 reports -630M for one
   * quarter, Q2 reports -1156M for SIX MONTHS. Reading Q2 as a quarter
   * overstates the burn by 2.2x, and by Q4 the same mistake overstates by 4x.
   */
  it("recovers standalone quarters from cumulative reporting", () => {
    const out = quarterlySeries(ytd(2026, [-630, -1156, -1800, -2500]));
    expect(out.map((p) => Math.round(p.val / 1e6))).toEqual([-630, -526, -644, -700]);
  });

  it("leaves an already-quarterly period alone", () => {
    const out = quarterlySeries([
      { start: "2026-01-01", end: "2026-03-31", val: -100 },
      { start: "2026-04-01", end: "2026-06-30", val: -120 },
    ]);
    expect(out.map((p) => p.val)).toEqual([-100, -120]);
  });

  it("keeps fiscal years separate rather than differencing across them", () => {
    const out = quarterlySeries([...ytd(2025, [-100, -250]), ...ytd(2026, [-90, -200])]);
    // Without grouping by start, 2026 Q1 would come out as -90 - (-250) = +160.
    expect(out.map((p) => p.val / 1e6)).toEqual([-100, -150, -90, -110]);
    expect(out.every((p) => p.val < 0)).toBe(true);
  });

  it("ignores instantaneous points that have no period", () => {
    expect(quarterlySeries([{ end: "2026-03-31", val: 500 }])).toEqual([]);
  });
});

describe("trailingBurn", () => {
  it("sums four real quarters when they span a year", () => {
    const b = trailingBurn(ytd(2026, [-630, -1156, -1800, -2500]));
    expect(b!.method).toBe("ttm");
    expect(Math.round(b!.annual / 1e6)).toBe(-2500);
  });

  /**
   * A young filer with two quarters is exactly the kind of name this exercise
   * is about. Refusing to estimate would exclude it for being new rather than
   * for being weak -- so the fallback annualises, and says that it did.
   */
  it("annualises a partial year and reports the method", () => {
    const b = trailingBurn(ytd(2026, [-500, -1000]));
    expect(b!.method).toBe("annualised");
    // 181 days of -1000M scaled to 365.
    expect(b!.annual / 1e6).toBeLessThan(-1900);
    expect(b!.annual / 1e6).toBeGreaterThan(-2100);
  });

  it("will not annualise from a period too short to mean anything", () => {
    expect(
      trailingBurn([{ start: "2026-03-01", end: "2026-03-20", val: -50 }]),
    ).toBeNull();
  });

  it("is null with nothing to measure", () => {
    expect(trailingBurn([])).toBeNull();
    expect(trailingBurn([{ end: "2026-03-31", val: -50 }])).toBeNull();
  });

  it("reports a cash-generative company as positive", () => {
    expect(trailingBurn(ytd(2026, [100, 220, 350, 500]))!.annual / 1e6).toBeCloseTo(500, 6);
  });
});

describe("runwayMonths", () => {
  it("divides cash by the monthly burn", () => {
    expect(runwayMonths(1200, { annual: -1200, method: "ttm", asOf: "2026-06-30" }))
      .toBeCloseTo(12, 6);
    expect(runwayMonths(600, { annual: -1200, method: "ttm", asOf: "2026-06-30" }))
      .toBeCloseTo(6, 6);
  });

  /**
   * A profitable company has no runway in this sense. Returning a huge number
   * would invite a comparison against burning companies that means nothing.
   */
  it("is null for a company that is not burning", () => {
    expect(runwayMonths(1000, { annual: 500, method: "ttm", asOf: "2026-06-30" })).toBeNull();
  });

  it("is null without cash or without a burn figure", () => {
    expect(runwayMonths(0, { annual: -100, method: "ttm", asOf: "2026-06-30" })).toBeNull();
    expect(runwayMonths(1000, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

const healthy = {
  price: 30,
  shares: [
    { end: "2025-07-24", val: 100e6 },
    { end: "2026-07-24", val: 101e6 },
  ] as FactPoint[],
  cash: 2_000e6,
  operatingCashFlow: ytd(2026, [200, 420, 650, 900]),
};

describe("assess", () => {
  it("passes a solid company", () => {
    const h = assess(healthy);
    expect(h.verdict).toBe("pass");
    expect(h.failures).toEqual([]);
    expect(h.marketCap).toBeCloseTo(101e6 * 30, 0);
  });

  it("fails a serial diluter", () => {
    const h = assess({
      ...healthy,
      shares: [
        { end: "2025-07-24", val: 100e6 },
        { end: "2026-07-24", val: 145e6 },
      ],
    });
    expect(h.verdict).toBe("fail");
    expect(h.failures).toContain("dilution");
  });

  it("fails a shell on market cap regardless of its share price", () => {
    // $40 a share and still a $40M company: exactly the case the $5 price
    // floor waves through and this check exists to catch.
    const h = assess({ ...healthy, price: 40, shares: [{ end: "2026-07-24", val: 1e6 }] });
    expect(h.failures).toContain("market cap");
  });

  it("fails a company that runs out of cash before a year", () => {
    const h = assess({
      ...healthy,
      cash: 100e6,
      operatingCashFlow: ytd(2026, [-150, -300, -450, -600]),  // -600M a year
    });
    expect(h.verdict).toBe("fail");
    expect(h.failures).toContain("runway");
  });

  it("passes a burning company with enough cash", () => {
    const h = assess({
      ...healthy,
      cash: 1_200e6,
      operatingCashFlow: ytd(2026, [-150, -300, -450, -600]),  // -600M a year
    });
    expect(h.verdict).toBe("pass");
    expect(h.runway).toBeCloseTo(24, 0);
  });

  /**
   * The distinction the whole module turns on. A company we could not measure
   * is not a company that failed -- treating unknown as fail would silently
   * drop every foreign filer and every name whose CIK never resolved, with
   * nothing on screen saying so.
   */
  it("separates unknown from fail", () => {
    const h = assess({ price: 30, shares: [], cash: null, operatingCashFlow: [] });
    expect(h.verdict).toBe("unknown");
    expect(h.failures).toEqual([]);
    expect(h.missing).toEqual(["market cap", "dilution", "runway"]);
  });

  it("still passes on what it could measure when only some data is missing", () => {
    const h = assess({ ...healthy, cash: null, operatingCashFlow: [] });
    expect(h.verdict).toBe("pass");
    expect(h.missing).toEqual(["runway"]);
  });

  it("fails on a measured breach even when other checks are missing", () => {
    const h = assess({
      price: 30,
      shares: [
        { end: "2025-07-24", val: 100e6 },
        { end: "2026-07-24", val: 200e6 },
      ],
      cash: null,
      operatingCashFlow: [],
    });
    expect(h.verdict).toBe("fail");
    expect(h.failures).toEqual(["dilution"]);
    expect(h.missing).toContain("runway");
  });

  it("honours custom thresholds", () => {
    const strict = { ...DEFAULT_THRESHOLDS, maxDilution: 0.005 };
    expect(assess(healthy, strict).failures).toContain("dilution");
    expect(assess(healthy).failures).not.toContain("dilution");
  });
});

describe("assess: runway only applies to companies that cannot fund themselves", () => {
  const burning = {
    price: 30,
    shares: [
      { end: "2025-07-24", val: 100e6 },
      { end: "2026-07-24", val: 101e6 },
    ] as FactPoint[],
    cash: 1_290e6,
    operatingCashFlow: ytd(2026, [-2500, -5000, -7557]),
  };

  /**
   * The SMCI false alarm. $7.6bn of inventory build against $25bn of revenue
   * read as "2 months of runway" -- insolvency, on one of the largest
   * operating businesses in the universe.
   */
  it("skips the test when revenue exceeds the burn", () => {
    const h = assess({ ...burning, revenue: 25_000e6 });
    expect(h.verdict).toBe("pass");
    expect(h.failures).not.toContain("runway");
    expect(h.missing).not.toContain("runway");
  });

  it("still applies it to a pre-revenue burner", () => {
    const h = assess({ ...burning, revenue: 0 });
    expect(h.verdict).toBe("fail");
    expect(h.failures).toContain("runway");
  });

  it("applies it when revenue is real but smaller than the burn", () => {
    const h = assess({ ...burning, revenue: 300e6 });
    expect(h.failures).toContain("runway");
  });

  /** Unknown revenue must not silently exempt a company from the test. */
  it("applies it when revenue is unknown", () => {
    expect(assess(burning).failures).toContain("runway");
    expect(assess({ ...burning, revenue: null }).failures).toContain("runway");
  });
});
