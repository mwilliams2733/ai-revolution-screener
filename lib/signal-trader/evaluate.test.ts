import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bonferroniT, buildPanel, clustered, fitCutoffs, quantile, rowsAfter, ruleFirings, splitPanel, stats, type Row,
} from "./evaluate";
import { LAB_DIR, readLabBars } from "./lab-data";
import type { Bar } from "./types";

const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as {
  as_of: string; start: string; tickers: string[]; cutoffs: Record<string, { lo: number; hi: number }>;
};
const HORIZONS = [1, 3, 5, 10, 20];

function labPanel() {
  const bars = new Map<string, Bar[]>();
  for (const t of golden.tickers) bars.set(t, readLabBars(t, golden.start, golden.as_of));
  return buildPanel(bars, HORIZONS);
}

describe("the lab's evaluation, reproduced", () => {
  const panel = labPanel();
  const { train, test } = splitPanel(panel);
  const cutoffs = fitCutoffs(train, panel.features);

  it("fits the same decile cutoffs as the lab", () => {
    for (const [col, c] of Object.entries(golden.cutoffs)) {
      expect(cutoffs[col as keyof typeof cutoffs].hi).toBeCloseTo(c.hi, 10);
      expect(cutoffs[col as keyof typeof cutoffs].lo).toBeCloseTo(c.lo, 10);
    }
  });

  it("reproduces the headline: vol_spike, 10 days, test set", () => {
    const s = stats(ruleFirings(test, panel.features, "vol_spike", cutoffs, 10).map((r) => r.fwd[10]));
    expect(s.n).toBe(162);
    expect(s.mean).toBeCloseTo(0.023424082288899868, 12);
    expect(s.hit).toBeCloseTo(0.6234567901234568, 12);
    expect(s.t).toBeCloseTo(3.8722518944992226, 9);
  });

  it("reproduces a decile rule: mom_20 long, 10 days", () => {
    const s = stats(ruleFirings(test, panel.features, "mom_20__long", cutoffs, 10).map((r) => r.fwd[10]));
    expect(s.n).toBe(87);
    expect(s.mean).toBeCloseTo(0.031579718205131765, 12);
  });
});

describe("helpers", () => {
  it("quantile interpolates linearly, like pandas", () => {
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([5], 0.1)).toBe(5);
  });

  it("Bonferroni bar for the lab's 155 tests is about 3.6", () => {
    // 0.05 / (2 * 155) = 1.61e-4 in each tail -> z = 3.597
    expect(bonferroniT(155)).toBeCloseTo(3.6, 1);
  });

  it("clusters same-day firings and counts non-overlapping episodes", () => {
    const cal = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
    const row = (ticker: string, session: string, r: number): Row => ({ ticker, session, i: 0, fwd: { 3: r } });
    // d0: two tickers fire together; d2 overlaps d0's 3-session window; d5 starts a new one.
    const c = clustered(
      [row("A", "d0", 0.02), row("B", "d0", 0.04), row("A", "d2", 0.01), row("C", "d5", -0.01)],
      3,
      cal,
    );
    expect(c.dates).toBe(3);
    expect(c.episodes).toBe(2);
    // date means: d0 .03, d2 .01, d5 -.01 -> mean .01, sd .02, se .02/sqrt(3)
    expect(c.tDates).toBeCloseTo(0.01 / (0.02 / Math.sqrt(3)), 10);
  });
});

describe("rowsAfter", () => {
  it("keeps only rows strictly after the cutoffs' training period", () => {
    const row = (session: string): Row => ({ ticker: "A", session, i: 0, fwd: {} });
    const rows = [row("2025-03-10"), row("2025-03-11"), row("2025-03-12")];
    expect(rowsAfter(rows, "2025-03-11").map((r) => r.session)).toEqual(["2025-03-12"]);
  });
});
