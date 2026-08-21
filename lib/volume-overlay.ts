/**
 * Attach volume metrics to ranked rows, grading against the FULL universe.
 *
 * Kept separate from lib/volume.ts so the maths stays pure and this file owns
 * the one thing that is not local to a single ticker: the accumulation grade is
 * a percentile across every liquid name, exactly as rsPct is. Ranking within
 * the theme would make an "A" mean something entirely different.
 */

import { percentileRanks } from "./factors";
import {
  VOLUME_WINDOW,
  accumulationGrade,
  isConfirmed,
  volumeProfile,
  type AccumulationGrade,
  type VolumeBar,
  type VolumeProfile,
} from "./volume";
import type { ScreenRow } from "./types";

export interface VolumeFields {
  readonly volume: VolumeProfile;
  /** Percentile of udRatio across the full liquid universe. */
  readonly accumulationPct: number | null;
  readonly accumulation: AccumulationGrade | null;
  /** Volume agrees with the price move, in a buy-side tier. */
  readonly confirmed: boolean;
}

const EMPTY: VolumeProfile = {
  udRatio: null,
  obvSlope: null,
  rvol: null,
  window: VOLUME_WINDOW,
};

/**
 * @param ranked  every liquid name, so percentiles span the real universe
 * @param themed  the subset actually rendered
 * @param history ticker -> bars, oldest first
 */
export function applyVolume<T extends ScreenRow>(
  ranked: readonly ScreenRow[],
  themed: readonly T[],
  history: ReadonlyMap<string, readonly VolumeBar[]>,
  window: number = VOLUME_WINDOW,
): (T & VolumeFields)[] {
  // Profile the whole universe first: the grade is only meaningful relative to
  // everything, so it cannot be computed from the themed subset alone.
  const profiles = new Map<string, VolumeProfile>();
  for (const r of ranked) {
    profiles.set(r.ticker, volumeProfile(history.get(r.ticker) ?? [], window));
  }

  // Rank only the names that actually produced a ratio. Treating a missing
  // ratio as zero would drag real names up the percentile scale.
  const measured = ranked
    .map((r) => ({ ticker: r.ticker, v: profiles.get(r.ticker)?.udRatio ?? null }))
    .filter((x): x is { ticker: string; v: number } => x.v != null);

  const pcts = percentileRanks(measured.map((m) => m.v));
  const pctByTicker = new Map<string, number>();
  measured.forEach((m, i) => pctByTicker.set(m.ticker, pcts[i]));

  return themed.map((r) => {
    const profile = profiles.get(r.ticker) ?? EMPTY;
    const pct = pctByTicker.get(r.ticker) ?? null;
    return {
      ...r,
      volume: profile,
      accumulationPct: pct,
      accumulation: accumulationGrade(pct),
      confirmed: isConfirmed(profile.udRatio, profile.obvSlope, r.tier),
    };
  });
}

/** How many rows carry a real up/down ratio, for reporting. */
export function volumeMeasuredCount(rows: readonly VolumeFields[]): number {
  return rows.filter((r) => r.volume.udRatio != null).length;
}
