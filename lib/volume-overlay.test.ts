import { describe, expect, it } from "vitest";
import { applyVolume } from "./volume-overlay";
import type { VolumeBar } from "./volume";
import type { ScreenRow } from "./types";

function row(ticker: string, tier: ScreenRow["tier"] = "Strong Buy"): ScreenRow {
  return {
    ticker, name: ticker, sector: "compute_gpu_cpu", price: 100, dollarVolume: 5e7,
    r1m: 1, r3m: 10, r6m: 20, r12m: 30, maProxy: 90, vsMa: 10,
    rsRaw: 20, rsPct: 90, tier, weight: 0.0743,
  };
}

/** 60 bars whose up-volume dominance is controlled by `upVol`. */
function series(upVol: number, downVol = 100): VolumeBar[] {
  const out: VolumeBar[] = [{ close: 100, volume: 1000 }];
  for (let i = 1; i < 60; i++) {
    const up = i % 2 === 1;
    out.push({ close: out[i - 1].close + (up ? 1 : -1), volume: up ? upVol : downVol });
  }
  return out;
}

describe("applyVolume", () => {
  const ranked = ["AAA", "BBB", "CCC", "DDD", "EEE"].map((t) => row(t));
  const history = new Map<string, VolumeBar[]>([
    ["AAA", series(500)],
    ["BBB", series(300)],
    ["CCC", series(200)],
    ["DDD", series(120)],
    ["EEE", series(50)],
  ]);

  it("grades against the full universe, best ratio getting an A", () => {
    const out = applyVolume(ranked, ranked, history);
    const byTicker = new Map(out.map((r) => [r.ticker, r]));
    expect(byTicker.get("AAA")!.accumulation).toBe("A");
    expect(byTicker.get("EEE")!.accumulation).toBe("E");
  });

  /**
   * The grade must reflect the whole liquid universe, not the rendered subset.
   * Ranking inside the theme would make an "A" mean "best of these five".
   */
  it("does not re-rank when the themed subset is narrower", () => {
    const themedOnly = [row("EEE")];
    const out = applyVolume(ranked, themedOnly, history);
    // EEE is worst of five and must stay an E even when shown alone.
    expect(out[0].accumulation).toBe("E");
  });

  it("leaves every field null when there is no history", () => {
    const out = applyVolume(ranked, ranked, new Map());
    expect(out[0].volume.udRatio).toBeNull();
    expect(out[0].accumulation).toBeNull();
    expect(out[0].confirmed).toBe(false);
  });

  it("excludes unmeasured names from the percentile scale", () => {
    const partial = new Map<string, VolumeBar[]>([["AAA", series(500)]]);
    const out = applyVolume(ranked, ranked, partial);
    const byTicker = new Map(out.map((r) => [r.ticker, r]));
    // The four without history must not be ranked at the bottom; they are
    // simply unmeasured.
    expect(byTicker.get("BBB")!.accumulationPct).toBeNull();
    expect(byTicker.get("AAA")!.accumulationPct).not.toBeNull();
  });

  it("confirms only buy-side tiers with agreeing volume", () => {
    const out = applyVolume(ranked, [row("AAA"), row("AAA2", "Hold")], history);
    expect(out[0].confirmed).toBe(true);
    expect(out[1].confirmed).toBe(false);
  });
});
