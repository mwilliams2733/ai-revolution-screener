import { describe, expect, it } from "vitest";
import {
  applyHealth,
  describe as describeHealth,
  healthCappedCount,
  healthUnknownCount,
  type HealthFacts,
} from "./health-overlay";
import { DEFAULT_THRESHOLDS, assess, type FactPoint } from "./solvency";
import type { Split } from "./splits";
import type { ScreenRow, Tier } from "./types";

const ytd = (year: number, millions: number[]): FactPoint[] =>
  millions.map((m, i) => ({
    start: `${year}-01-01`,
    end: [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`][i],
    val: m * 1e6,
  }));

/** Shares growing by `growth` over the year, e.g. 0.42 for AXTI. */
const shares = (growth: number): FactPoint[] => [
  { end: "2025-08-01", val: 100e6 },
  { end: "2026-08-01", val: 100e6 * (1 + growth) },
];

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  shares: shares(0.02),
  cash: 2_000e6,
  ocf: ytd(2026, [200, 420, 650, 900]),
  revenue: 5_000e6,
  ...over,
});

function row(over: Partial<ScreenRow> = {}): ScreenRow {
  return {
    ticker: "T", name: "Test", sector: "compute_gpu_cpu", price: 50, dollarVolume: 5e7,
    r1m: 1, r3m: 10, r6m: 20, r12m: 30, maProxy: 45, vsMa: 10,
    rsRaw: 20, rsPct: 95, tier: "Strong Buy" as Tier | null, weight: 0.0743, ...over,
  };
}

const NO_SPLITS = new Map<string, Split[]>();

describe("applyHealth", () => {
  it("leaves a sound company alone", () => {
    const [out] = applyHealth([row()], new Map([["T", facts()]]), NO_SPLITS);
    expect(out.tier).toBe("Strong Buy");
    expect(out.healthCapped).toBe(false);
    expect(out.health!.verdict).toBe("pass");
  });

  /**
   * AXTI: the top-ranked name in the theme, growing its share count 42% a year.
   * A price chart cannot show this, which is the entire reason the guardrail
   * exists.
   */
  it("caps a serial diluter at Hold", () => {
    const [out] = applyHealth(
      [row()],
      new Map([["T", facts({ shares: shares(0.42) })]]),
      NO_SPLITS,
    );
    expect(out.tier).toBe("Hold");
    expect(out.healthCapped).toBe(true);
    expect(out.healthReason).toMatch(/shares \+42%/);
  });

  it("re-weights a capped row so the sleeve does not follow it down", () => {
    const [out] = applyHealth(
      [row()],
      new Map([["T", facts({ shares: shares(0.42) })]]),
      NO_SPLITS,
    );
    expect(out.weight).toBeCloseTo(0.026, 6);
  });

  /**
   * The 30% threshold was chosen to sit in a gap rather than inside a cluster.
   * LITE at 28% passes; AAOI at 36% does not. If these two ever land the same
   * way the threshold has stopped separating anything.
   */
  it("separates the 28% names from the 36% names", () => {
    const at = (g: number) =>
      applyHealth([row()], new Map([["T", facts({ shares: shares(g) })]]), NO_SPLITS)[0];
    expect(at(0.28).tier).toBe("Strong Buy");
    expect(at(0.26).tier).toBe("Strong Buy");
    expect(at(0.36).tier).toBe("Hold");
    expect(at(0.42).tier).toBe("Hold");
  });

  /**
   * Cover-page share counts are never restated for splits, so a 10-for-1 reads
   * as +900% issuance. Without this the guardrail would cap KLAC and NOW --
   * companies that had bought stock back.
   */
  it("does not cap a company whose shares grew because of a split", () => {
    const klac: FactPoint[] = [
      { end: "2025-07-21", val: 131.96e6 },
      { end: "2026-08-03", val: 1306.55e6 },
    ];
    const raw = applyHealth([row()], new Map([["T", facts({ shares: klac })]]), NO_SPLITS)[0];
    expect(raw.tier).toBe("Hold"); // the bug, if splits are ignored

    const fixed = applyHealth(
      [row()],
      new Map([["T", facts({ shares: klac })]]),
      new Map([["T", [{ ticker: "T", executionDate: "2026-06-12", from: 1, to: 10 }]]]),
    )[0];
    expect(fixed.tier).toBe("Strong Buy");
    expect(fixed.healthCapped).toBe(false);
  });

  /**
   * The distinction the whole design rests on. A company we could not measure
   * is not a company that failed; capping on "unknown" would silently demote
   * every filer we cannot read, with nothing on screen saying so.
   */
  it("never caps a name it could not measure", () => {
    const blank: HealthFacts = { shares: [], cash: null, ocf: [], revenue: null };
    const [out] = applyHealth([row()], new Map([["T", blank]]), NO_SPLITS);
    expect(out.health!.verdict).toBe("unknown");
    expect(out.tier).toBe("Strong Buy");
    expect(out.healthCapped).toBe(false);
  });

  it("leaves a name with no cached facts entirely untouched", () => {
    const [out] = applyHealth([row()], new Map(), NO_SPLITS);
    expect(out.health).toBeNull();
    expect(out.tier).toBe("Strong Buy");
    expect(out.healthReason).toBe("");
  });

  it("does not cap a Hold, which is already the floor", () => {
    const [out] = applyHealth(
      [row({ tier: "Hold", weight: 0.026 })],
      new Map([["T", facts({ shares: shares(0.42) })]]),
      NO_SPLITS,
    );
    expect(out.tier).toBe("Hold");
    expect(out.healthCapped).toBe(false);
    // The reason is still attached: the row explains itself either way.
    expect(out.healthReason).toMatch(/shares/);
  });

  it("caps a Buy as well as a Strong Buy", () => {
    const [out] = applyHealth(
      [row({ tier: "Buy", weight: 0.05 })],
      new Map([["T", facts({ shares: shares(0.42) })]]),
      NO_SPLITS,
    );
    expect(out.tier).toBe("Hold");
    expect(out.healthCapped).toBe(true);
  });

  it("caps on runway as well as dilution", () => {
    const [out] = applyHealth(
      [row()],
      new Map([["T", facts({ cash: 100e6, ocf: ytd(2026, [-150, -300, -450, -600]), revenue: 0 })]]),
      NO_SPLITS,
    );
    expect(out.tier).toBe("Hold");
    expect(out.healthReason).toMatch(/months of cash/);
  });

  it("counts what it capped and what it could not measure", () => {
    const out = applyHealth(
      [
        row({ ticker: "A" }),
        row({ ticker: "B" }),
        row({ ticker: "C" }),
      ],
      new Map([
        ["A", facts()],
        ["B", facts({ shares: shares(0.42) })],
        ["C", { shares: [], cash: null, ocf: [], revenue: null }],
      ]),
      NO_SPLITS,
    );
    expect(healthCappedCount(out)).toBe(1);
    expect(healthUnknownCount(out)).toBe(1);
  });

  it("honours a custom threshold", () => {
    const strict = { ...DEFAULT_THRESHOLDS, maxDilution: 0.2 };
    const [out] = applyHealth(
      [row()],
      new Map([["T", facts({ shares: shares(0.28) })]]),
      NO_SPLITS,
      strict,
    );
    expect(out.tier).toBe("Hold");
  });
});

describe("describe", () => {
  it("quotes the measurement and the limit it broke", () => {
    const h = assess({
      price: 50,
      shares: [
        { end: "2025-08-01", val: 100e6 },
        { end: "2026-08-01", val: 142e6 },
      ],
      cash: 2_000e6,
      operatingCashFlow: ytd(2026, [200, 420, 650, 900]),
      revenue: 5_000e6,
    });
    expect(describeHealth(h)).toBe("shares +42% in a year (limit 30%)");
  });

  it("is empty for a company that failed nothing", () => {
    expect(describeHealth(assess({ price: 50, shares: [], cash: null, operatingCashFlow: [] })))
      .toBe("");
  });

  it("lists every failure when more than one applies", () => {
    const h = assess({
      price: 1,
      shares: [
        { end: "2025-08-01", val: 10e6 },
        { end: "2026-08-01", val: 20e6 },
      ],
      cash: 10e6,
      operatingCashFlow: ytd(2026, [-50, -100, -150, -200]),
      revenue: 0,
    });
    expect(h.failures.length).toBeGreaterThan(1);
    expect(describeHealth(h)).toMatch(/;/);
  });
});
