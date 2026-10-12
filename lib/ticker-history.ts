/**
 * Shaping one ticker's aggregates for replaceTickerBars, shared by the split
 * repair and the history fill so the two write identical rows.
 */

/** A raw per-ticker aggregate: `t` is the bar's start, epoch ms. */
export interface RawAggregate {
  readonly t: number;
  readonly o?: number;
  readonly h?: number;
  readonly l?: number;
  readonly c: number;
  readonly v?: number;
  readonly vw?: number;
}

export interface SessionBar {
  readonly session: string;
  readonly o?: number;
  readonly h?: number;
  readonly l?: number;
  readonly c: number;
  readonly v?: number;
  readonly vw?: number;
}

/**
 * Key each bar by its trading date. Polygon stamps daily bars at midnight New
 * York time, which is 04:00 or 05:00 UTC on the same date, so the UTC date is
 * the session.
 */
export function toSessionBars(bars: readonly RawAggregate[]): SessionBar[] {
  return bars.map((b) => ({
    session: new Date(b.t).toISOString().slice(0, 10),
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
    vw: b.vw,
  }));
}
