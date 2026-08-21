import { describe, expect, it } from "vitest";
import {
  barsByTicker,
  computeMaProxy,
  computeRows,
  dollarVolume,
  pctChange,
  percentileRanks,
  rankRows,
  rsScore,
  type PolygonBar,
} from "./factors";
import { DEFAULT_PARAMS as P, withParams } from "./params";
import type { AnchorLabel, BarsByTicker } from "./types";

describe("pctChange", () => {
  it("computes percent change", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10, 10);
    expect(pctChange(50, 100)).toBeCloseTo(-50, 10);
    expect(pctChange(100, 100)).toBeCloseTo(0, 10);
  });

  it("returns null for missing or non-positive inputs", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(undefined, 100)).toBeNull();
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(0, 100)).toBeNull();
    expect(pctChange(-5, 100)).toBeNull();
    expect(pctChange(NaN, 100)).toBeNull();
    expect(pctChange(100, Infinity)).toBeNull();
  });
});

describe("rsScore", () => {
  it("applies the 40/30/30 blend", () => {
    expect(rsScore(10, 20, 30, P)).toBeCloseTo(0.4 * 10 + 0.3 * 20 + 0.3 * 30, 10);
    expect(rsScore(10, 20, 30, P)).toBeCloseTo(19, 10);
  });

  it("weights sum to one", () => {
    expect(P.wR3m + P.wR6m + P.wR12m).toBeCloseTo(1, 10);
  });

  it("honours overridden weights", () => {
    const p = withParams({ wR3m: 1, wR6m: 0, wR12m: 0 });
    expect(rsScore(42, 999, 999, p)).toBeCloseTo(42, 10);
  });
});

describe("percentileRanks", () => {
  it("spans 0 to 100 with the median at 50", () => {
    const pr = percentileRanks([1, 2, 3, 4, 5]);
    expect(pr[0]).toBeCloseTo(0, 10);
    expect(pr[2]).toBeCloseTo(50, 10);
    expect(pr[4]).toBeCloseTo(100, 10);
  });

  it("is order-independent of input position", () => {
    const pr = percentileRanks([5, 1, 3, 2, 4]);
    expect(pr[1]).toBeCloseTo(0, 10); // value 1
    expect(pr[0]).toBeCloseTo(100, 10); // value 5
  });

  it("averages ranks across ties", () => {
    // values 1,2,2,3 -> ranks 0,1,2,3; the pair shares (1+2)/2 = 1.5
    const pr = percentileRanks([1, 2, 2, 3]);
    expect(pr[0]).toBeCloseTo(0, 10);
    expect(pr[1]).toBeCloseTo((100 * 1.5) / 3, 10);
    expect(pr[2]).toBeCloseTo((100 * 1.5) / 3, 10);
    expect(pr[3]).toBeCloseTo(100, 10);
  });

  it("handles degenerate inputs", () => {
    expect(percentileRanks([])).toEqual([]);
    expect(percentileRanks([7])).toEqual([100]);
    expect(percentileRanks([4, 4, 4])).toEqual([50, 50, 50]);
  });
});

describe("computeMaProxy", () => {
  it("averages price and every available anchor", () => {
    const anchors = new Map<AnchorLabel, number>([
      ["r1m", 90],
      ["r3m", 80],
      ["r6m", 70],
      ["r12m", 60],
    ]);
    expect(computeMaProxy(100, anchors)).toBeCloseTo((100 + 90 + 80 + 70 + 60) / 5, 10);
  });

  it("ignores non-positive anchors", () => {
    const anchors = new Map<AnchorLabel, number>([
      ["r3m", 0],
      ["r6m", 50],
    ]);
    expect(computeMaProxy(100, anchors)).toBeCloseTo(75, 10);
  });

  it("returns 0 when nothing is usable", () => {
    expect(computeMaProxy(0, new Map())).toBe(0);
  });
});

describe("dollarVolume", () => {
  it("prefers vwap", () => {
    expect(dollarVolume({ ticker: "X", close: 10, volume: 1000, vwap: 12 })).toBe(12000);
  });

  it("falls back to close when vwap is unusable", () => {
    expect(dollarVolume({ ticker: "X", close: 10, volume: 1000, vwap: 0 })).toBe(10000);
  });
});

