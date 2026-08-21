import { describe, expect, it } from "vitest";
import { capStrongBuy } from "./strong-buy-cap";
import type { OverlaidRow } from "./fundamental-gate";

function row(over: Partial<OverlaidRow> = {}): OverlaidRow {
  return {
    ticker: "T",
    name: "Test",
    sector: "compute_gpu_cpu",
    price: 100,
    dollarVolume: 5e7,
    r1m: 1,
    r3m: 20,
    r6m: 40,
    r12m: 80,
    maProxy: 80,
    vsMa: 25,
    rsRaw: 40,
    rsPct: 90,
    tier: "Strong Buy",
    weight: 0.0743,
    momentumTier: "Strong Buy",
    gate: "pass",
    gateReason: "revenue accelerating",
    ...over,
  };
}

/** n Strong Buys with descending percentiles, plus optional extras. */
function strongBuys(n: number, extra: OverlaidRow[] = []): OverlaidRow[] {
  const rows = Array.from({ length: n }, (_, i) =>
    row({ ticker: `S${String(i).padStart(2, "0")}`, rsPct: 99 - i }),
  );
  return [...rows, ...extra];
}

describe("capStrongBuy", () => {
  it("keeps the highest-ranked N and demotes the rest", () => {
    const out = capStrongBuy(strongBuys(15), 10);
    const kept = out.filter((r) => r.tier === "Strong Buy");
    expect(kept).toHaveLength(10);
    expect(kept.map((r) => r.ticker)).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09",
    ]);
  });

  it("demotes the overflow to Buy, not to Hold", () => {
    const out = capStrongBuy(strongBuys(12), 10);
    const overflow = out.filter((r) => r.ticker === "S10" || r.ticker === "S11");
    expect(overflow.every((r) => r.tier === "Buy")).toBe(true);
  });

  it("re-weights a capped row to the Buy sleeve", () => {
    const out = capStrongBuy(strongBuys(11), 10);
    const capped = out.find((r) => r.ticker === "S10")!;
    expect(capped.weight).toBeCloseTo(0.05, 5);
  });

  it("records why a name was capped", () => {
    const out = capStrongBuy(strongBuys(11), 10);
    expect(out.find((r) => r.ticker === "S10")!.capped).toBe(true);
    expect(out.find((r) => r.ticker === "S00")!.capped).toBe(false);
  });

  it("changes nothing when there are fewer than N Strong Buys", () => {
    const out = capStrongBuy(strongBuys(6), 10);
    expect(out.filter((r) => r.tier === "Strong Buy")).toHaveLength(6);
    expect(out.every((r) => !r.capped)).toBe(true);
  });

  it("changes nothing at exactly N", () => {
    const out = capStrongBuy(strongBuys(10), 10);
    expect(out.filter((r) => r.tier === "Strong Buy")).toHaveLength(10);
  });

  it("never promotes a Buy or Hold into the cap", () => {
    const extras = [
      row({ ticker: "B1", tier: "Buy", momentumTier: "Buy", rsPct: 70, weight: 0.05 }),
      row({ ticker: "H1", tier: "Hold", momentumTier: "Hold", rsPct: 20, weight: 0.026 }),
    ];
    const out = capStrongBuy(strongBuys(3, extras), 10);
    expect(out.find((r) => r.ticker === "B1")!.tier).toBe("Buy");
    expect(out.find((r) => r.ticker === "H1")!.tier).toBe("Hold");
  });

  // The cap runs AFTER the fundamental gate, so a name the gate already moved
  // down must not consume one of the ten slots on its way out.
  it("does not let a gate-demoted name occupy a slot", () => {
    const demoted = row({
      ticker: "GATE",
      rsPct: 100,
      tier: "Buy",
      momentumTier: "Strong Buy",
      gate: "demote",
      weight: 0.05,
    });
    const out = capStrongBuy(strongBuys(10, [demoted]), 10);
    expect(out.filter((r) => r.tier === "Strong Buy")).toHaveLength(10);
    expect(out.find((r) => r.ticker === "GATE")!.tier).toBe("Buy");
    // All ten momentum names survive; the gate-demoted one never competed.
    expect(out.find((r) => r.ticker === "S09")!.tier).toBe("Strong Buy");
  });

  it("breaks ties deterministically so the boundary does not flap", () => {
    const tied = Array.from({ length: 12 }, (_, i) =>
      row({ ticker: `T${String(i).padStart(2, "0")}`, rsPct: 88, vsMa: 10 }),
    );
    // capStrongBuy preserves input order, so compare MEMBERSHIP rather than
    // sequence: reversing the input legitimately reverses the output.
    const members = (rows: OverlaidRow[]) =>
      capStrongBuy(rows, 10)
        .filter((r) => r.tier === "Strong Buy")
        .map((r) => r.ticker)
        .sort();

    expect(members(tied)).toEqual(members([...tied].reverse()));
    expect(members(tied)).toHaveLength(10);
  });
});
