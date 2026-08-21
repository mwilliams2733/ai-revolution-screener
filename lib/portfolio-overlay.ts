/**
 * Portfolio-level risk over the selected book.
 *
 * Operates on holdings rather than candidates. The interesting output is the
 * GAP between effN_w and effN_c: a 19-name book with effN_w near 17 and effN_c
 * near 5 is telling you something the position count never will.
 */

import {
  CORRELATION_WINDOW,
  correlationMatrix,
  effectiveBetsCorrelation,
  effectiveBetsWeight,
  meanPairwiseCorrelation,
  sectorConcentration,
  topCorrelatedPairs,
  type Concentration,
  type CorrelatedPair,
} from "./portfolio-risk";
import type { ScreenRow } from "./types";

export interface PortfolioRisk {
  readonly holdings: number;
  /** Mean off-diagonal correlation. Null without enough history. */
  readonly meanCorrelation: number | null;
  /** Concentration-only effective bets: 1 / HHI. */
  readonly effectiveBetsWeight: number | null;
  /** Correlation-adjusted effective bets. The honest figure. */
  readonly effectiveBetsCorrelation: number | null;
  readonly topPairs: readonly CorrelatedPair[];
  readonly sectors: Concentration;
  readonly correlationWindow: number;
}

/**
 * @param rows    the selected book
 * @param history ticker -> closes, oldest first
 */
export function portfolioRisk(
  rows: readonly ScreenRow[],
  history: ReadonlyMap<string, readonly number[]>,
  window: number = CORRELATION_WINDOW,
): PortfolioRisk {
  const tickers = rows.map((r) => r.ticker);
  const weights = rows.map((r) => r.weight);
  const sectors = sectorConcentration(rows.map((r) => ({ sector: r.sector, weight: r.weight })));

  // Weight concentration needs no price history, so it is reported even when
  // correlation cannot be. Half an answer beats none, as long as the missing
  // half reads as missing.
  const base: PortfolioRisk = {
    holdings: rows.length,
    meanCorrelation: null,
    effectiveBetsWeight: effectiveBetsWeight(weights),
    effectiveBetsCorrelation: null,
    topPairs: [],
    sectors,
    correlationWindow: window,
  };

  const matrix = correlationMatrix(tickers, history, window);
  if (matrix == null) return base;

  return {
    ...base,
    meanCorrelation: meanPairwiseCorrelation(matrix),
    effectiveBetsCorrelation: effectiveBetsCorrelation(weights, matrix),
    topPairs: topCorrelatedPairs(tickers, matrix, 5),
  };
}
