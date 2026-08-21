import { describe, expect, it } from "vitest";
import {
  TREND_MIN_HISTORY,
  rollingMeans,
  trendTemplate,
  weinsteinStage,
} from "./trend-template";
import type { TrendBar } from "./trend-template";

/** Bars from a close series; high/low bracket each close by 1%. */
function fromCloses(closes: readonly number[]): TrendBar[] {
  return closes.map((c) => ({ close: c, high: c * 1.01, low: c * 0.99 }));
}

/** `n` bars rising linearly from `start` by `step` each session. */
const ramp = (n: number, start = 100, step = 1): TrendBar[] =>
  fromCloses(Array.from({ length: n }, (_, i) => start + i * step));

/** `n` bars all at the same price. */
const flat = (n: number, price = 100): TrendBar[] => fromCloses(Array(n).fill(price));

describe("rollingMeans", () => {
  it("computes every window in one pass", () => {
    const closes = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
    const out = rollingMeans(closes, [3, 5]);
    // Last 3 of 1..10 are 8,9,10 => 9. Last 5 are 6..10 => 8.
    expect(out.get(3)!.at(-1)).toBeCloseTo(9, 10);
    expect(out.get(5)!.at(-1)).toBeCloseTo(8, 10);
  });

  it("leaves null where the window is not yet filled", () => {
    const out = rollingMeans([1, 2, 3, 4], [3]);
    expect(out.get(3)).toEqual([null, null, 2, 3]);
  });
});

describe("trendTemplate", () => {
  /**
   * The whole point of the "null the template" decision: without true moving
   * averages there is no trend template, only criterion 8, and reporting 1/8
   * would read as a near-total failure rather than as missing data.
   */
  it("returns null below the minimum history rather than a partial score", () => {
    expect(trendTemplate(ramp(TREND_MIN_HISTORY - 1), 95)).toBeNull();
    expect(trendTemplate([], 95)).toBeNull();
  });

  it("accepts exactly the minimum history", () => {
    expect(trendTemplate(ramp(TREND_MIN_HISTORY), 95)).not.toBeNull();
  });

  it("scores a clean uptrend at or near 8 of 8", () => {
    const t = trendTemplate(ramp(300), 95)!;
    expect(t.count).toBeGreaterThanOrEqual(7);
    expect(t.flags.priceAboveLongMas).toBe(true);
    expect(t.flags.ma150AboveMa200).toBe(true);
    expect(t.flags.ma200Rising).toBe(true);
    expect(t.flags.ma50AboveLongMas).toBe(true);
    expect(t.flags.rsAtLeast70).toBe(true);
  });

  it("scores a sustained downtrend near zero", () => {
    const down = fromCloses(Array.from({ length: 300 }, (_, i) => 400 - i));
    const t = trendTemplate(down, 12)!;
    expect(t.count).toBeLessThanOrEqual(2);
    expect(t.flags.priceAboveLongMas).toBe(false);
    expect(t.flags.ma200Rising).toBe(false);
    expect(t.flags.rsAtLeast70).toBe(false);
  });

  it("reports which criterion failed, not just the count", () => {
    // Strong trend but weak relative strength: only criterion 8 should fail.
    const t = trendTemplate(ramp(300), 40)!;
    expect(t.flags.rsAtLeast70).toBe(false);
    expect(t.count).toBe(7);
  });

  it("uses intraday extremes for the 52-week range, not closes", () => {
    // A spike high above every close must pull criterion 7 down.
    const bars = ramp(300);
    const spiked = bars.map((b, i) => (i === 100 ? { ...b, high: b.close * 10 } : b));
    const withSpike = trendTemplate(spiked, 95)!;
    expect(withSpike.flags.within25PctOfHigh).toBe(false);
    expect(trendTemplate(bars, 95)!.flags.within25PctOfHigh).toBe(true);
  });

  it("treats a null relative strength as a failed criterion, not a crash", () => {
    const t = trendTemplate(ramp(300), null)!;
    expect(t.flags.rsAtLeast70).toBe(false);
  });

  it("returns null when the series contains non-finite values", () => {
    const bad = ramp(300);
    bad[50] = { close: Number.NaN, high: 1, low: 1 };
    expect(trendTemplate(bad, 95)).toBeNull();
  });
});

describe("weinsteinStage", () => {
  it("calls a rising trend above the 150d average Stage 2", () => {
    expect(weinsteinStage(ramp(300))!.stage).toBe(2);
  });

  it("calls a sustained decline Stage 4", () => {
    const down = fromCloses(Array.from({ length: 300 }, (_, i) => 400 - i));
    expect(weinsteinStage(down)!.stage).toBe(4);
  });

  it("calls a flat base Stage 1", () => {
    expect(weinsteinStage(flat(300))!.stage).toBe(1);
  });

  /**
   * Boundaries in stage analysis are genuinely fuzzy. Forcing an ambiguous
   * series into a numbered bucket would claim precision the method does not
   * have, so anything unmatched is labelled Transitional instead.
   */
  it("labels an unmatched shape Transitional rather than guessing", () => {
    // A flat 150d average drifting very slightly down, with price far below it.
    // Not Stage 1 (price is far below), not 2 (slope is not rising), not 3
    // (slope is not positive), not 4 (slope is not steep enough). The honest
    // answer is that it fits no bucket.
    const closes = Array.from({ length: 288 }, () => 100);
    for (let i = 0; i < 12; i++) closes.push(100 - (i + 1) * 1.3);

    const r = weinsteinStage(fromCloses(closes))!;
    expect(r.stage).toBe("Transitional");
    expect(r.label).toBe("Transitional");
    expect(r.slope150).toBeGreaterThan(-0.02);
    expect(r.slope150).toBeLessThan(0);
  });

  it("returns null without enough history for the average and its slope", () => {
    expect(weinsteinStage(ramp(100))).toBeNull();
  });

  it("smooths the slope over ten sessions so one day cannot flip the stage", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i);
    const base = weinsteinStage(fromCloses(closes))!;
    closes[299] = closes[299] - 3; // one soft day
    expect(weinsteinStage(fromCloses(closes))!.stage).toBe(base.stage);
  });
});
