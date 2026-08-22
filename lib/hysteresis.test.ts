import { describe, expect, it } from "vitest";
import { DEFAULT_BAND, applyHysteresis, hysteresisTier } from "./hysteresis";
import { DEFAULT_PARAMS as P } from "./params";
import type { ScreenRow, Tier } from "./types";

const t = (rsPct: number, vsMa: number, prev: Tier | null) =>
  hysteresisTier(rsPct, vsMa, prev, P, DEFAULT_BAND);

describe("hysteresisTier", () => {
  it("behaves like the plain rule when there is no previous tier", () => {
    expect(t(85, 10, null)).toBe("Strong Buy");
    expect(t(60, 10, null)).toBe("Buy");
    expect(t(30, 10, null)).toBe("Hold");
  });

  /**
   * The oscillation this exists to stop. Across 248 replayed sessions the moves
   * were near-perfectly symmetric — Hold->Buy 443 against Buy->Hold 426 — which
   * is names crossing a step boundary back and forth, not migrating.
   */
  it("keeps Strong Buy while the name stays inside the band", () => {
    // Below the 80 cutoff but not by the full band: it holds.
    expect(t(78, 10, "Strong Buy")).toBe("Strong Buy");
    expect(t(77, 10, "Strong Buy")).toBe("Strong Buy");
  });

  it("gives up Strong Buy once the name clears the band", () => {
    expect(t(75, 10, "Strong Buy")).toBe("Buy");
  });

  it("demands a margin before granting Strong Buy", () => {
    // Just over the plain cutoff is not enough to promote.
    expect(t(81, 10, "Buy")).toBe("Buy");
    expect(t(85, 10, "Buy")).toBe("Strong Buy");
  });

  it("applies the same stickiness at the Buy and Hold boundary", () => {
    expect(t(53, 10, "Buy")).toBe("Buy");
    expect(t(50, 10, "Buy")).toBe("Hold");
    expect(t(56, 10, "Hold")).toBe("Hold");
    expect(t(60, 10, "Hold")).toBe("Buy");
  });

  /**
   * The trend gate is a regime statement, not a ranking. A name falling below
   * its 200-day average is a different kind of event from drifting a point in
   * percentile, so it is not held by the band.
   */
  it("does not hold a tier when the name loses its trend", () => {
    expect(t(95, -1, "Strong Buy")).not.toBe("Strong Buy");
  });

  /**
   * The Buy and Hold branches check the percentile band but carry no trend
   * condition of their own, so the early trend guard is what stops a name
   * below its moving average from being held in a buy-side tier. Without
   * these two cases that guard could be deleted and every test still passed.
   */
  it("drops a previously-Buy name that falls below its average", () => {
    expect(t(60, -5, "Buy")).toBe("Hold");
  });

  it("will not promote a below-average name out of Hold", () => {
    expect(t(60, -5, "Hold")).toBe("Hold");
  });

  it("never invents a tier the plain rule would refuse outright", () => {
    // Deeply weak on both measures cannot stay Strong Buy at any band.
    expect(t(5, -30, "Strong Buy")).toBe("Hold");
  });

  it("widens with the band and narrows without one", () => {
    expect(hysteresisTier(78, 10, "Strong Buy", P, 0)).toBe("Buy");
    expect(hysteresisTier(70, 10, "Strong Buy", P, 15)).toBe("Strong Buy");
  });
});

function row(over: Partial<ScreenRow> = {}): ScreenRow {
  return {
    ticker: "T", name: "T", sector: "compute_gpu_cpu", price: 100, dollarVolume: 5e7,
    r1m: 1, r3m: 10, r6m: 20, r12m: 30, maProxy: 90, vsMa: 10,
    rsRaw: 20, rsPct: 79, tier: "Buy", weight: 0.05, ...over,
  };
}

describe("applyHysteresis", () => {
  it("restores a tier the plain rule would have dropped", () => {
    const [out] = applyHysteresis([row({ rsPct: 78, tier: "Buy" })], new Map([["T", "Strong Buy"]]));
    expect(out.tier).toBe("Strong Buy");
    expect(out.held).toBe(true);
  });

  it("re-weights when it restores a tier", () => {
    const [out] = applyHysteresis([row({ rsPct: 78, tier: "Buy" })], new Map([["T", "Strong Buy"]]));
    expect(out.weight).toBeCloseTo(0.0743, 6);
  });

  it("blocks a promotion that has not cleared the margin", () => {
    const [out] = applyHysteresis(
      [row({ rsPct: 81, tier: "Strong Buy" })],
      new Map([["T", "Buy"]]),
    );
    expect(out.tier).toBe("Buy");
    expect(out.held).toBe(true);
  });

  it("leaves a name with no recorded history to the plain rule", () => {
    const [out] = applyHysteresis([row({ rsPct: 78, tier: "Buy" })], new Map());
    expect(out.tier).toBe("Buy");
    expect(out.held).toBe(false);
  });

  it("leaves an unambiguous move alone", () => {
    const [out] = applyHysteresis([row({ rsPct: 20, tier: "Hold" })], new Map([["T", "Strong Buy"]]));
    expect(out.tier).toBe("Hold");
    expect(out.held).toBe(false);
  });
});