describe("barsByTicker", () => {
  it("reshapes a Polygon payload", () => {
    const raw: PolygonBar[] = [
      { T: "AAA", c: 10, v: 100, vw: 10.5 },
      { T: "BBB", c: 20, v: 200 },
    ];
    const m = barsByTicker(raw);
    expect(m.get("AAA")?.vwap).toBe(10.5);
    expect(m.get("BBB")?.vwap).toBe(20); // defaults to close
  });

  it("drops malformed rows", () => {
    const raw = [{ T: "", c: 10, v: 1 }, { T: "OK", c: NaN, v: 1 }] as PolygonBar[];
    expect(barsByTicker(raw).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function bars(entries: Record<string, [number, number]>): BarsByTicker {
  const m = new Map();
  for (const [t, [c, v]] of Object.entries(entries)) {
    m.set(t, { ticker: t, close: c, volume: v, vwap: c });
  }
  return m;
}

describe("computeRows", () => {
  const names = new Map([
    ["GOOD", "Good Co"],
    ["CHEAP", "Penny Co"],
    ["THIN", "Illiquid Co"],
    ["NEW", "Recent IPO"],
  ]);
  const universe = new Map([
    ["GOOD", "sector_a"],
    ["CHEAP", "sector_a"],
    ["THIN", "sector_b"],
    ["NEW", "sector_b"],
  ]);

  const snapshots = {
    now: bars({ GOOD: [100, 1e6], CHEAP: [2, 1e7], THIN: [100, 10], NEW: [50, 1e6] }),
    r1m: bars({ GOOD: [90, 1e6], CHEAP: [2, 1e7], THIN: [100, 10] }),
    r3m: bars({ GOOD: [80, 1e6], CHEAP: [2, 1e7], THIN: [100, 10] }),
    r6m: bars({ GOOD: [70, 1e6], CHEAP: [2, 1e7], THIN: [100, 10] }),
    r12m: bars({ GOOD: [50, 1e6], CHEAP: [2, 1e7], THIN: [100, 10] }),
  };

  it("scores a qualifying name correctly", () => {
    const rows = computeRows(snapshots, universe, names, P);
    const g = rows.find((r) => r.ticker === "GOOD");
    expect(g).toBeDefined();
    expect(g!.r3m).toBeCloseTo(25, 6); // 100/80
    expect(g!.r6m).toBeCloseTo(100 / 70 * 100 - 100, 6);
    expect(g!.r12m).toBeCloseTo(100, 6); // 100/50
    expect(g!.maProxy).toBeCloseTo((100 + 90 + 80 + 70 + 50) / 5, 6);
    expect(g!.name).toBe("Good Co");
    expect(g!.sector).toBe("sector_a");
    expect(g!.rsPct).toBeNull(); // unranked until rankRows
  });

  it("rejects sub-minimum prices", () => {
    const rows = computeRows(snapshots, universe, names, P);
    expect(rows.some((r) => r.ticker === "CHEAP")).toBe(false);
  });

  it("rejects illiquid names", () => {
    const rows = computeRows(snapshots, universe, names, P);
    expect(rows.some((r) => r.ticker === "THIN")).toBe(false);
  });

  it("rejects names missing required anchors", () => {
    const rows = computeRows(snapshots, universe, names, P);
    expect(rows.some((r) => r.ticker === "NEW")).toBe(false);
  });

  it("tolerates a missing optional r1m anchor", () => {
    const noR1m = { ...snapshots, r1m: bars({}) };
    const g = computeRows(noR1m, universe, names, P).find((r) => r.ticker === "GOOD");
    expect(g?.r1m).toBeNull();
    expect(g?.maProxy).toBeCloseTo((100 + 80 + 70 + 50) / 4, 6);
  });
});

describe("rankRows", () => {
  const names = new Map([["A", ""], ["B", ""], ["C", ""]]);
  const universe = new Map([["A", "s"], ["B", "s"], ["C", "s"]]);
  const snapshots = {
    now: bars({ A: [300, 1e6], B: [200, 1e6], C: [100, 1e6] }),
    r1m: bars({ A: [100, 1e6], B: [100, 1e6], C: [100, 1e6] }),
    r3m: bars({ A: [100, 1e6], B: [100, 1e6], C: [100, 1e6] }),
    r6m: bars({ A: [100, 1e6], B: [100, 1e6], C: [100, 1e6] }),
    r12m: bars({ A: [100, 1e6], B: [100, 1e6], C: [100, 1e6] }),
  };

  it("sorts strongest first and assigns percentiles", () => {
    const ranked = rankRows(computeRows(snapshots, universe, names, P));
    expect(ranked.map((r) => r.ticker)).toEqual(["A", "B", "C"]);
    expect(ranked[0].rsPct).toBeCloseTo(100, 6);
    expect(ranked[2].rsPct).toBeCloseTo(0, 6);
  });
});
