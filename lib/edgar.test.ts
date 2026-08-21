import { describe, expect, it } from "vitest";
import {
  type CompanyFacts,
  deriveFundamentals,
  extractConcept,
  quarterly,
} from "./edgar";

/** Build a companyfacts payload from raw fact rows. */
function facts(
  concepts: Record<string, { unit?: string; rows: Partial<Record<string, unknown>>[] }>,
): CompanyFacts {
  const gaap: Record<string, { units: Record<string, unknown[]> }> = {};
  for (const [tag, { unit = "USD", rows }] of Object.entries(concepts)) {
    gaap[tag] = { units: { [unit]: rows } };
  }
  return { entityName: "Test Co", facts: { "us-gaap": gaap } } as CompanyFacts;
}

const q = (start: string, end: string, val: number, filed = "2026-01-01") => ({
  start,
  end,
  val,
  filed,
  form: "10-Q",
});

describe("extractConcept", () => {
  it("merges across tags instead of stopping at the first non-empty one", () => {
    // The real failure: a filer migrates concepts mid-history, so the preferred
    // tag holds ONLY the old periods while current data sits under another
    // name. Taking the first non-empty tag returns years-stale numbers that
    // still look well formed.
    const f = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        rows: [q("2026-01-01", "2026-03-31", 500)],
      },
      Revenues: { rows: [q("2019-01-01", "2019-03-31", 100)] },
    });

    const got = extractConcept(f, [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
    ]);

    expect(got.map((p) => p.end)).toEqual(["2019-03-31", "2026-03-31"]);
    expect(got.at(-1)?.val).toBe(500);
  });

  it("keeps the newest filing when a period is restated", () => {
    const f = facts({
      Revenues: {
        rows: [
          q("2026-01-01", "2026-03-31", 100, "2026-04-30"),
          q("2026-01-01", "2026-03-31", 115, "2026-08-01"), // restatement
        ],
      },
    });
    const got = extractConcept(f, ["Revenues"]);
    expect(got).toHaveLength(1);
    expect(got[0].val).toBe(115);
  });

  it("separates annual facts from quarterly ones by duration", () => {
    const f = facts({
      Revenues: {
        rows: [
          q("2026-01-01", "2026-12-31", 4000), // full year, from the 10-K
          q("2026-01-01", "2026-03-31", 900),
        ],
      },
    });
    expect(quarterly(extractConcept(f, ["Revenues"]))).toHaveLength(1);
  });
});

describe("year-over-year across the fiscal Q4 gap", () => {
  /**
   * A 10-K reports the full year rather than a separate fiscal Q4, so real
   * quarterly series are missing one quarter every year. These rows reproduce
   * that: no Q4 ends at all.
   *
   * Index arithmetic (periods[i - 4]) lands fifteen months back on this shape
   * and produces a wrong-but-plausible growth number. Matching by date is the
   * only thing that survives the gap.
   */
  const gappy = facts({
    Revenues: {
      rows: [
        q("2024-01-01", "2024-03-31", 100),
        q("2024-04-01", "2024-06-30", 110),
        q("2024-07-01", "2024-09-30", 120),
        // no Q4 2024
        q("2025-01-01", "2025-03-31", 150),
        q("2025-04-01", "2025-06-30", 160),
        q("2025-07-01", "2025-09-30", 170),
        // no Q4 2025
        q("2026-01-01", "2026-03-31", 200),
      ],
    },
    OperatingIncomeLoss: {
      rows: [
        q("2025-01-01", "2025-03-31", 15),
        q("2026-01-01", "2026-03-31", 40),
      ],
    },
  });

  const f = deriveFundamentals("0000000001", gappy);

  it("compares the latest quarter against the same quarter a year earlier", () => {
    // 2026-03-31 (200) vs 2025-03-31 (150) = +33.3%.
    // Index-4 would reach 2024-09-30 (120) and report +66.7%.
    expect(f.revYoY).toBeCloseTo(33.33, 1);
  });

  it("compares the prior quarter against its own year-earlier match", () => {
    // 2025-09-30 (170) vs 2024-09-30 (120) = +41.7%.
    expect(f.revYoYPrior).toBeCloseTo(41.67, 1);
  });

  it("derives acceleration from two correctly matched comparisons", () => {
    expect(f.revAccel).toBeCloseTo(33.33 - 41.67, 1);
  });

  it("aligns operating margin to the matching quarter a year back", () => {
    expect(f.opMargin).toBeCloseTo(20.0, 1); // 40/200
    expect(f.opMarginYearAgo).toBeCloseTo(10.0, 1); // 15/150
    expect(f.opMarginDelta).toBeCloseTo(10.0, 1);
  });

  it("refuses a match when no quarter falls near the one-year mark", () => {
    const sparse = facts({
      Revenues: {
        rows: [q("2022-01-01", "2022-03-31", 50), q("2026-01-01", "2026-03-31", 200)],
      },
    });
    expect(deriveFundamentals("0000000002", sparse).revYoY).toBeNull();
  });
});

describe("percentage change guards", () => {
  it("declines to score growth across a sign flip", () => {
    // Going from -5 to +5 is not "+200% growth"; the number would be noise.
    const f = facts({
      Revenues: {
        rows: [q("2025-01-01", "2025-03-31", -5), q("2026-01-01", "2026-03-31", 5)],
      },
    });
    expect(deriveFundamentals("0000000003", f).revYoY).toBeNull();
  });
});
