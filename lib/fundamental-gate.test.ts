import { describe, expect, it } from "vitest";
import { applyFundamentalOverlay, fundamentalGate } from "./fundamental-gate";
import type { Fundamentals } from "./edgar";
import type { ScreenRow } from "./types";

function fundamentals(over: Partial<Fundamentals> = {}): Fundamentals {
  return {
    cik: "0000000001",
    entityName: "Test Co",
    asOf: "2026-06-30",
    revYoY: 20,
    revYoYPrior: 20,
    revAccel: 0,
    epsYoY: 10,
    epsYoYPrior: 10,
    epsAccel: 0,
    opMargin: 20,
    opMarginYearAgo: 20,
    opMarginDelta: 0,
    epsTtm: 4,
    quartersAvailable: 12,
    ...over,
  };
}

function row(over: Partial<ScreenRow> = {}): ScreenRow {
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "compute_gpu_cpu",
    price: 100,
    dollarVolume: 50_000_000,
    r1m: 5,
    r3m: 20,
    r6m: 40,
    r12m: 80,
    maProxy: 80,
    vsMa: 25,
    rsRaw: 40,
    rsPct: 95,
    tier: "Strong Buy",
    weight: 0.0743,
    ...over,
  };
}

describe("fundamentalGate", () => {
  it("passes a name whose revenue growth is accelerating", () => {
    expect(fundamentalGate(fundamentals({ revAccel: 8 })).verdict).toBe("pass");
  });

  it("passes a name whose operating margin is expanding", () => {
    expect(fundamentalGate(fundamentals({ opMarginDelta: 2.5 })).verdict).toBe("pass");
  });

  it("passes on either signal, not both", () => {
    const g = fundamentalGate(fundamentals({ revAccel: -5, opMarginDelta: 3 }));
    expect(g.verdict).toBe("pass");
  });

  it("demotes a name that is decelerating and compressing", () => {
    const g = fundamentalGate(fundamentals({ revAccel: -6, opMarginDelta: -1.2 }));
    expect(g.verdict).toBe("demote");
    expect(g.reason).toMatch(/decelerat|compress/i);
  });

  // The important one: absent data must not be treated as a failing grade.
  // Non-filers and not-yet-fetched names would otherwise be silently punished
  // for something they were never measured on.
  it("reports unverified when there are no fundamentals at all", () => {
    expect(fundamentalGate(null).verdict).toBe("unverified");
  });

  it("reports unverified when both signals are null", () => {
    const g = fundamentalGate(fundamentals({ revAccel: null, opMarginDelta: null }));
    expect(g.verdict).toBe("unverified");
  });

  it("uses whichever signal is present when the other is null", () => {
    expect(fundamentalGate(fundamentals({ revAccel: 4, opMarginDelta: null })).verdict).toBe("pass");
    expect(fundamentalGate(fundamentals({ revAccel: -4, opMarginDelta: null })).verdict).toBe(
      "demote",
    );
  });
});

describe("applyFundamentalOverlay", () => {
  it("demotes a failing Strong Buy to Buy and records why", () => {
    const f = new Map([["TEST", fundamentals({ revAccel: -6, opMarginDelta: -1 })]]);
    const [out] = applyFundamentalOverlay([row()], f);
    expect(out.tier).toBe("Buy");
    expect(out.momentumTier).toBe("Strong Buy");
    expect(out.gate).toBe("demote");
    expect(out.gateReason).toBeTruthy();
  });

  it("leaves a passing Strong Buy alone", () => {
    const f = new Map([["TEST", fundamentals({ revAccel: 9 })]]);
    const [out] = applyFundamentalOverlay([row()], f);
    expect(out.tier).toBe("Strong Buy");
    expect(out.gate).toBe("pass");
  });

  it("never demotes a name that is not Strong Buy", () => {
    const f = new Map([["TEST", fundamentals({ revAccel: -20, opMarginDelta: -5 })]]);
    const [buy] = applyFundamentalOverlay([row({ tier: "Buy" })], f);
    const [hold] = applyFundamentalOverlay([row({ tier: "Hold" })], f);
    expect(buy.tier).toBe("Buy");
    expect(hold.tier).toBe("Hold");
  });

  it("keeps the momentum tier when fundamentals are missing", () => {
    const [out] = applyFundamentalOverlay([row()], new Map());
    expect(out.tier).toBe("Strong Buy");
    expect(out.gate).toBe("unverified");
  });

  it("re-weights a demoted row to the Buy weight", () => {
    const f = new Map([["TEST", fundamentals({ revAccel: -6, opMarginDelta: -1 })]]);
    const [out] = applyFundamentalOverlay([row()], f);
    // Demoting the tier without re-weighting would leave a 7.43% sleeve on a
    // Buy-tier name, quietly breaking the 52/35/13 split.
    expect(out.weight).toBeCloseTo(0.05, 5);
  });
});
