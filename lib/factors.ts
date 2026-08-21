/**
 * Factor math for the AI Revolution screener.
 *
 * Every function here is pure and network-free, so this module is fully
 * unit-testable. Ported from screener.py; the test suite mirrors
 * `python screener.py --selftest`.
 */

import {
  ANCHORS,
  REQUIRED_ANCHORS,
  type AnchorLabel,
  type Bar,
  type BarsByTicker,
  type Params,
  type ScreenRow,
  type Snapshots,
} from "./types";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Percent change from `then` to `now`.
 * Returns null when either side is missing or non-positive, which is how
 * splits-gone-wrong and pre-listing zeros get filtered out.
 */
export function pctChange(now: number | null | undefined, then: number | null | undefined): number | null {
  if (now == null || then == null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  if (now <= 0 || then <= 0) return null;
  return 100 * (now / then - 1);
}

/** IBD-style weighted relative strength blend. */
export function rsScore(r3m: number, r6m: number, r12m: number, p: Params): number {
  return p.wR3m * r3m + p.wR6m * r6m + p.wR12m * r12m;
}

/**
 * Percentile rank, 0-100, higher input value gets a higher percentile.
 * Tied values share the average of their ranks.
 *
 * Single-element input returns [100]; an empty array returns [].
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].v === order[i].v) j += 1;
    // Average 0-based rank across the tie group.
    const avgRank = (i + j) / 2;
    const pct = (100 * avgRank) / (n - 1);
    for (let k = i; k <= j; k += 1) out[order[k].i] = pct;
    i = j + 1;
  }
  return out;
}

/**
 * Moving-average proxy: the mean of the current price and every available
 * historical anchor.
 *
 * This is a deliberate approximation of a 200-day MA using five sampled points
 * rather than 200 daily bars, which keeps the whole screen inside a handful of
 * grouped-daily API calls. Validated against true 200d MAs on the 19 portfolio
 * names; the sign and ordering agree, magnitudes run slightly tighter.
 */
export function computeMaProxy(price: number, anchors: ReadonlyMap<AnchorLabel, number>): number {
  const pts = [price, ...anchors.values()].filter((v) => Number.isFinite(v) && v > 0);
  if (pts.length === 0) return 0;
  return pts.reduce((a, b) => a + b, 0) / pts.length;
}

/** Dollar volume for a bar. Falls back to close when vwap is absent. */
export function dollarVolume(bar: Bar): number {
  const px = Number.isFinite(bar.vwap) && bar.vwap > 0 ? bar.vwap : bar.close;
  return bar.volume * px;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/** Raw Polygon grouped-daily row. */
export interface PolygonBar {
  readonly T: string;
  readonly c: number;
  readonly v: number;
  readonly vw?: number;
}

/** Reshape a Polygon grouped-daily payload into a lookup. */
export function barsByTicker(results: readonly PolygonBar[]): BarsByTicker {
  const m = new Map<string, Bar>();
  for (const r of results) {
    if (!r?.T || !Number.isFinite(r.c)) continue;
    m.set(r.T, { ticker: r.T, close: r.c, volume: r.v ?? 0, vwap: r.vw ?? r.c });
  }
  return m;
}

/**
 * Score every candidate that clears the liquidity gate and has the required
 * return anchors. Rows come back unranked: rsPct, tier and weight are unset.
 *
 * @param snapshots price snapshots keyed by anchor; `now` is required
 * @param universe  ticker -> sector, already theme-filtered by the caller
 * @param names     ticker -> company name, for display only
 */
export function computeRows(
  snapshots: Snapshots,
  universe: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, string>,
  p: Params,
): ScreenRow[] {
  const rows: ScreenRow[] = [];

  for (const [ticker, sector] of universe) {
    const bar = snapshots.now.get(ticker);
    if (!bar) continue;

    const price = bar.close;
    const dv = dollarVolume(bar);
    if (price < p.minPrice || dv < p.minDollarVolume) continue;

    // Gather whichever anchors exist for this name.
    const anchorPx = new Map<AnchorLabel, number>();
    for (const label of ANCHORS) {
      const snap = snapshots[label];
      const b = snap?.get(ticker);
      if (b && Number.isFinite(b.close) && b.close > 0) anchorPx.set(label, b.close);
    }
    if (!REQUIRED_ANCHORS.every((l) => anchorPx.has(l))) continue;

    const r3m = pctChange(price, anchorPx.get("r3m"));
    const r6m = pctChange(price, anchorPx.get("r6m"));
    const r12m = pctChange(price, anchorPx.get("r12m"));
    if (r3m == null || r6m == null || r12m == null) continue;

    const maProxy = computeMaProxy(price, anchorPx);
    const vsMa = pctChange(price, maProxy);
    if (vsMa == null) continue;

    rows.push({
      ticker,
      name: names.get(ticker) ?? "",
      sector,
      price,
      dollarVolume: dv,
      r1m: pctChange(price, anchorPx.get("r1m")),
      r3m,
      r6m,
      r12m,
      maProxy,
      vsMa,
      rsRaw: rsScore(r3m, r6m, r12m, p),
      rsPct: null,
      tier: null,
      weight: 0,
    });
  }

  return rows;
}

/**
 * Attach RS percentiles and sort strongest first.
 *
 * Rank against the FULL liquid universe before filtering to a theme. Ranking
 * inside the theme changes what the percentile means and invalidates the tier
 * cutoffs in DEFAULT_PARAMS.
 */
export function rankRows(rows: readonly ScreenRow[]): ScreenRow[] {
  const pcts = percentileRanks(rows.map((r) => r.rsRaw));
  return rows
    .map((r, i) => ({ ...r, rsPct: pcts[i] }))
    .sort((a, b) => b.rsRaw - a.rsRaw);
}
