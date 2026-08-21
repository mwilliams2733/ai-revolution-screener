import type { Params } from "./types";

/**
 * Decoded strategy defaults.
 *
 * Every value here was derived from the delivered AI Revolution Portfolio and
 * its position-size calculator. See STRATEGY_DECODED.md for the evidence behind
 * each one. Tier weights reproduce the published 52/35/13 split exactly:
 *   7 x 7.43% = 52.01%,  7 x 5.00% = 35.00%,  5 x 2.60% = 13.00%
 */
export const DEFAULT_PARAMS: Params = {
  minPrice: 5.0,
  minDollarVolume: 10_000_000,

  wR3m: 0.4,
  wR6m: 0.3,
  wR12m: 0.3,

  strongRs: 80.0,
  buyRs: 55.0,

  strongTrend: 0.0,
  buyTrend: 0.0,

  wStrong: 0.0743,
  wBuy: 0.05,
  wHold: 0.026,

  nStrong: 7,
  nBuy: 7,
  nHold: 5,

  lookbacks: { r1m: 21, r3m: 63, r6m: 126, r12m: 252 },
};

/** Build a params object with selective overrides. */
export function withParams(overrides: Partial<Params> = {}): Params {
  return { ...DEFAULT_PARAMS, ...overrides };
}
