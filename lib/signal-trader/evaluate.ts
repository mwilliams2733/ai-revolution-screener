/**
 * The lab's evaluation (find_best_signal.py main(), lines 274-332), ported for
 * quarterly re-validation and the tab's Lab section: forward returns per
 * ticker; drop the rows the longest horizon cannot score; chronological 70/30
 * split PER TICKER by row count; decile cutoffs on the pooled train set;
 * occurrences de-duplicated per ticker (spacing = horizon).
 *
 * Plus what the lab does not report, and what its headline overstates:
 * same-day firings across tickers are one observation (clustered t-stat over
 * dates), and overlapping windows across tickers are one episode.
 */
import { addFeatures, CONTINUOUS, type Features } from "./indicators";
import { fires, type Cutoffs, type Rule } from "./signals";
import type { Bar } from "./types";

export interface Row {
  readonly ticker: string;
  readonly session: string;
  /** Index into the ticker's features. */
  readonly i: number;
  readonly fwd: Readonly<Record<number, number>>;
}

export interface Panel {
  readonly rows: Row[];
  readonly features: Map<string, Features>;
}

export function buildPanel(
  bars: ReadonlyMap<string, readonly Bar[]>,
  horizons: readonly number[],
): Panel {
  const maxH = Math.max(...horizons);
  const rows: Row[] = [];
  const features = new Map<string, Features>();
  for (const ticker of [...bars.keys()].sort()) {
    const b = bars.get(ticker) as readonly Bar[];
    const f = addFeatures(b);
    features.set(ticker, f);
    for (let i = 0; i + maxH < b.length; i++) {
      const fwd: Record<number, number> = {};
      for (const H of horizons) fwd[H] = b[i + H].close / b[i].close - 1;
      rows.push({ ticker, session: b[i].session, i, fwd });
    }
  }
  return { rows, features };
}

export function splitPanel(panel: Panel, trainFrac = 0.7): { train: Row[]; test: Row[] } {
  const train: Row[] = [];
  const test: Row[] = [];
  const byTicker = new Map<string, Row[]>();
  for (const r of panel.rows) {
    const list = byTicker.get(r.ticker);
    if (list) list.push(r);
    else byTicker.set(r.ticker, [r]);
  }
  for (const list of byTicker.values()) {
    const cut = Math.floor(list.length * trainFrac);
    list.forEach((r, k) => (k < cut ? train : test).push(r));
  }
  return { train, test };
}

/** pandas' default (linear) quantile. */
export function quantile(xs: number[], q: number): number {
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  return lo + 1 < a.length ? a[lo] + (a[lo + 1] - a[lo]) * (pos - lo) : a[lo];
}

export function fitCutoffs(train: Row[], features: Map<string, Features>): Cutoffs {
  const out = {} as Record<(typeof CONTINUOUS)[number], { lo: number; hi: number }>;
  for (const col of CONTINUOUS) {
    const xs = train
      .map((r) => (features.get(r.ticker) as Features).continuous[col][r.i])
      .filter((x) => !Number.isNaN(x));
    out[col] = { lo: quantile(xs, 0.1), hi: quantile(xs, 0.9) };
  }
  return out;
}

/** The lab's dedupe_mask: keep occurrences >= spacing rows apart per ticker. */
export function dedupe(rows: Row[], mask: boolean[], spacing: number): boolean[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  const last = new Map<string, number>();
  for (let k = 0; k < rows.length; k++) {
    if (!mask[k]) continue;
    const prev = last.get(rows[k].ticker);
    if (prev === undefined || k - prev >= spacing) {
      keep[k] = true;
      last.set(rows[k].ticker, k);
    }
  }
  return keep;
}

export interface Stats {
  readonly n: number;
  readonly mean: number;
  readonly hit: number;
  readonly t: number;
}

export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (n === 0) return { n, mean: Number.NaN, hit: Number.NaN, t: Number.NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const hit = xs.filter((x) => x > 0).length / n;
  if (n < 2) return { n, mean, hit, t: 0 };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, hit, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

export function ruleFirings(
  rows: Row[],
  features: Map<string, Features>,
  rule: Rule,
  cutoffs: Cutoffs,
  H: number,
): Row[] {
  const mask = rows.map((r) => fires(rule, features.get(r.ticker) as Features, r.i, cutoffs));
  const keep = dedupe(rows, mask, H);
  return rows.filter((_, k) => keep[k]);
}

export interface Clustered {
  /** Distinct firing dates. */
  readonly dates: number;
  /** Non-overlapping H-session windows across ALL tickers that contain a firing. */
  readonly episodes: number;
  /** t-stat with each date's mean counted once. */
  readonly tDates: number;
}

export function clustered(firings: Row[], H: number, calendar: readonly string[]): Clustered {
  const byDate = new Map<string, number[]>();
  for (const r of firings) {
    const list = byDate.get(r.session);
    if (list) list.push(r.fwd[H]);
    else byDate.set(r.session, [r.fwd[H]]);
  }
  const dateMeans = [...byDate.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const pos = new Map(calendar.map((d, k) => [d, k]));
  let episodes = 0;
  let windowEnd = -Infinity;
  for (const d of [...byDate.keys()].sort()) {
    const k = pos.get(d) ?? -1;
    if (k >= windowEnd) {
      episodes++;
      windowEnd = k + H;
    }
  }
  return { dates: byDate.size, episodes, tDates: stats(dateMeans).t };
}

/** Peter Acklam's inverse normal CDF; error < 1.2e-9 over (0, 1). */
function invNorm(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -invNorm(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Two-sided critical z for a family-wise alpha spread over nTests. */
export function bonferroniT(nTests: number, alpha = 0.05): number {
  return invNorm(1 - alpha / (2 * Math.max(nTests, 1)));
}

/** Mean of (firing return − benchmark return over the same window); null without benchmark data. */
export function excessMean(
  firings: Row[],
  benchmark: ReadonlyMap<string, Readonly<Record<number, number>>>,
  H: number,
): number | null {
  const xs = firings
    .map((r) => {
      const b = benchmark.get(r.session)?.[H];
      return b === undefined ? null : r.fwd[H] - b;
    })
    .filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Rows strictly after `session`. The shipped cutoffs were fit on the lab's
 * training rows (through cutoffs.json `train_end`); scoring sessions inside
 * that period re-measures the fit, not the signal.
 */
export function rowsAfter(rows: Row[], session: string): Row[] {
  return rows.filter((r) => r.session > session);
}
