import { describe, expect, it } from "vitest";
import {
  annualisedTurnover,
  correlation,
  correlationMatrix,
  drawdownContributions,
  effectiveBetsCorrelation,
  effectiveBetsWeight,
  herfindahl,
  logReturns,
  meanPairwiseCorrelation,
  sectorConcentration,
  tierTransitions,
  timeInTier,
  topCorrelatedPairs,
  worstDrawdownWindow,
} from "./portfolio-risk";

const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe("logReturns", () => {
  it("returns one fewer value than closes", () => {
    expect(logReturns([100, 110, 121])).toHaveLength(2);
  });

  it("is additive across periods, which is why logs are used", () => {
    const r = logReturns([100, 110, 121])!;
    expect(r[0] + r[1]).toBeCloseTo(Math.log(1.21), 10);
  });

  it("returns null on a non-positive price rather than -Infinity", () => {
    expect(logReturns([100, 0, 50])).toBeNull();
    expect(logReturns([100, -5])).toBeNull();
  });
});

describe("correlation", () => {
  it("is 1 for identical series", () => {
    const a = seq(60, (i) => Math.sin(i / 3));
    expect(correlation(a, a)!).toBeCloseTo(1, 10);
  });

  it("is -1 for mirrored series", () => {
    const a = seq(60, (i) => Math.sin(i / 3));
    expect(correlation(a, a.map((x) => -x))!).toBeCloseTo(-1, 10);
  });

  // A flat series has no variance, so correlation is undefined rather than
  // zero. Reporting 0 would claim independence that was never measured.
  it("returns null when either series has no variance", () => {
    expect(correlation(seq(60, () => 1), seq(60, (i) => i))).toBeNull();
  });

  it("returns null on a length mismatch or too few points", () => {
    expect(correlation([1, 2, 3], [1, 2])).toBeNull();
    expect(correlation([1], [1])).toBeNull();
  });
});

describe("effective number of bets", () => {
  it("equals the position count for equal weights with no correlation", () => {
    const w = [0.25, 0.25, 0.25, 0.25];
    expect(effectiveBetsWeight(w)!).toBeCloseTo(4, 10);
  });

  it("falls below the count when weights are concentrated", () => {
    expect(effectiveBetsWeight([0.7, 0.1, 0.1, 0.1])!).toBeLessThan(2);
  });

  it("matches the weight-only figure when holdings are uncorrelated", () => {
    const w = [0.25, 0.25, 0.25, 0.25];
    const identity = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    expect(effectiveBetsCorrelation(w, identity)!).toBeCloseTo(effectiveBetsWeight(w)!, 8);
  });

  /**
   * The headline claim of this family: a book of perfectly correlated names is
   * one bet however many tickers it holds. If this ever returns the position
   * count, the metric is measuring nothing.
   */
  it("collapses to one bet when everything is perfectly correlated", () => {
    const w = [0.25, 0.25, 0.25, 0.25];
    const ones: number[][] = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 1));
    expect(effectiveBetsCorrelation(w, ones)!).toBeCloseTo(1, 8);
  });

  it("returns null on an empty or degenerate book", () => {
    expect(effectiveBetsWeight([])).toBeNull();
    expect(effectiveBetsWeight([0, 0])).toBeNull();
  });
});

describe("correlationMatrix and its summaries", () => {
  const tickers = ["AAA", "BBB", "CCC"];
  // AAA and BBB move together; CCC moves against them.
  const base = seq(61, (i) => 100 * Math.exp(Math.sin(i / 4) / 20));
  const series = new Map([
    ["AAA", base],
    ["BBB", base.map((p, i) => p * (1 + i * 1e-6))],
    ["CCC", seq(61, (i) => 100 * Math.exp(-Math.sin(i / 4) / 20))],
  ]);

  it("is symmetric with a unit diagonal", () => {
    const m = correlationMatrix(tickers, series, 60)!;
    expect(m[0][0]).toBeCloseTo(1, 10);
    expect(m[0][1]).toBeCloseTo(m[1][0], 10);
  });

  it("averages only the off-diagonal pairs", () => {
    // Asserted against a known matrix, not a live one: the diagonal is always
    // 1, so including it drags the figure toward 1 and makes a concentrated
    // book look diversified. A loose bound would not catch that.
    const known = [
      [1, 0.5, 0.5],
      [0.5, 1, 0.5],
      [0.5, 0.5, 1],
    ];
    // Off-diagonal only: exactly 0.5. With the diagonal it would be ~0.667.
    expect(meanPairwiseCorrelation(known)!).toBeCloseTo(0.5, 10);

    const m = correlationMatrix(tickers, series, 60)!;
    expect(meanPairwiseCorrelation(m)!).toBeLessThan(0.9);
  });

  it("surfaces the most correlated pair first", () => {
    const m = correlationMatrix(tickers, series, 60)!;
    const pairs = topCorrelatedPairs(tickers, m, 2);
    expect(pairs[0].a).toBe("AAA");
    expect(pairs[0].b).toBe("BBB");
    expect(pairs[0].correlation).toBeGreaterThan(0.9);
  });

  it("returns null when a holding lacks history", () => {
    expect(correlationMatrix([...tickers, "DDD"], series, 60)).toBeNull();
  });
});

