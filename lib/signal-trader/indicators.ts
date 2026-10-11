/**
 * The signal lab's indicators, ported from research/signal-lab/
 * find_best_signal.py (rsi, atr_pct, add_features: lines 122-162).
 *
 * pandas' defaults are reproduced exactly, because the cutoffs the app trades
 * on were fit by pandas: a rolling window is NaN until it holds `w` non-NaN
 * values (min_periods = window), standard deviations are sample (ddof = 1),
 * and EWMs use adjust=False. golden.json is the arbiter (indicators.test.ts).
 *
 * The value at index i depends on bars[0..i] only, so computing over the whole
 * history and reading index i carries no look-ahead.
 */
import type { Bar } from "./types";

export const CONTINUOUS = [
  "mom_20", "mom_60", "ma_cross", "rsi_14", "macd_hist", "bb_pctb", "atr_pct",
  "vol_z", "ret_5", "gap", "intraday", "dist_20d_high", "dist_52w_high", "dist_52w_low",
] as const;
export type Continuous = (typeof CONTINUOUS)[number];

export const BINARY = ["vol_spike", "gap_big", "breakout_vol"] as const;
export type Binary = (typeof BINARY)[number];

export interface Features {
  readonly continuous: Readonly<Record<Continuous, Float64Array>>;
  readonly binary: Readonly<Record<Binary, readonly boolean[]>>;
}

const NAN = Number.NaN;

function series(n: number, f: (i: number) => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}

function shift(x: Float64Array, k: number): Float64Array {
  return series(x.length, (i) => (i - k >= 0 ? x[i - k] : NAN));
}

/** pandas rolling(w) with min_periods = w: NaN unless all w values exist. */
function rolling(x: Float64Array, w: number, agg: (win: Float64Array) => number): Float64Array {
  return series(x.length, (i) => {
    if (i < w - 1) return NAN;
    const win = x.subarray(i - w + 1, i + 1);
    for (const v of win) if (Number.isNaN(v)) return NAN;
    return agg(win);
  });
}

function mean(win: Float64Array): number {
  let s = 0;
  for (const v of win) s += v;
  return s / win.length;
}

function std(win: Float64Array): number {
  const m = mean(win);
  let ss = 0;
  for (const v of win) ss += (v - m) ** 2;
  return Math.sqrt(ss / (win.length - 1));
}

function max(win: Float64Array): number {
  let m = -Infinity;
  for (const v of win) if (v > m) m = v;
  return m;
}

function min(win: Float64Array): number {
  let m = Infinity;
  for (const v of win) if (v < m) m = v;
  return m;
}

/**
 * pandas ewm(alpha, adjust=False, min_periods).mean() for a series whose only
 * NaNs are leading: y starts at the first value, then y = (1 - a)·y + a·x.
 */
function ewm(x: Float64Array, alpha: number, minPeriods = 1): Float64Array {
  const out = new Float64Array(x.length).fill(NAN);
  let y = NAN;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isNaN(v)) {
      y = count === 0 ? v : (1 - alpha) * y + alpha * v;
      count++;
    }
    if (count >= Math.max(minPeriods, 1)) out[i] = y;
  }
  return out;
}

/** The lab's `.replace(0, np.nan)` before dividing. */
const nonZero = (x: number) => (x === 0 ? NAN : x);

export function addFeatures(bars: readonly Bar[]): Features {
  const n = bars.length;
  const c = series(n, (i) => bars[i].close);
  const o = series(n, (i) => bars[i].open);
  const h = series(n, (i) => bars[i].high);
  const l = series(n, (i) => bars[i].low);
  const v = series(n, (i) => bars[i].volume);
  const c1 = shift(c, 1);
  const ratio = (a: Float64Array, b: Float64Array) => series(n, (i) => a[i] / b[i] - 1);

  // RSI, Wilder smoothing via ewm(alpha = 1/14, min_periods = 14).
  const d = series(n, (i) => (i === 0 ? NAN : c[i] - c[i - 1]));
  const up = series(n, (i) => (Number.isNaN(d[i]) ? NAN : Math.max(d[i], 0)));
  const down = series(n, (i) => (Number.isNaN(d[i]) ? NAN : -Math.min(d[i], 0)));
  const ag = ewm(up, 1 / 14, 14);
  const al = ewm(down, 1 / 14, 14);

  // MACD: span s means alpha = 2 / (s + 1); no min_periods.
  const ema12 = ewm(c, 2 / 13);
  const ema26 = ewm(c, 2 / 27);
  const macd = series(n, (i) => ema12[i] - ema26[i]);
  const macdSignal = ewm(macd, 2 / 10);

  const mid = rolling(c, 20, mean);
  const sd = rolling(c, 20, std);

  // True range: pandas' row max skips the NaN previous close on the first bar.
  const tr = series(n, (i) =>
    i === 0
      ? h[i] - l[i]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])),
  );
  const atr = ewm(tr, 1 / 14, 14);

  const vMean = rolling(v, 20, mean);
  const vStd = rolling(v, 20, std);

  const continuous: Record<Continuous, Float64Array> = {
    mom_20: ratio(c, shift(c, 20)),
    mom_60: ratio(c, shift(c, 60)),
    ma_cross: ratio(rolling(c, 20, mean), rolling(c, 50, mean)),
    rsi_14: series(n, (i) => 100 - 100 / (1 + ag[i] / nonZero(al[i]))),
    macd_hist: series(n, (i) => (macd[i] - macdSignal[i]) / c[i]),
    bb_pctb: series(n, (i) => (c[i] - (mid[i] - 2 * sd[i])) / (4 * nonZero(sd[i]))),
    atr_pct: series(n, (i) => atr[i] / c[i]),
    vol_z: series(n, (i) => (v[i] - vMean[i]) / nonZero(vStd[i])),
    ret_5: ratio(c, shift(c, 5)),
    gap: ratio(o, c1),
    intraday: ratio(c, o),
    dist_20d_high: ratio(c, rolling(c1, 20, max)),
    dist_52w_high: ratio(c, rolling(c1, 252, max)),
    dist_52w_low: ratio(c, rolling(c1, 252, min)),
  };

  // NaN comparisons are false in JS exactly as in pandas.
  const binary: Record<Binary, boolean[]> = {
    vol_spike: Array.from({ length: n }, (_, i) => continuous.vol_z[i] > 2.0),
    gap_big: Array.from(
      { length: n },
      (_, i) => Math.abs(continuous.gap[i]) > 1.5 * continuous.atr_pct[i],
    ),
    breakout_vol: Array.from(
      { length: n },
      (_, i) => continuous.dist_20d_high[i] >= -0.002 && continuous.vol_z[i] > 1.0,
    ),
  };

  return { continuous, binary };
}
