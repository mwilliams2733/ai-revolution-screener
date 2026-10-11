import { describe, expect, it } from "vitest";
import { episodesOf, meanCi, scoreSignals, tCrit } from "./grading";
import type { Grade } from "./engine";

const g = (over: Partial<Grade>): Grade => ({
  key: "k", signal: "vol_spike", ticker: "NVDA", entrySession: "s0", exitSession: "s9",
  realizedReturn: 0.01, spyReturn: 0.005, excessReturn: 0.005, hit: true, pnl: 10, expectedMove: 0.0234,
  ...over,
});
const idx = (s: string) => Number(s.slice(1));

describe("episodes", () => {
  it("merges overlapping windows across tickers into one episode", () => {
    const eps = episodesOf(
      [
        g({ key: "a", entrySession: "s0", exitSession: "s9" }),
        g({ key: "b", ticker: "AMD", entrySession: "s5", exitSession: "s14" }),
        g({ key: "c", ticker: "XOM", entrySession: "s15", exitSession: "s24" }),
      ],
      idx,
    );
    expect(eps.map((e) => e.map((r) => r.key))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("intervals", () => {
  it("uses the t distribution: two points, df 1", () => {
    const { mean, ci } = meanCi([0.01, 0.03]);
    expect(mean).toBeCloseTo(0.02, 12);
    // sd .014142, se .01, t(.975, 1) = 12.706
    expect(ci?.lo).toBeCloseTo(0.02 - 12.706 * 0.01, 10);
    expect(ci?.hi).toBeCloseTo(0.02 + 12.706 * 0.01, 10);
    expect(tCrit(40)).toBe(1.96);
  });

  it("gives no interval below two episodes", () => {
    expect(meanCi([0.01]).ci).toBeNull();
  });
});

describe("scoreSignals", () => {
  it("scores over episodes, warns under 30, and projects the time to 30", () => {
    const rows = [
      g({ key: "a", entrySession: "s0", exitSession: "s9", realizedReturn: 0.02, excessReturn: 0.01 }),
      g({ key: "b", entrySession: "s20", exitSession: "s29", realizedReturn: -0.01, excessReturn: -0.02, hit: false }),
    ];
    const [vol] = scoreSignals(rows, idx, 39);
    expect(vol).toMatchObject({ signal: "vol_spike", picks: 2, episodes: 2, smallSample: true });
    expect(vol.hitRate).toBe(0.5);
    expect(vol.meanRaw).toBeCloseTo(0.005, 12);
    // 2 episodes over 40 sessions -> 28 more at 0.05 a session = 560 sessions.
    expect(vol.sessionsTo30).toBeCloseTo(560, 10);
  });

  it("reports every configured signal, even with no grades", () => {
    const scores = scoreSignals([], idx, 0);
    expect(scores.map((s) => s.signal)).toEqual(["vol_spike", "vol_z", "intraday", "mom_20", "bb_pctb"]);
    expect(scores[0]).toMatchObject({ picks: 0, episodes: 0, hitRate: null, sessionsTo30: null });
  });
});
