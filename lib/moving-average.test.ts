import { describe, expect, it } from "vitest";
import { MA_WINDOW, applyTrueMa, sma } from "./moving-average";
import type { ScreenRow } from "./types";

function row(over: Partial<ScreenRow> = {}): ScreenRow {
  return {
    ticker: "T",
    name: "Test",
    sector: "compute_gpu_cpu",
    price: 120,
    dollarVolume: 5e7,
    r1m: 1,
    r3m: 20,
    r6m: 40,
    r12m: 80,
    // Proxy says the name is 20% above its average.
    maProxy: 100,
    vsMa: 20,
    rsRaw: 40,
    rsPct: 90,
    tier: "Strong Buy",
    weight: 0.0743,
    ...over,
  };
}

/** `n` closes, all equal to `value` unless a ramp is requested. */
function closes(n: number, value = 100, step = 0): number[] {
  return Array.from({ length: n }, (_, i) => value + i * step);
}

describe("sma", () => {
  it("averages the most recent window", () => {
    // Last 3 of [1..10] are 8, 9, 10.
    expect(sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toBeCloseTo(9, 10);
  });

  it("uses only the window, ignoring older history", () => {
    const long = [...closes(300, 1), ...closes(200, 500)];
    expect(sma(long, 200)).toBeCloseTo(500, 10);
  });

  // Insufficient history must be null, never a partial mean. A 200-day average
  // computed from 40 bars is not a 200-day average, and rendering it as one is
  // how a screener reports a trend that does not exist.
  it("returns null rather than a partial average", () => {
    expect(sma(closes(199), 200)).toBeNull();
    expect(sma([], 200)).toBeNull();
  });

  it("accepts exactly the window length", () => {
    expect(sma(closes(200, 42), 200)).toBeCloseTo(42, 10);
  });

  it("ignores non-finite values rather than poisoning the mean", () => {
    expect(sma([10, NaN, 20], 3)).toBeNull();
  });
});

describe("applyTrueMa", () => {
  const history = new Map<string, number[]>();
  // 200 closes averaging exactly 100.
  history.set("T", closes(MA_WINDOW, 100));

  it("replaces the proxy with a true rolling mean when history allows", () => {
    const [out] = applyTrueMa([row({ price: 130 })], history);
    expect(out.maSource).toBe("true");
    expect(out.maProxy).toBeCloseTo(100, 6);
    expect(out.vsMa).toBeCloseTo(30, 6);
  });

  it("keeps the proxy and says so when history is thin", () => {
    const thin = new Map([["T", closes(50, 100)]]);
    const [out] = applyTrueMa([row()], thin);
    expect(out.maSource).toBe("proxy");
    expect(out.vsMa).toBe(20);
    expect(out.maProxy).toBe(100);
  });

  it("keeps the proxy when the ticker has no history at all", () => {
    const [out] = applyTrueMa([row()], new Map());
    expect(out.maSource).toBe("proxy");
    expect(out.vsMa).toBe(20);
  });

  // The trend gate reads vsMa, so a corrected average must re-decide the tier.
  // Leaving the old tier attached to a new vsMa is the worst of both.
  it("re-assigns the tier from the corrected vsMa", () => {
    const below = new Map([["T", closes(MA_WINDOW, 200)]]);
    const [out] = applyTrueMa([row({ price: 120, rsPct: 90 })], below);
    expect(out.vsMa).toBeLessThan(0);
    expect(out.tier).toBe("Hold");
  });

  it("re-weights to match the re-assigned tier", () => {
    const below = new Map([["T", closes(MA_WINDOW, 200)]]);
    const [out] = applyTrueMa([row({ price: 120, rsPct: 90 })], below);
    expect(out.weight).toBeCloseTo(0.026, 6);
  });

  // Relative strength is computed from returns, not from the average, so a
  // corrected MA must not disturb the ranking the tier cutoffs depend on.
  it("leaves the relative-strength percentile untouched", () => {
    const [out] = applyTrueMa([row({ rsPct: 87 })], history);
    expect(out.rsPct).toBe(87);
  });

  it("declines to score a non-positive average", () => {
    const zeroed = new Map([["T", closes(MA_WINDOW, 0)]]);
    const [out] = applyTrueMa([row()], zeroed);
    expect(out.maSource).toBe("proxy");
  });
});
