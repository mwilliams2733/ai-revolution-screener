import { describe, expect, it } from "vitest";
import {
  benchmarkPct, changePct, cohortRows, summarise,
  type CohortRow, type Pick,
} from "./cohort";

const closes = (o: Record<string, number | null>) => new Map(Object.entries(o));
const picks: Pick[] = [
  { ticker: "AAA", rsPct: 99 },
  { ticker: "BBB", rsPct: 95 },
  { ticker: "CCC", rsPct: 90 },
];

describe("changePct", () => {
  it("computes a simple percent change", () => {
    expect(changePct(100, 110)).toBeCloseTo(10);
    expect(changePct(100, 90)).toBeCloseTo(-10);
  });

  /**
   * The rule lib/backtest.ts uses. A missing bar is an UNMEASURED return;
   * scoring it flat drags averages toward zero in exactly the patchiest names,
   * and a delisting would read as a harmless 0% instead of the hole it is.
   */
  it("is null, never zero, when either end is missing", () => {
    expect(changePct(null, 110)).toBeNull();
    expect(changePct(100, null)).toBeNull();
    expect(changePct(null, null)).toBeNull();
  });

  it("refuses a non-positive base rather than dividing by it", () => {
    expect(changePct(0, 10)).toBeNull();
    expect(changePct(-5, 10)).toBeNull();
  });
});

describe("cohortRows", () => {
  it("pairs entry and current closes into a return", () => {
    const rows = cohortRows(picks, closes({ AAA: 100, BBB: 50, CCC: 20 }),
      closes({ AAA: 110, BBB: 45, CCC: 20 }), new Set(["AAA"]));
    // toBeCloseTo per element: 110/100-1 is 0.10000000000000009 in binary
    // floating point, and toEqual would fail on a correct result.
    expect(rows.map((r) => r.pct?.toFixed(4))).toEqual(["10.0000", "-10.0000", "0.0000"]);
  });

  it("flags which names are still in the current top 10", () => {
    const rows = cohortRows(picks, closes({ AAA: 1, BBB: 1, CCC: 1 }),
      closes({ AAA: 1, BBB: 1, CCC: 1 }), new Set(["AAA", "CCC"]));
    expect(rows.map((r) => r.stillHeld)).toEqual([true, false, true]);
  });

  it("keeps a name with no price rather than dropping it", () => {
    const rows = cohortRows(picks, closes({ AAA: 100 }), closes({ AAA: 110 }), new Set());
    expect(rows).toHaveLength(3);
    expect(rows[1].pct).toBeNull();
  });

  it("carries the entry RS through unchanged", () => {
    const rows = cohortRows(picks, closes({}), closes({}), new Set());
    expect(rows.map((r) => r.entryRs)).toEqual([99, 95, 90]);
  });
});

const row = (ticker: string, pct: number | null): CohortRow => ({
  ticker, entryRs: 90, entryClose: 100,
  nowClose: pct == null ? null : 100 * (1 + pct / 100), pct, stillHeld: false,
});

describe("summarise", () => {
  it("reports mean, win rate, best and worst", () => {
    const s = summarise([row("A", 10), row("B", -10), row("C", 30), row("D", -2)]);
    expect(s.mean).toBeCloseTo(7);
    expect(s.winRate).toBeCloseTo(50);
    expect(s.best?.ticker).toBe("C");
    expect(s.worst?.ticker).toBe("B");
  });

  /**
   * The cap is 10, so EVERY cohort here has an even count. Taking the upper of
   * the middle pair -- a common shortcut -- would bias every single one upward.
   */
  it("averages the middle pair on an even count", () => {
    expect(summarise([row("A", 0), row("B", 10)]).median).toBeCloseTo(5);
    expect(summarise([row("A", 1), row("B", 2), row("C", 3), row("D", 10)]).median)
      .toBeCloseTo(2.5);
  });

  it("takes the middle value on an odd count", () => {
    expect(summarise([row("A", 1), row("B", 5), row("C", 100)]).median).toBeCloseTo(5);
  });

  /** Unmeasured names must not silently count as flat in the average. */
  it("excludes unmeasured names from the statistics and counts them", () => {
    const s = summarise([row("A", 10), row("B", null), row("C", 20)]);
    expect(s.measured).toBe(2);
    expect(s.missing).toBe(1);
    expect(s.mean).toBeCloseTo(15);
  });

  it("reports nothing rather than zero when nothing was measurable", () => {
    const s = summarise([row("A", null), row("B", null)]);
    expect(s).toMatchObject({ measured: 0, missing: 2, mean: null, median: null, winRate: null });
    expect(s.best).toBeNull();
  });

  it("is all-empty for an empty cohort", () => {
    expect(summarise([])).toMatchObject({ measured: 0, missing: 0, mean: null });
  });

  /** A flat name is not a winner. */
  it("counts only strictly positive moves as wins", () => {
    expect(summarise([row("A", 0), row("B", 0)]).winRate).toBe(0);
  });
});

describe("benchmarkPct", () => {
  it("equal-weights every measurable name", () => {
    const v = benchmarkPct(["A", "B"], closes({ A: 100, B: 100 }), closes({ A: 110, B: 90 }));
    expect(v).toBeCloseTo(0);
  });

  /**
   * Absolute cohort returns mislead on their own: every live cohort so far is
   * negative while the theme fell further, which is the signal working.
   */
  it("measures the fall the cohort is read against", () => {
    const v = benchmarkPct(["A", "B"], closes({ A: 100, B: 100 }), closes({ A: 95, B: 85 }));
    expect(v).toBeCloseTo(-10);
  });

  it("ignores names with no price instead of scoring them flat", () => {
    const v = benchmarkPct(["A", "B"], closes({ A: 100 }), closes({ A: 120 }));
    expect(v).toBeCloseTo(20);
  });

  it("is null when nothing could be measured", () => {
    expect(benchmarkPct(["A"], closes({}), closes({}))).toBeNull();
  });
});
