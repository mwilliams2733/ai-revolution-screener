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

/**
 * A three-name field for two slots, so the contest is unambiguously between the
 * incumbent and one challenger. A wider field does not test what it looks like
 * it tests: a challenger that leapfrogs several names takes the slot of whoever
 * happens to sit at the cut, not the incumbent's.
 *
 * In every case below the challenger outranks the incumbent on RAW percentile,
 * so a version of this cap without the margin gives the opposite answer.
 */
describe("capStrongBuy incumbency", () => {
  const field = (challenger: number) => [
    row({ ticker: "AAA", rsPct: 95 }),
    row({ ticker: "BBB", rsPct: 90 }),
    row({ ticker: "CCC", rsPct: challenger }),
  ];
  const kept = (rows: OverlaidRow[], incumbents: string[], margin?: number) =>
    capStrongBuy(rows, 2, undefined, new Set(incumbents), margin)
      .filter((r) => r.tier === "Strong Buy")
      .map((r) => r.ticker);

  it("keeps an incumbent overtaken by less than the margin", () => {
    expect(kept(field(91), ["BBB"])).toEqual(["AAA", "BBB"]);
    // Without the margin the same input swaps them. This is what it buys.
    expect(kept(field(91), [])).toEqual(["AAA", "CCC"]);
  });

  it("evicts the incumbent once the challenger clears the margin", () => {
    expect(kept(field(93), ["BBB"])).toEqual(["AAA", "CCC"]);
  });

  /**
   * The margin defends a slot; it must not create one. An incumbent that has
   * fallen away loses the seat, or the tier ratchets shut and membership
   * freezes at whoever happened to hold it first.
   */
  it("does not save an incumbent that has fallen far below the field", () => {
    expect(kept(field(80), ["BBB"])).toEqual(["AAA", "BBB"]);
    expect(kept([...field(80), row({ ticker: "DDD", rsPct: 94 })], ["BBB"])).toEqual([
      "AAA",
      "DDD",
    ]);
  });

  it("still fills every slot when no incumbent is left contending", () => {
    expect(kept(field(91), ["GONE", "ALSOGONE"])).toEqual(["AAA", "CCC"]);
  });

  it("never lets incumbency push membership past the limit", () => {
    expect(kept(field(91), ["AAA", "BBB", "CCC"])).toHaveLength(2);
  });

  it("gives the same membership whatever order the rows arrive in", () => {
    const rows = field(91);
    // Sorted: `kept` reports in input order, and the claim is about membership.
    expect(kept([...rows].reverse(), ["BBB"]).sort()).toEqual(kept(rows, ["BBB"]).sort());
  });

  it("marks both sides of a slot incumbency decided, and nobody else", () => {
    const by = new Map(
      capStrongBuy(field(91), 2, undefined, new Set(["BBB"])).map((r) => [r.ticker, r]),
    );
    expect(by.get("BBB")!.capHeld).toBe(true);
    expect(by.get("CCC")!.capHeld).toBe(true);
    expect(by.get("AAA")!.capHeld).toBe(false);
  });

  it("behaves exactly like the plain cap with no incumbents", () => {
    const rows = field(91);
    const sticky = capStrongBuy(rows, 2, undefined, new Set());
    expect(sticky.map((r) => r.tier)).toEqual(capStrongBuy(rows, 2).map((r) => r.tier));
    expect(sticky.every((r) => !r.capHeld)).toBe(true);
  });

  it("ignores incumbency at zero margin", () => {
    expect(kept(field(91), ["BBB"], 0)).toEqual(["AAA", "CCC"]);
  });
});