describe("sectorConcentration", () => {
  it("computes a Herfindahl index and the top-three share", () => {
    const rows = [
      { sector: "optics", weight: 0.4 },
      { sector: "compute", weight: 0.3 },
      { sector: "semicap", weight: 0.2 },
      { sector: "defense", weight: 0.1 },
    ];
    const c = sectorConcentration(rows);
    expect(c.hhi).toBeCloseTo(0.16 + 0.09 + 0.04 + 0.01, 10);
    expect(c.topThreeShare).toBeCloseTo(0.9, 10);
    expect(c.bySector[0].sector).toBe("optics");
  });

  it("returns null figures for an empty book", () => {
    expect(sectorConcentration([]).hhi).toBeNull();
  });
});

describe("herfindahl", () => {
  it("is 1 for a single position and 1/n for n equal ones", () => {
    expect(herfindahl([1])!).toBeCloseTo(1, 10);
    expect(herfindahl([0.2, 0.2, 0.2, 0.2, 0.2])!).toBeCloseTo(0.2, 10);
  });

  it("normalises weights that do not sum to one", () => {
    // The 7/7/5 book sums to 100.01%, so this must not be assumed exact.
    expect(herfindahl([2, 2])!).toBeCloseTo(0.5, 10);
  });
});

describe("worstDrawdownWindow", () => {
  it("finds the steepest decline over the window length", () => {
    // Rises, then falls hard between index 20 and 40.
    const series = [...seq(20, (i) => 100 + i), ...seq(21, (i) => 120 - i * 2)];
    const w = worstDrawdownWindow(series, 20)!;
    expect(w.drawdown).toBeLessThan(-0.2);
    expect(w.endIndex).toBe(series.length - 1);
  });

  it("returns null when the series is shorter than the window", () => {
    expect(worstDrawdownWindow([1, 2, 3], 20)).toBeNull();
  });

  it("reports zero drawdown for a monotonically rising series", () => {
    expect(worstDrawdownWindow(seq(60, (i) => 100 + i), 20)!.drawdown).toBeCloseTo(0, 10);
  });
});

describe("drawdownContributions", () => {
  it("weights each position's loss by its size", () => {
    const out = drawdownContributions([
      { ticker: "AAA", weight: 0.5, ret: -0.2 },
      { ticker: "BBB", weight: 0.1, ret: -0.5 },
    ]);
    // AAA: 0.5 * -0.2 = -0.10 hurts more than BBB: 0.1 * -0.5 = -0.05.
    expect(out[0].ticker).toBe("AAA");
    expect(out[0].contribution).toBeCloseTo(-0.1, 10);
    expect(out[1].contribution).toBeCloseTo(-0.05, 10);
  });
});

describe("tier history", () => {
  const history = [
    { session: "2026-08-01", ticker: "AAA", tier: "Buy" },
    { session: "2026-08-02", ticker: "AAA", tier: "Strong Buy" },
    { session: "2026-08-03", ticker: "AAA", tier: "Strong Buy" },
    { session: "2026-08-01", ticker: "BBB", tier: "Hold" },
    { session: "2026-08-02", ticker: "BBB", tier: "Hold" },
    { session: "2026-08-03", ticker: "BBB", tier: null },
  ];

  it("records only actual changes, not every session", () => {
    const t = tierTransitions(history);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ ticker: "AAA", from: "Buy", to: "Strong Buy" });
  });

  // A name leaving the universe is a real event, which is why tier is nullable.
  it("treats leaving the universe as a transition", () => {
    const t = tierTransitions(history);
    expect(t[1]).toMatchObject({ ticker: "BBB", from: "Hold", to: null });
  });

  it("counts consecutive sessions in the current tier", () => {
    expect(timeInTier(history).get("AAA")).toBe(2);
  });

  it("annualises turnover from changes per position per session", () => {
    // 2 changes across 2 names over 3 sessions.
    const t = annualisedTurnover(history);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
  });

  it("returns null turnover without at least two sessions", () => {
    expect(annualisedTurnover([{ session: "2026-08-01", ticker: "AAA", tier: "Buy" }])).toBeNull();
  });
});
