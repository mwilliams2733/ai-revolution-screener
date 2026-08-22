import { describe, expect, it } from "vitest";
import {
  MIN_WINDOWS,
  forwardReturn,
  meanOf,
  nonOverlappingStarts,
  runBacktest,
  stats,
  verdict,
  type TierObservation,
} from "./backtest";
import type { Tier } from "./types";

describe("forwardReturn", () => {
  const closes = [100, 110, null, 121, 60];

  it("measures the move across the horizon, not the next bar", () => {
    expect(forwardReturn(closes, 0, 1)!).toBeCloseTo(0.1, 10);
    expect(forwardReturn(closes, 0, 3)!).toBeCloseTo(0.21, 10);
  });

  it("reports a loss as a loss", () => {
    expect(forwardReturn(closes, 3, 1)!).toBeCloseTo(60 / 121 - 1, 10);
  });

  /**
   * Null, never zero. A gap is an unmeasured return; scoring it flat would drag
   * every average toward zero precisely in the names with the worst data, which
   * is a bias that looks like a result.
   */
  it("returns null when either end of the window is missing", () => {
    expect(forwardReturn(closes, 2, 1)).toBeNull();
    expect(forwardReturn(closes, 1, 1)).toBeNull();
  });

  it("returns null when the window runs off the end of the series", () => {
    expect(forwardReturn(closes, 3, 5)).toBeNull();
  });

  it("refuses a non-positive base price", () => {
    expect(forwardReturn([0, 50], 0, 1)).toBeNull();
  });
});

