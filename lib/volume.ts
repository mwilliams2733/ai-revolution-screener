/**
 * Volume and accumulation. (METRICS_SPEC family 2)
 *
 * The closest computable proxy for what the source calls "relentless
 * institutional buying pressure" — which the decoded strategy asserts but never
 * measures. Momentum tells you the price moved; this family tells you whether
 * volume backed the move, which is the difference between accumulation and a
 * drift on thin trade.
 *
 * Pure and I/O-free. Every function returns null rather than a partial result
 * when history is short: a 50-day ratio computed from 12 bars is not a 50-day
 * ratio, and a screener that silently downgrades a name for lacking data is
 * reporting a verdict it never reached.
 */

import type { Tier } from "./types";

/** The only fields these metrics need from a daily bar. */
export interface VolumeBar {
  readonly close: number;
  readonly volume: number;
}

/** Lookback for every metric in this family. */
export const VOLUME_WINDOW = 50;

export type AccumulationGrade = "A" | "B" | "C" | "D" | "E";

export interface VolumeProfile {
  /** Advancing-day volume over declining-day volume. Above 1 is accumulation. */
  readonly udRatio: number | null;
  /** Least-squares OBV slope, normalised by mean volume. */
  readonly obvSlope: number | null;
  /** Today's volume against the prior window's mean. */
  readonly rvol: number | null;
  readonly window: number;
}

const finite = (n: number): boolean => typeof n === "number" && Number.isFinite(n);

/** True when every bar in the slice carries usable numbers. */
function usable(bars: readonly VolumeBar[]): boolean {
  return bars.every((b) => finite(b.close) && finite(b.volume) && b.volume >= 0);
}

// ---------------------------------------------------------------------------
// 2.1 Up/down volume ratio
// ---------------------------------------------------------------------------

/**
 * Volume on advancing days divided by volume on declining days.
 *
 * Needs `window + 1` bars, because each day is classified by comparing its
 * close to the PREVIOUS close — a 50-day window is 50 comparisons, which spans
 * 51 bars.
 *
 * Unchanged days are excluded from both sides rather than counted as either. A
 * flat day on enormous volume says nothing about direction, and folding it in
 * would let a single halt-and-resume distort the ratio.
 *
 * Returns null when down volume is zero. Infinity is not a ratio, and a name
 * that simply never declined would otherwise rank above everything real.
 */
export function upDownVolumeRatio(
  bars: readonly VolumeBar[],
  window: number = VOLUME_WINDOW,
): number | null {
  if (window <= 0 || bars.length < window + 1) return null;

  const slice = bars.slice(bars.length - (window + 1));
  if (!usable(slice)) return null;

  let up = 0;
  let down = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i].close - slice[i - 1].close;
    if (diff > 0) up += slice[i].volume;
    else if (diff < 0) down += slice[i].volume;
  }

  if (down <= 0) return null;
  return up / down;
}

// ---------------------------------------------------------------------------
// 2.3 On-balance volume
// ---------------------------------------------------------------------------

/** Running OBV, starting at zero on the first bar. */
export function obvSeries(bars: readonly VolumeBar[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const diff = bars[i].close - bars[i - 1].close;
      if (diff > 0) running += bars[i].volume;
      else if (diff < 0) running -= bars[i].volume;
    }
    out.push(running);
  }
  return out;
}

/** Least-squares slope of `ys` against its index. */
function leastSquaresSlope(ys: readonly number[]): number | null {
  const n = ys.length;
  if (n < 2) return null;

  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (const y of ys) meanY += y;
  meanY /= n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? null : num / den;
}

/**
 * OBV slope normalised by mean volume over the same window.
 *
 * Raw OBV levels are meaningless across tickers: they scale with float, so an
 * unnormalised slope would rank megacaps above everything regardless of trend.
 * Dividing by mean volume makes the number comparable — it reads as "net
 * accumulation per day, in units of a typical day's volume".
 */
export function obvSlope(
  bars: readonly VolumeBar[],
  window: number = VOLUME_WINDOW,
): number | null {
  if (window <= 1 || bars.length < window) return null;

  const slice = bars.slice(bars.length - window);
  if (!usable(slice)) return null;

  // OBV is a running total, so it must be built from the full history to date
  // and only then windowed; rebasing at the window start would be arbitrary.
  const full = obvSeries(bars);
  const ys = full.slice(full.length - window);

  const slope = leastSquaresSlope(ys);
  if (slope == null) return null;

  let meanVol = 0;
  for (const b of slice) meanVol += b.volume;
  meanVol /= window;
  if (meanVol <= 0) return null;

  return slope / meanVol;
}

// ---------------------------------------------------------------------------
// 2.4 Relative volume
// ---------------------------------------------------------------------------

/**
 * Today's volume against the mean of the preceding window.
 *
 * Today is deliberately excluded from its own baseline. Including it damps
 * exactly the spike the metric exists to detect — a 50x day would read as 25x.
 */
export function relativeVolume(
  bars: readonly VolumeBar[],
  window: number = VOLUME_WINDOW,
): number | null {
  if (window <= 0 || bars.length < window + 1) return null;

  const today = bars[bars.length - 1];
  const prior = bars.slice(bars.length - (window + 1), bars.length - 1);
  if (!finite(today.volume) || !usable(prior)) return null;

  let mean = 0;
  for (const b of prior) mean += b.volume;
  mean /= window;
  if (mean <= 0) return null;

  return today.volume / mean;
}

// ---------------------------------------------------------------------------
// 2.2 Accumulation grade
// ---------------------------------------------------------------------------

/**
 * Band a universe-wide percentile into an IBD-style letter.
 *
 * The percentile must be computed against the FULL liquid universe, not the
 * theme, for the same reason rsPct is: a grade relative to 103 AI names would
 * mean something entirely different from one relative to 2,162.
 */
export function accumulationGrade(percentile: number | null): AccumulationGrade | null {
  if (percentile == null || !finite(percentile)) return null;
  if (percentile >= 80) return "A";
  if (percentile >= 60) return "B";
  if (percentile >= 40) return "C";
  if (percentile >= 20) return "D";
  return "E";
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** All three series metrics in one pass over a ticker's bars. */
export function volumeProfile(
  bars: readonly VolumeBar[],
  window: number = VOLUME_WINDOW,
): VolumeProfile {
  return {
    udRatio: upDownVolumeRatio(bars, window),
    obvSlope: obvSlope(bars, window),
    rvol: relativeVolume(bars, window),
    window,
  };
}

/**
 * 2.5 Volume-weighted confirmation.
 *
 * A buy-side name is confirmed when volume agrees with the price move. An
 * UNconfirmed Strong Buy is the interesting case: a name rising on weak volume,
 * which is precisely the setup the strategy's own logic says to trim.
 *
 * Unmeasured inputs yield false, never true. Absence of evidence must not read
 * as confirmation.
 */
export function isConfirmed(
  udRatio: number | null,
  slope: number | null,
  tier: Tier | null,
): boolean {
  if (udRatio == null || slope == null) return false;
  if (tier !== "Strong Buy" && tier !== "Buy") return false;
  return udRatio > 1 && slope > 0;
}
