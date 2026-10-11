/** One daily bar, oldest-first arrays of these feed every indicator. */
export interface Bar {
  readonly session: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
