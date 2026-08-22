import { describe, expect, it } from "vitest";
import {
  adjustSeries,
  byTicker,
  factorSince,
  pendingRefetches,
  refetchTargets,
  splitKey,
  tickersNeedingRefetch,
  type Split,
} from "./splits";
import { dilution } from "./solvency";

const split = (ticker: string, executionDate: string, from: number, to: number): Split => ({
  ticker,
  executionDate,
  from,
  to,
});

describe("factorSince", () => {
  const klac = [split("KLAC", "2026-06-12", 1, 10)];

  it("restates a pre-split date onto the current basis", () => {
    expect(factorSince(klac, "2025-07-21")).toBe(10);
  });

  it("leaves a post-split date alone", () => {
    expect(factorSince(klac, "2026-08-03")).toBe(1);
  });

  /**
   * A count reported ON the execution date already reflects the split.
   * Applying it again would double-count and invent dilution of exactly the
   * split ratio -- the same bug in a different direction.
   */
  it("does not apply a split executed on the date itself", () => {
    expect(factorSince(klac, "2026-06-12")).toBe(1);
  });

  it("inverts for a reverse split", () => {
    expect(factorSince([split("X", "2026-01-01", 20, 1)], "2025-06-01")).toBeCloseTo(0.05, 10);
  });

  it("compounds multiple splits", () => {
    const many = [split("X", "2025-01-01", 1, 2), split("X", "2026-01-01", 1, 5)];
    expect(factorSince(many, "2024-06-01")).toBe(10);
    expect(factorSince(many, "2025-06-01")).toBe(5);
    expect(factorSince(many, "2026-06-01")).toBe(1);
  });

  it("is 1 with no splits and ignores malformed ratios", () => {
    expect(factorSince([], "2025-01-01")).toBe(1);
    expect(factorSince([split("X", "2026-01-01", 0, 10)], "2025-01-01")).toBe(1);
    expect(factorSince([split("X", "2026-01-01", 1, 0)], "2025-01-01")).toBe(1);
  });

  it("is 1 for an unparseable date rather than NaN", () => {
    expect(factorSince([split("X", "2026-01-01", 1, 10)], "not-a-date")).toBe(1);
  });
});

describe("adjustSeries with dilution", () => {
  /**
   * The real KLAC numbers that produced "+890% dilution". Adjusted, KLAC turns
   * out to have BOUGHT BACK stock over the year.
   */
  const klacShares = [
    { end: "2025-07-21", val: 131.96e6 },
    { end: "2026-04-27", val: 130.63e6 },
    { end: "2026-08-03", val: 1306.55e6 },
  ];

  it("removes the split from a dilution reading", () => {
    const raw = dilution(klacShares);
    expect(raw!.growth).toBeGreaterThan(8); // +890%, the artifact

    const fixed = dilution(adjustSeries(klacShares, [split("KLAC", "2026-06-12", 1, 10)]));
    // 131.96M x10 = 1319.6M against 1306.55M: a ~1% buyback, not dilution.
    expect(fixed!.growth).toBeLessThan(0);
    expect(fixed!.growth).toBeGreaterThan(-0.05);
  });

  /** NOW: 1:5 on 2025-12-18. Same shape, different ratio. */
  it("removes a 1:5 split too", () => {
    const nowShares = [
      { end: "2025-06-30", val: 208e6 },
      { end: "2026-06-30", val: 1034e6 },
    ];
    expect(dilution(nowShares)!.growth).toBeGreaterThan(3.9);
    const fixed = dilution(adjustSeries(nowShares, [split("NOW", "2025-12-18", 1, 5)]));
    expect(Math.abs(fixed!.growth)).toBeLessThan(0.02);
  });

  /**
   * The other half of the guarantee: adjustment must not erase REAL dilution.
   * AXTI has no split and grew its share count 42%; that has to survive.
   */
  it("leaves genuine dilution untouched when there is no split", () => {
    const axti = [
      { end: "2025-08-01", val: 46.12e6 },
      { end: "2026-08-03", val: 65.57e6 },
    ];
    expect(dilution(adjustSeries(axti, []))!.growth).toBeCloseTo(0.4217, 3);
  });

  it("returns the series unchanged when the ticker never split", () => {
    const pts = [{ end: "2026-01-01", val: 10 }];
    expect(adjustSeries(pts, [])).toEqual(pts);
  });

  it("preserves other fields on each point", () => {
    const pts = [{ end: "2025-01-01", val: 10, form: "10-K" }];
    const out = adjustSeries(pts, [split("X", "2026-01-01", 1, 2)]);
    expect(out[0].form).toBe("10-K");
    expect(out[0].val).toBe(20);
  });
});

