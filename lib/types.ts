/**
 * Shared types for the AI Revolution screener.
 *
 * Ported from screener.py. Keep the two in sync: screener.py --selftest and
 * `npm test` cover the same cases with the same expected values.
 */

/** Position-size buckets. Ordered strongest to weakest. */
export type Tier = "Strong Buy" | "Buy" | "Hold";

export const TIERS: readonly Tier[] = ["Strong Buy", "Buy", "Hold"] as const;

/** Return-anchor labels. Each maps to a trading-day lookback. */
export type AnchorLabel = "r1m" | "r3m" | "r6m" | "r12m";

export const ANCHORS: readonly AnchorLabel[] = ["r1m", "r3m", "r6m", "r12m"] as const;

/** Anchors that must be present for a name to be scoreable. */
export const REQUIRED_ANCHORS: readonly AnchorLabel[] = ["r3m", "r6m", "r12m"] as const;

/**
 * One daily bar. Field names mirror the Polygon grouped-daily response so raw
 * API rows can be mapped with minimal ceremony.
 */
export interface Bar {
  /** Ticker. Polygon returns this as `T`. */
  readonly ticker: string;
  /** Close. Polygon `c`. */
  readonly close: number;
  /** Volume. Polygon `v`. */
  readonly volume: number;
  /** Volume-weighted average price. Polygon `vw`. */
  readonly vwap: number;
}

/** Grouped-daily response reshaped as a lookup. */
export type BarsByTicker = ReadonlyMap<string, Bar>;

/**
 * Price snapshots keyed by anchor. `now` is required; the rest are the
 * historical anchors and may be absent for names that were not yet listed.
 */
export interface Snapshots {
  readonly now: BarsByTicker;
  readonly r1m?: BarsByTicker;
  readonly r3m?: BarsByTicker;
  readonly r6m?: BarsByTicker;
  readonly r12m?: BarsByTicker;
}

/** Decoded strategy constants. See STRATEGY_DECODED.md section 5. */
export interface Params {
  // Liquidity gate
  readonly minPrice: number;
  readonly minDollarVolume: number;

  // Relative-strength blend. Weights should sum to 1.
  readonly wR3m: number;
  readonly wR6m: number;
  readonly wR12m: number;

  // Tier cutoffs, as RS percentile against the ranked universe.
  readonly strongRs: number;
  readonly buyRs: number;

  // Trend gate. Price relative to the moving-average proxy, in percent.
  readonly strongTrend: number;
  readonly buyTrend: number;

  // Tier weights as a fraction of the sleeve.
  readonly wStrong: number;
  readonly wBuy: number;
  readonly wHold: number;

  // Target position counts per tier.
  readonly nStrong: number;
  readonly nBuy: number;
  readonly nHold: number;

  // Trading-day offsets used as return anchors.
  readonly lookbacks: Readonly<Record<AnchorLabel, number>>;
}

/** A scored candidate. Nullable fields are unset until scoring completes. */
export interface ScreenRow {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly price: number;
  readonly dollarVolume: number;
  readonly r1m: number | null;
  readonly r3m: number;
  readonly r6m: number;
  readonly r12m: number;
  readonly maProxy: number;
  readonly vsMa: number;
  readonly rsRaw: number;
  /** Percentile 0-100 against the ranked universe. Null before ranking. */
  readonly rsPct: number | null;
  readonly tier: Tier | null;
  readonly weight: number;
}