describe("nonOverlappingStarts", () => {
  /**
   * The whole statistical argument rests on this function. If it ever returned
   * consecutive starts, every downstream t-statistic would be inflated by
   * roughly the square root of the horizon.
   */
  it("steps by a full horizon so no two windows share a session", () => {
    expect(nonOverlappingStarts(50, 21)).toEqual([0, 21]);
    // Not 0..9: the last session has no next bar to reach.
    expect(nonOverlappingStarts(10, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("drops a trailing window that has no future bar to reach", () => {
    // 42 sessions with a 21 horizon: start 21 needs index 42, which is past the
    // end, so only one window survives.
    expect(nonOverlappingStarts(42, 21)).toEqual([0]);
    expect(nonOverlappingStarts(43, 21)).toEqual([0, 21]);
  });

  it("yields nothing when no window fits at all", () => {
    expect(nonOverlappingStarts(21, 21)).toEqual([]);
    expect(nonOverlappingStarts(0, 5)).toEqual([]);
  });

  it("refuses a non-positive horizon rather than looping forever", () => {
    expect(nonOverlappingStarts(100, 0)).toEqual([]);
    expect(nonOverlappingStarts(100, -3)).toEqual([]);
  });
});

describe("meanOf", () => {
  it("averages only what was measured", () => {
    expect(meanOf([1, null, 3])!).toBeCloseTo(2, 10);
  });

  it("is null when nothing was measured", () => {
    expect(meanOf([null, null])).toBeNull();
    expect(meanOf([])).toBeNull();
  });

  it("ignores non-finite values rather than propagating them", () => {
    expect(meanOf([1, Number.NaN, 3])!).toBeCloseTo(2, 10);
  });
});

describe("stats", () => {
  const xs = [0.1, 0.2, 0.3, 0.4];

  it("counts windows, not raw values it was handed", () => {
    expect(stats([...xs, null, null]).n).toBe(4);
  });

  /**
   * Asserted to an exact value because the n-1 denominator is the point. With
   * n the sd of this series is 0.1118; with n-1 it is 0.1291. At ten windows
   * that difference moves a t-statistic by a tenth, which is the scale on which
   * this whole module's conclusions live.
   */
  it("uses the sample standard deviation, not the population one", () => {
    expect(stats(xs).sd!).toBeCloseTo(0.12909944, 7);
  });

  it("forms t as mean over the standard error", () => {
    const s = stats(xs);
    expect(s.t!).toBeCloseTo(0.25 / (s.sd! / 2), 7);
  });

  it("reports the share of windows above zero", () => {
    expect(stats([-1, 1, 1, 1]).hitRate!).toBeCloseTo(0.75, 10);
  });

  it("has no dispersion to report from a single window", () => {
    const s = stats([0.5]);
    expect(s.n).toBe(1);
    expect(s.mean).toBeCloseTo(0.5, 10);
    expect(s.sd).toBeNull();
    expect(s.t).toBeNull();
  });

  /**
   * A constant series does not average to a mean bit-identical to its members,
   * so the deviations land around 1e-17 rather than at zero. Testing `sd > 0`
   * alone lets that through and reports a t of 1e16.
   */
  it("declines to form a t from floating-point noise", () => {
    expect(stats([0.2, 0.2, 0.2]).t).toBeNull();
    expect(stats([0, 0, 0]).t).toBeNull();
    // A real but tiny dispersion is still a dispersion.
    expect(stats([0.2, 0.2, 0.3]).t).not.toBeNull();
  });

  it("is empty rather than throwing when nothing was measured", () => {
    expect(stats([null, null])).toEqual({
      n: 0,
      mean: null,
      sd: null,
      t: null,
      hitRate: null,
    });
  });
});

describe("verdict", () => {
  /** A series of `n` values with a large, obvious mean relative to its spread. */
  const strong = (n: number) => Array.from({ length: n }, (_, i) => 1 + (i % 2) * 0.01);

  /**
   * The guard that matters. A short series can produce an enormous t, and
   * quoting it would be the single most misleading thing this module could do.
   */
  it("calls a huge t underpowered when there are too few windows", () => {
    const s = stats(strong(MIN_WINDOWS - 1));
    expect(Math.abs(s.t!)).toBeGreaterThan(2);
    expect(verdict(s)).toBe("underpowered");
  });

  it("will look at the same series one window later", () => {
    expect(verdict(stats(strong(MIN_WINDOWS)))).toBe("suggestive");
  });

  it("says there is no evidence when a long series has a small t", () => {
    const noisy = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const s = stats(noisy);
    expect(Math.abs(s.t!)).toBeLessThan(2);
    expect(verdict(s)).toBe("no evidence");
  });

  it("treats a large negative t as suggestive too", () => {
    const s = stats(strong(MIN_WINDOWS).map((x) => -x));
    expect(s.t!).toBeLessThan(-2);
    expect(verdict(s)).toBe("suggestive");
  });

  it("is underpowered when no t could be formed at all", () => {
    expect(verdict(stats(new Array(40).fill(0.2)))).toBe("underpowered");
  });
});

// ---------------------------------------------------------------------------
// runBacktest
// ---------------------------------------------------------------------------

/** `n` sessions named s000, s001, ... */
const cal = (n: number) => Array.from({ length: n }, (_, i) => `s${String(i).padStart(3, "0")}`);

/** A price series compounding at `rate` per session. */
const grow = (n: number, rate: number) =>
  Array.from({ length: n }, (_, i) => 100 * (1 + rate) ** i);

function obs(sessions: readonly string[], assign: Record<string, Tier>): TierObservation[] {
  return sessions.flatMap((session) =>
    Object.entries(assign).map(([ticker, tier]) => ({ session, ticker, tier })),
  );
}

describe("runBacktest", () => {
  const sessions = cal(100);
  const closes = new Map([
    ["WIN", grow(100, 0.004)],
    ["MID", grow(100, 0.002)],
    ["LOSE", grow(100, -0.001)],
    ["SPY", grow(100, 0.001)],
  ]);
  const assign: Record<string, Tier> = {
    WIN: "Strong Buy",
    MID: "Buy",
    LOSE: "Hold",
  };
  const run = (horizons: number[]) =>
    runBacktest({
      sessions,
      observations: obs(sessions, assign),
      closes,
      benchmark: "SPY",
      horizons,
    });

  it("samples one window per horizon step, not one per session", () => {
    const [h] = run([10]);
    // 100 sessions, horizon 10: starts 0,10,...,80 reach 10..90. Start 90 would
    // need index 100. Nine windows -- not the 90 an overlapping sweep gives.
    expect(h.windows).toBe(9);
    expect(h.byTier.get("Strong Buy")!.n).toBe(9);
  });

  it("ranks the tiers by what they actually returned", () => {
    const [h] = run([10]);
    const m = (t: Tier) => h.byTier.get(t)!.mean!;
    expect(m("Strong Buy")).toBeGreaterThan(m("Buy"));
    expect(m("Buy")).toBeGreaterThan(m("Hold"));
  });

  it("reports the Strong Buy minus Hold spread as the headline", () => {
    const [h] = run([10]);
    expect(h.spread.mean!).toBeCloseTo(
      h.byTier.get("Strong Buy")!.mean! - h.byTier.get("Hold")!.mean!,
      10,
    );
    expect(h.spread.mean!).toBeGreaterThan(0);
  });

  it("measures each tier against the benchmark over the same windows", () => {
    const [h] = run([10]);
    expect(h.excess.get("Strong Buy")!.mean!).toBeGreaterThan(0);
    // The benchmark out-runs the Hold bucket here, so its excess must be below
    // zero -- a version that compared against zero instead would miss this.
    expect(h.excess.get("Hold")!.mean!).toBeLessThan(0);
    expect(h.benchmark.mean!).toBeCloseTo((1.001 ** 10) - 1, 6);
  });

  it("weights names equally within a tier rather than by the tier", () => {
    // Two names in Strong Buy, one flat: the mean must sit between them, which
    // a size- or tier-weighted version would not guarantee.
    const withFlat = new Map(closes);
    withFlat.set("FLAT", new Array(100).fill(100));
    const [h] = runBacktest({
      sessions,
      observations: obs(sessions, { ...assign, FLAT: "Strong Buy" }),
      closes: withFlat,
      benchmark: "SPY",
      horizons: [10],
    });
    const m = h.byTier.get("Strong Buy")!.mean!;
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan((1.004 ** 10) - 1);
  });

  it("averages every themed name regardless of tier", () => {
    const [h] = run([10]);
    const all = h.themeAll.mean!;
    expect(all).toBeLessThan(h.byTier.get("Strong Buy")!.mean!);
    expect(all).toBeGreaterThan(h.byTier.get("Hold")!.mean!);
  });

  it("handles several horizons in one pass", () => {
    const out = run([1, 5, 21]);
    expect(out.map((h) => h.horizon)).toEqual([1, 5, 21]);
    expect(out[0].windows).toBeGreaterThan(out[2].windows);
  });

  it("ignores tier rows for sessions outside the calendar", () => {
    const [h] = runBacktest({
      sessions,
      observations: [
        ...obs(sessions, assign),
        { session: "NOT-A-SESSION", ticker: "WIN", tier: "Strong Buy" },
      ],
      closes,
      benchmark: "SPY",
      horizons: [10],
    });
    expect(h.byTier.get("Strong Buy")!.n).toBe(9);
  });

  it("leaves a window unmeasured when a tier was empty that day", () => {
    const thin = obs(sessions, assign).filter(
      (o) => !(o.tier === "Hold" && o.session === sessions[0]),
    );
    const [h] = runBacktest({
      sessions,
      observations: thin,
      closes,
      benchmark: "SPY",
      horizons: [10],
    });
    expect(h.byTier.get("Hold")!.n).toBe(8);
    // The spread needs both ends, so it loses that window too.
    expect(h.spread.n).toBe(8);
  });

  it("survives a benchmark that is not in the price data", () => {
    const [h] = runBacktest({
      sessions,
      observations: obs(sessions, assign),
      closes,
      benchmark: "MISSING",
      horizons: [10],
    });
    expect(h.benchmark.n).toBe(0);
    expect(h.excess.get("Strong Buy")!.n).toBe(0);
    // The tier figures do not depend on the benchmark and must still be there.
    expect(h.byTier.get("Strong Buy")!.n).toBe(9);
  });
});

describe("runBacktest vsTheme", () => {
  const sessions = cal(100);
  const closes = new Map([
    ["WIN", grow(100, 0.004)],
    ["MID", grow(100, 0.002)],
    ["LOSE", grow(100, -0.001)],
    ["SPY", grow(100, 0.001)],
  ]);

  /**
   * The comparison the whole exercise turns on. A concentrated theme can beat
   * the market on theme selection alone, so "Strong Buy beat SPY" says nothing
   * about the tier. Only the gap against owning the whole theme equally does.
   */
  it("measures Strong Buy against the whole theme, not against zero", () => {
    const [h] = runBacktest({
      sessions,
      observations: obs(sessions, { WIN: "Strong Buy", MID: "Buy", LOSE: "Hold" }),
      closes,
      benchmark: "SPY",
      horizons: [10],
    });
    expect(h.vsTheme.mean!).toBeCloseTo(
      h.byTier.get("Strong Buy")!.mean! - h.themeAll.mean!,
      10,
    );
    expect(h.vsTheme.mean!).toBeGreaterThan(0);
    // Strictly smaller than the SPY excess here: the theme is a harder bar.
    expect(h.vsTheme.mean!).toBeLessThan(h.excess.get("Strong Buy")!.mean!);
  });

  it("is zero when every name in the theme is Strong Buy", () => {
    const [h] = runBacktest({
      sessions,
      observations: obs(sessions, { WIN: "Strong Buy", MID: "Strong Buy", LOSE: "Strong Buy" }),
      closes,
      benchmark: "SPY",
      horizons: [10],
    });
    expect(h.vsTheme.mean!).toBeCloseTo(0, 10);
  });

  it("goes negative when the tier picks the worst names", () => {
    const [h] = runBacktest({
      sessions,
      observations: obs(sessions, { LOSE: "Strong Buy", MID: "Buy", WIN: "Hold" }),
      closes,
      benchmark: "SPY",
      horizons: [10],
    });
    expect(h.vsTheme.mean!).toBeLessThan(0);
    expect(h.spread.mean!).toBeLessThan(0);
  });
});
