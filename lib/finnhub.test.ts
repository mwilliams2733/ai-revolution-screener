import { describe, expect, it } from "vitest";
import { shapeEarnings, surprisePct } from "./finnhub";

describe("surprisePct", () => {
  it("computes a beat as a percentage of the estimate", () => {
    expect(surprisePct(3.0312, 3.23)).toBeCloseTo(6.56, 1);
  });

  it("computes a miss as negative", () => {
    expect(surprisePct(2.0, 1.8)).toBeCloseTo(-10, 1);
  });

  it("refuses to score against a zero or negative estimate", () => {
    // "beat a -$0.05 loss estimate by 300%" is not a meaningful figure, and the
    // ratio changes sign with the denominator.
    expect(surprisePct(0, 0.5)).toBeNull();
    expect(surprisePct(-0.05, 0.1)).toBeNull();
  });

  it("returns null when either side is missing", () => {
    expect(surprisePct(null, 1)).toBeNull();
    expect(surprisePct(1, null)).toBeNull();
  });
});

describe("shapeEarnings", () => {
  const raw = [
    { date: "2025-11-04", epsEstimate: 1.0, epsActual: 1.1, quarter: 1, year: 2026 },
    { date: "2026-02-10", epsEstimate: 1.2, epsActual: 1.15, quarter: 2, year: 2026 },
    { date: "2026-05-06", epsEstimate: 1.3, epsActual: 1.5, quarter: 3, year: 2026 },
    { date: "2026-08-11", epsEstimate: 3.03, epsActual: 3.23, quarter: 4, year: 2026 },
    { date: "2026-11-10", epsEstimate: 3.4, epsActual: null, quarter: 1, year: 2027 },
  ];

  const info = shapeEarnings("LITE", raw);

  it("picks the soonest event with no actual as next", () => {
    expect(info.next?.date).toBe("2026-11-10");
  });

  it("orders reported quarters newest first", () => {
    expect(info.history.map((e) => e.date)).toEqual([
      "2026-08-11",
      "2026-05-06",
      "2026-02-10",
      "2025-11-04",
    ]);
  });

  it("counts beats across the last four reported quarters", () => {
    // 3.23 vs 3.03 beat, 1.5 vs 1.3 beat, 1.15 vs 1.2 miss, 1.1 vs 1.0 beat.
    expect(info.beatsLastFour).toBe(3);
  });

  it("declines to report a beat count with fewer than four quarters", () => {
    const thin = shapeEarnings("NEW", raw.slice(-2));
    expect(thin.beatsLastFour).toBeNull();
  });

  // A report lands after the close, so "the date has passed" does not mean the
  // number exists. Only the presence of an actual settles it.
  it("treats a dated event with no actual as still upcoming", () => {
    const sameDay = shapeEarnings("X", [
      { date: "2020-01-01", epsEstimate: 1, epsActual: null },
    ]);
    expect(sameDay.next?.date).toBe("2020-01-01");
    expect(sameDay.history).toHaveLength(0);
  });

  it("survives an empty calendar", () => {
    const none = shapeEarnings("NONE", []);
    expect(none.next).toBeNull();
    expect(none.history).toHaveLength(0);
    expect(none.beatsLastFour).toBeNull();
  });
});
