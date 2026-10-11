/**
 * Live grading with honest sample sizes.
 *
 * The lab's 162 volume-spike trades were 34 independent episodes: the twelve
 * tickers move together, so overlapping windows across tickers are one bet.
 * Every interval and warning here counts EPISODES, not picks.
 */
import { SIGNAL_NAMES, ST_CONFIG, type SignalName, type StConfig } from "./config";
import type { Grade } from "./engine";

export interface Interval { readonly lo: number; readonly hi: number }

const T975 = [Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064,
  2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** Two-sided 95% t critical value; normal beyond df 30. */
export function tCrit(df: number): number {
  if (df < 1) return Number.NaN;
  return df <= 30 ? T975[df] : 1.96;
}

export function meanCi(xs: number[]): { mean: number; ci: Interval | null } {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : Number.NaN;
  if (n < 2) return { mean, ci: null };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = tCrit(n - 1) * (sd / Math.sqrt(n));
  return { mean, ci: { lo: mean - half, hi: mean + half } };
}

/** Group grades whose holding windows overlap (any ticker) into episodes. */
export function episodesOf(rows: readonly Grade[], indexOf: (s: string) => number): Grade[][] {
  const sorted = [...rows].sort((a, b) => indexOf(a.entrySession) - indexOf(b.entrySession));
  const out: Grade[][] = [];
  let end = -Infinity;
  for (const r of sorted) {
    if (indexOf(r.entrySession) > end) out.push([r]);
    else out[out.length - 1].push(r);
    end = Math.max(end, indexOf(r.exitSession));
  }
  return out;
}

export interface SignalScore {
  readonly signal: SignalName;
  readonly label: string;
  readonly picks: number;
  readonly episodes: number;
  readonly hitRate: number | null;
  readonly labHit: number;
  readonly meanRaw: number | null;
  readonly ciRaw: Interval | null;
  readonly meanExcess: number | null;
  readonly ciExcess: Interval | null;
  readonly expectedMove: number;
  readonly pnl: number;
  readonly smallSample: boolean;
  /** Sessions until min_episodes at the observed episode rate; null with no history. */
  readonly sessionsTo30: number | null;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function scoreSignals(
  rows: readonly Grade[],
  indexOf: (s: string) => number,
  nowIndex: number,
  cfg: StConfig = ST_CONFIG,
): SignalScore[] {
  const need = cfg.grading.min_episodes;
  return SIGNAL_NAMES.map((signal) => {
    const spec = cfg.signals[signal];
    const rs = rows.filter((r) => r.signal === signal);
    const eps = episodesOf(rs, indexOf);
    const raw = meanCi(eps.map((e) => avg(e.map((r) => r.realizedReturn))));
    const excessEps = eps
      .map((e) => e.filter((r) => r.excessReturn !== null).map((r) => r.excessReturn as number))
      .filter((xs) => xs.length > 0)
      .map(avg);
    const excess = meanCi(excessEps);
    let sessionsTo30: number | null = null;
    if (eps.length >= need) sessionsTo30 = 0;
    else if (eps.length > 0) {
      const span = nowIndex - indexOf(eps[0][0].entrySession) + 1;
      sessionsTo30 = span > 0 ? (need - eps.length) / (eps.length / span) : null;
    }
    return {
      signal,
      label: spec.label,
      picks: rs.length,
      episodes: eps.length,
      hitRate: rs.length ? rs.filter((r) => r.hit).length / rs.length : null,
      labHit: spec.lab_hit,
      meanRaw: eps.length ? raw.mean : null,
      ciRaw: raw.ci,
      meanExcess: excessEps.length ? excess.mean : null,
      ciExcess: excess.ci,
      expectedMove: spec.expected_move,
      pnl: rs.reduce((a, r) => a + r.pnl, 0),
      smallSample: eps.length < need,
      sessionsTo30,
    };
  });
}
