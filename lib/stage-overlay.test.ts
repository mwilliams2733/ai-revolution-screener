import { describe, expect, it } from "vitest";
import { applyStageRule, stageDemotedCount } from "./stage-overlay";
import type { StageReport } from "./trend-template";
import type { ScreenRow, Tier } from "./types";

function stage(n: StageReport["stage"], slope = 0.01): StageReport {
  return {
    stage: n,
    slope150: slope,
    ma150: 100,
    label: typeof n === "number" ? `stage ${n}` : "Transitional",
  };
}

function row(over: Partial<ScreenRow & { stage: StageReport | null }> = {}) {
  return {
    ticker: "T",
    name: "Test",
    sector: "compute_gpu_cpu",
    price: 110,
    dollarVolume: 5e7,
    r1m: 1,
    r3m: 10,
    r6m: 20,
    r12m: 30,
    maProxy: 100,
    vsMa: 10,
    rsRaw: 20,
    rsPct: 90,
    tier: "Strong Buy" as Tier | null,
    weight: 0.0743,
    stage: stage(2),
    ...over,
  };
}

describe("applyStageRule", () => {
  it("caps a topping Strong Buy at Buy", () => {
    const [out] = applyStageRule([row({ stage: stage(3) })]);
    expect(out.tier).toBe("Buy");
    expect(out.stageCapped).toBe(true);
    expect(out.stageReason).toMatch(/topping|distribution/i);
  });

  it("caps a topping Buy at Hold", () => {
    const [out] = applyStageRule([row({ tier: "Buy", weight: 0.05, stage: stage(3) })]);
    expect(out.tier).toBe("Hold");
    expect(out.stageCapped).toBe(true);
  });

  it("caps a declining name the same way", () => {
    const [out] = applyStageRule([row({ stage: stage(4, -0.05) })]);
    expect(out.tier).toBe("Buy");
  });

  it("leaves an advancing name alone", () => {
    const [out] = applyStageRule([row({ stage: stage(2) })]);
    expect(out.tier).toBe("Strong Buy");
    expect(out.stageCapped).toBe(false);
  });

  it("leaves a base and a transitional name alone", () => {
    expect(applyStageRule([row({ stage: stage(1) })])[0].tier).toBe("Strong Buy");
    expect(applyStageRule([row({ stage: stage("Transitional") })])[0].tier).toBe("Strong Buy");
  });

  // A Hold is already the floor. The rule caps, it never pushes below.
  it("never demotes below Hold", () => {
    const [out] = applyStageRule([row({ tier: "Hold", weight: 0.026, stage: stage(4) })]);
    expect(out.tier).toBe("Hold");
    expect(out.stageCapped).toBe(false);
  });

  /**
   * A name without enough history has no stage. Treating that as topping would
   * punish recent listings for a gap in our data rather than for their chart.
   */
  it("leaves a name with no stage untouched", () => {
    const [out] = applyStageRule([row({ stage: null })]);
    expect(out.tier).toBe("Strong Buy");
    expect(out.stageCapped).toBe(false);
  });

  it("re-weights a capped row to its new tier", () => {
    const [strong] = applyStageRule([row({ stage: stage(3) })]);
    expect(strong.weight).toBeCloseTo(0.05, 6);

    const [buy] = applyStageRule([row({ tier: "Buy", weight: 0.05, stage: stage(3) })]);
    expect(buy.weight).toBeCloseTo(0.026, 6);
  });

  it("counts how many it moved", () => {
    const out = applyStageRule([
      row({ ticker: "A", stage: stage(3) }),
      row({ ticker: "B", stage: stage(2) }),
      row({ ticker: "C", tier: "Buy", weight: 0.05, stage: stage(4) }),
    ]);
    expect(stageDemotedCount(out)).toBe(2);
  });
});
