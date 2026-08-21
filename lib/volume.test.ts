import { describe, expect, it } from "vitest";
import {
  VOLUME_WINDOW,
  accumulationGrade,
  isConfirmed,
  obvSeries,
  obvSlope,
  relativeVolume,
  upDownVolumeRatio,
  volumeProfile,
} from "./volume";
import type { VolumeBar } from "./volume";

/** Bars from explicit close/volume pairs, oldest first. */
const bars = (pairs: [number, number][]): VolumeBar[] =>
  pairs.map(([close, volume]) => ({ close, volume }));

/** `n` bars alternating up and down by `step`, with fixed volume. */
function alternating(n: number, upVol: number, downVol: number): VolumeBar[] {
  const out: VolumeBar[] = [{ close: 100, volume: 1000 }];
  for (let i = 1; i < n; i++) {
    const up = i % 2 === 1;
    out.push({ close: out[i - 1].close + (up ? 1 : -1), volume: up ? upVol : downVol });
  }
  return out;
}

describe("upDownVolumeRatio", () => {
  it("divides volume on advancing days by volume on declining days", () => {
    // 4 comparisons: up(200), down(100), up(200), down(100) => 400/200 = 2.
    const b = bars([
      [100, 999],
      [101, 200],
      [100, 100],
      [101, 200],
      [100, 100],
    ]);
    expect(upDownVolumeRatio(b, 4)).toBeCloseTo(2, 6);
  });

  it("excludes unchanged days from both sides", () => {
    // Flat day carries huge volume and must not tilt the ratio.
    const b = bars([
      [100, 10],
      [101, 100],
      [101, 9_999_999],
      [100, 100],
    ]);
    expect(upDownVolumeRatio(b, 3)).toBeCloseTo(1, 6);
  });

  // Infinity is not a ratio. A name that never declined has no measurable
  // down volume, and rendering that as an enormous number would rank it top.
  it("returns null when there is no down volume to divide by", () => {
    const b = bars([
      [100, 10],
      [101, 100],
      [102, 100],
    ]);
    expect(upDownVolumeRatio(b, 2)).toBeNull();
  });

  it("returns null rather than a partial window", () => {
    expect(upDownVolumeRatio(alternating(10, 200, 100), 50)).toBeNull();
    expect(upDownVolumeRatio([], 50)).toBeNull();
  });

  it("needs one bar more than the window, since it compares consecutive closes", () => {
    expect(upDownVolumeRatio(alternating(50, 200, 100), 50)).toBeNull();
    expect(upDownVolumeRatio(alternating(51, 200, 100), 50)).not.toBeNull();
  });

  it("rejects a series containing non-finite values", () => {
    const b = bars([
      [100, 10],
      [Number.NaN, 100],
      [100, 100],
    ]);
    expect(upDownVolumeRatio(b, 2)).toBeNull();
  });
});

describe("obvSeries", () => {
  it("adds volume on up days, subtracts on down days, ignores flat", () => {
    const b = bars([
      [100, 10],
      [101, 50],
      [101, 70],
      [100, 30],
    ]);
    expect(obvSeries(b)).toEqual([0, 50, 50, 20]);
  });
});

describe("obvSlope", () => {
  it("is positive when on-balance volume is trending up", () => {
    const rising: VolumeBar[] = [{ close: 100, volume: 1000 }];
    for (let i = 1; i < 60; i++) rising.push({ close: 100 + i, volume: 1000 });
    const s = obvSlope(rising, 50);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
  });

  it("is negative when on-balance volume is trending down", () => {
    const falling: VolumeBar[] = [{ close: 200, volume: 1000 }];
    for (let i = 1; i < 60; i++) falling.push({ close: 200 - i, volume: 1000 });
    expect(obvSlope(falling, 50)!).toBeLessThan(0);
  });

  /**
   * Normalised by mean volume so it is comparable across tickers. Raw OBV
   * levels scale with float, so an unnormalised slope would rank megacaps
   * above everything regardless of their actual trend.
   */
  it("is scale-invariant across wildly different float", () => {
    const small: VolumeBar[] = [{ close: 100, volume: 1_000 }];
    const large: VolumeBar[] = [{ close: 100, volume: 500_000_000 }];
    for (let i = 1; i < 60; i++) {
      small.push({ close: 100 + i, volume: 1_000 });
      large.push({ close: 100 + i, volume: 500_000_000 });
    }
    expect(obvSlope(small, 50)!).toBeCloseTo(obvSlope(large, 50)!, 6);
  });

  it("returns null rather than a partial window", () => {
    expect(obvSlope(alternating(20, 100, 100), 50)).toBeNull();
  });

  it("returns null when mean volume is zero", () => {
    const dead = Array.from({ length: 60 }, () => ({ close: 100, volume: 0 }));
    expect(obvSlope(dead, 50)).toBeNull();
  });
});

