/** Structural shapes shared by the db layer, kept free of runtime imports. */

export interface PolygonBar {
  readonly T: string;
  /** Open price. Present on grouped-daily rows; absent on older cached shapes. */
  readonly o?: number;
  /** Intraday high and low, for the 52-week range in the trend template. */
  readonly h?: number;
  readonly l?: number;
  readonly c: number;
  readonly v?: number;
  readonly vw?: number;
}

export interface TickerRefLike {
  readonly ticker: string;
  readonly name: string;
  readonly primaryExchange: string | null;
  readonly cik: string | null;
  readonly active: boolean;
  readonly delistedUtc: string | null;
}