describe("tickersNeedingRefetch", () => {
  const splits = [
    split("AAA", "2026-05-01", 1, 10),
    split("BBB", "2026-01-01", 20, 1),
  ];

  /**
   * Polygon restates price history when a split executes, and the backfill
   * never re-fetches a stored session. A split after the fetch date strands
   * the whole series -- a 10:1 reverse split would manufacture a +900%
   * twelve-month return and send that name to RS 99.
   */
  it("flags a ticker that split after its bars were fetched", () => {
    expect(tickersNeedingRefetch(splits, new Map([["AAA", "2026-03-01"]]))).toEqual(["AAA"]);
  });

  it("does not flag one fetched after its split", () => {
    expect(tickersNeedingRefetch(splits, new Map([["AAA", "2026-06-01"]]))).toEqual([]);
  });

  it("ignores tickers we hold no bars for", () => {
    expect(tickersNeedingRefetch(splits, new Map())).toEqual([]);
  });

  it("reports each stale ticker once however many times it split", () => {
    const twice = [...splits, split("AAA", "2026-06-01", 1, 2)];
    expect(tickersNeedingRefetch(twice, new Map([["AAA", "2026-01-15"]]))).toEqual(["AAA"]);
  });

  it("catches reverse splits as well as forward ones", () => {
    expect(tickersNeedingRefetch(splits, new Map([["BBB", "2025-06-01"]]))).toEqual(["BBB"]);
  });
});

describe("byTicker", () => {
  it("groups and orders splits oldest first", () => {
    const g = byTicker([
      split("X", "2026-01-01", 1, 5),
      split("X", "2025-01-01", 1, 2),
      split("Y", "2026-01-01", 1, 3),
    ]);
    expect(g.get("X")!.map((s) => s.executionDate)).toEqual(["2025-01-01", "2026-01-01"]);
    expect(g.get("Y")).toHaveLength(1);
    expect(g.get("Z")).toBeUndefined();
  });
});

describe("pendingRefetches", () => {
  const splits = [
    split("AAA", "2026-05-01", 1, 10),
    split("AAA", "2026-02-01", 1, 2),
    split("BBB", "2026-03-01", 20, 1),
    split("CCC", "2026-04-01", 1, 4),
  ];
  const held = new Set(["AAA", "BBB"]);

  it("returns work for tickers we hold bars for", () => {
    const out = pendingRefetches(splits, new Set(), held);
    expect(out.map(splitKey)).toEqual([
      "AAA|2026-02-01",
      "BBB|2026-03-01",
      "AAA|2026-05-01",
    ]);
  });

  it("skips splits already handled", () => {
    const out = pendingRefetches(splits, new Set(["AAA|2026-02-01"]), held);
    expect(out.map(splitKey)).toEqual(["BBB|2026-03-01", "AAA|2026-05-01"]);
  });

  /**
   * The rule this exists to honour: a completeness check must ask whether each
   * unit is done, not how far the work got. A watermark would treat an older
   * split discovered later as already handled and skip it forever.
   */
  it("still returns an older split discovered after a newer one was handled", () => {
    const out = pendingRefetches(splits, new Set(["AAA|2026-05-01"]), held);
    expect(out.map(splitKey)).toContain("AAA|2026-02-01");
  });

  it("ignores tickers we store no bars for", () => {
    expect(pendingRefetches(splits, new Set(), held).some((s) => s.ticker === "CCC")).toBe(false);
  });

  it("is empty when everything is done", () => {
    const all = new Set(splits.map(splitKey));
    expect(pendingRefetches(splits, all, held)).toEqual([]);
  });
});

describe("refetchTargets", () => {
  it("collapses to one entry per ticker at its OLDEST pending split", () => {
    const out = refetchTargets([
      split("AAA", "2026-05-01", 1, 10),
      split("AAA", "2026-02-01", 1, 2),
      split("BBB", "2026-03-01", 20, 1),
    ]);
    expect(out).toEqual([
      { ticker: "AAA", since: "2026-02-01" },
      { ticker: "BBB", since: "2026-03-01" },
    ]);
  });

  it("is empty for no pending work", () => {
    expect(refetchTargets([])).toEqual([]);
  });
});