describe("relativeVolume", () => {
  it("compares today against the mean of the prior window", () => {
    const b: VolumeBar[] = Array.from({ length: 50 }, () => ({ close: 100, volume: 1_000 }));
    b.push({ close: 100, volume: 3_000 });
    expect(relativeVolume(b, 50)).toBeCloseTo(3, 6);
  });

  it("excludes today from its own baseline", () => {
    const b: VolumeBar[] = Array.from({ length: 50 }, () => ({ close: 100, volume: 1_000 }));
    b.push({ close: 100, volume: 51_000 });
    // Including today would give 51000/1980 ~ 25.8 instead of 51.
    expect(relativeVolume(b, 50)).toBeCloseTo(51, 6);
  });

  it("returns null rather than a partial window", () => {
    expect(relativeVolume(alternating(10, 100, 100), 50)).toBeNull();
  });

  it("returns null when the baseline is zero", () => {
    const b: VolumeBar[] = Array.from({ length: 50 }, () => ({ close: 100, volume: 0 }));
    b.push({ close: 100, volume: 500 });
    expect(relativeVolume(b, 50)).toBeNull();
  });
});

describe("accumulationGrade", () => {
  it("bands the percentile into IBD-style letters", () => {
    expect(accumulationGrade(95)).toBe("A");
    expect(accumulationGrade(80)).toBe("A");
    expect(accumulationGrade(79.9)).toBe("B");
    expect(accumulationGrade(60)).toBe("B");
    expect(accumulationGrade(59.9)).toBe("C");
    expect(accumulationGrade(40)).toBe("C");
    expect(accumulationGrade(39.9)).toBe("D");
    expect(accumulationGrade(20)).toBe("D");
    expect(accumulationGrade(19.9)).toBe("E");
    expect(accumulationGrade(0)).toBe("E");
  });

  it("returns null for an unmeasured percentile", () => {
    expect(accumulationGrade(null)).toBeNull();
  });
});

describe("volumeProfile", () => {
  it("returns every field null when history is too short", () => {
    const p = volumeProfile(alternating(10, 200, 100));
    expect(p.udRatio).toBeNull();
    expect(p.obvSlope).toBeNull();
    expect(p.rvol).toBeNull();
    expect(p.window).toBe(VOLUME_WINDOW);
  });

  it("computes all three when history allows", () => {
    const p = volumeProfile(alternating(80, 200, 100));
    expect(p.udRatio).not.toBeNull();
    expect(p.obvSlope).not.toBeNull();
    expect(p.rvol).not.toBeNull();
  });
});

describe("isConfirmed", () => {
  it("confirms accumulation in a buy-side tier", () => {
    expect(isConfirmed(1.4, 0.2, "Strong Buy")).toBe(true);
    expect(isConfirmed(1.4, 0.2, "Buy")).toBe(true);
  });

  // The point of the flag: a Strong Buy rising on weak volume is exactly the
  // setup the strategy's own logic says should be trimmed.
  it("refuses to confirm a Strong Buy on distribution", () => {
    expect(isConfirmed(0.8, 0.2, "Strong Buy")).toBe(false);
    expect(isConfirmed(1.4, -0.1, "Strong Buy")).toBe(false);
  });

  it("never confirms a Hold", () => {
    expect(isConfirmed(2.0, 1.0, "Hold")).toBe(false);
  });

  it("is false, not true, when the inputs were never measured", () => {
    expect(isConfirmed(null, 0.2, "Strong Buy")).toBe(false);
    expect(isConfirmed(1.4, null, "Strong Buy")).toBe(false);
  });
});
