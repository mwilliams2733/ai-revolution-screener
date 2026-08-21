/**
 * Attach the trend template and Weinstein stage to ranked rows.
 *
 * Both are per-ticker and need no universe-wide context, so this file only
 * threads history in and results out. The template consumes rsPct for
 * criterion 8, which is why it runs after ranking rather than before.
 */

import {
  TREND_MIN_HISTORY,
  trendTemplate,
  weinsteinStage,
  type StageReport,
  type TrendBar,
  type TrendTemplate,
} from "./trend-template";
import type { ScreenRow } from "./types";

export interface TrendFields {
  /** Null when history is too short. Never a partial score. */
  readonly trend: TrendTemplate | null;
  readonly stage: StageReport | null;
}

export function applyTrend<T extends ScreenRow>(
  rows: readonly T[],
  history: ReadonlyMap<string, readonly TrendBar[]>,
): (T & TrendFields)[] {
  return rows.map((r) => {
    const bars = history.get(r.ticker) ?? [];
    return {
      ...r,
      trend: trendTemplate(bars, r.rsPct),
      stage: weinsteinStage(bars),
    };
  });
}

/** How many rows carry a full template, for reporting. */
export function trendScoredCount(rows: readonly TrendFields[]): number {
  return rows.filter((r) => r.trend != null).length;
}

export { TREND_MIN_HISTORY };
