/**
 * Does the tier actually predict anything?
 *
 * Every rule in this repo so far has been judged on plausibility and stability.
 * Turnover, effective bets, tie-averaged ranks -- all of them measure whether
 * the machine is well behaved, none of them measures whether it is right. This
 * module measures the only thing that matters: forward return by tier.
 *
 * THE STATISTICS ARE THE HARD PART, NOT THE RETURNS
 *
 * A naive version of this reports "Strong Buy returned 4.1% over 21 days
 * against Hold's 1.2%, across 21,000 observations" and looks conclusive. It is
 * not, for two reasons, and both inflate the apparent sample by more than an
 * order of magnitude:
 *
 *  1. OVERLAP. A 21-session forward return measured every session shares 20 of
 *     its 21 days with the next one. Consecutive observations are almost the
 *     same number. Only every 21st window is independent, so this module
 *     samples non-overlapping windows and nothing else.
 *
 *  2. CROSS-SECTIONAL CORRELATION. On any given day ~104 names in one theme
 *     move together -- the live screen reports 19 holdings behaving like 2.9
 *     independent bets. Averaging them does not give 104 observations, it gives
 *     roughly one. So the unit of observation here is the SESSION, never the
 *     name-day: each window contributes exactly one cross-sectional mean per
 *     tier, and the statistics run over that short series.
 *
 * What survives is a small number of genuinely independent observations -- for
 * a 21-session horizon over one replayed year, about eleven. That is not enough
 * to prove anything, and `verdict()` says so rather than quoting a t-statistic
 * as though it settled the matter. An honest "underpowered" is the expected
 * result of this backtest, not a failure of it.
 *
 * WHAT THIS CANNOT CORRECT FOR
 *
 * The tier history it reads is reconstructed, and reconstruction carries three
 * biases that all push the result the same way -- upward:
 *
 *   - the theme map is today's, so names added to the theme after they had
 *     already run appear throughout the history;
 *   - the universe was pruned to names liquid on at least ten sessions, using
 *     today's knowledge of which those were;
 *   - the fundamental gate is not replayed at all.
 *
 * A ruleset that cannot beat its benchmark even with that much help is dead,
 * which is what makes the test worth running despite the biases. The reverse
 * does not follow: beating the benchmark here does not establish an edge.
 */

import type { Tier } from "./types";

/** Tiers reported in output order, best to worst. */
export const TIERS: readonly Tier[] = ["Strong Buy", "Buy", "Hold"] as const;

/** One name's tier on one session. */
export interface TierObservation {
  readonly session: string;
  readonly ticker: string;
  readonly tier: Tier;
}

/**
 * Close prices indexed by position in the trading calendar.
 *
 * Positional rather than date-keyed because "21 sessions forward" has to mean
 * trading sessions. Indexing by date would need a calendar walk at every
 * lookup, and a naive date-plus-days would quietly cross weekends and holidays.
 */
export type CloseSeries = ReadonlyMap<string, readonly (number | null)[]>;

/**
 * Simple return from `at` to `at + horizon`, or null if either end is missing.
 *
 * Null rather than zero on a gap. A missing bar is an unmeasured return, and
 * scoring it as flat would drag every average toward zero in exactly the names
 * with the patchiest data.
 */
export function forwardReturn(
  closes: readonly (number | null)[],
  at: number,
  horizon: number,
): number | null {
  const from = closes[at];
  const to = closes[at + horizon];
  if (from == null || to == null || from <= 0) return null;
  return to / from - 1;
}

/**
 * Start positions for windows that do not share a single day.
 *
 * Anchored at the OLDEST usable window and stepped forward, so the series
 * always ends on the most recent complete window that fits. The alternative --
 * anchoring at the newest and stepping back -- would silently drop the oldest
 * partial block, which is the same data either way, but this direction keeps
 * the block boundaries stable as new sessions arrive.
 */
export function nonOverlappingStarts(sessions: number, horizon: number): number[] {
  if (horizon <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i + horizon < sessions; i += horizon) out.push(i);
  return out;
}

/** Equal-weight mean of the measured values, or null when none were measured. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const seen = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (seen.length === 0) return null;
  return seen.reduce((a, b) => a + b, 0) / seen.length;
}

export interface Stats {
  /** Independent observations. Windows, not name-days. */
  readonly n: number;
  readonly mean: number | null;
  /** Sample standard deviation across windows. */
  readonly sd: number | null;
  /** mean / (sd / sqrt(n)). Null when it cannot be formed. */
  readonly t: number | null;
  /** Share of windows above zero. Descriptive only at these sample sizes. */
  readonly hitRate: number | null;
}

const EMPTY: Stats = { n: 0, mean: null, sd: null, t: null, hitRate: null };

/**
 * Mean, dispersion and t-statistic over a series of independent windows.
 *
 * Uses the n-1 denominator. With ten or so windows the difference from n is not
 * cosmetic: it is the difference between a t of 2.1 and one of 2.2, and at this
 * sample size neither is evidence of anything -- which is the point `verdict`
 * exists to make.
 */
export function stats(values: readonly (number | null)[]): Stats {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return EMPTY;

  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const hitRate = xs.filter((x) => x > 0).length / n;
  if (n < 2) return { n, mean, sd: null, t: null, hitRate };

  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  // `sd > 0` is not enough. A constant series does not sum to a mean that is
  // bit-identical to its members -- (0.2+0.2+0.2)/3 is 0.20000000000000004 --
  // so the deviations come out around 1e-17 rather than zero and the t-statistic
  // explodes to 1e16. Anything below floating-point noise for the scale of the
  // data is no dispersion at all.
  const scale = Math.max(...xs.map(Math.abs));
  const degenerate = !(sd > scale * 1e-12);
  const t = degenerate ? null : mean / (sd / Math.sqrt(n));
  return { n, mean, sd, t, hitRate };
}

/**
 * Independent windows below which no t-statistic is worth reading aloud.
 *
 * Twenty is not a threshold of significance -- it is a threshold of even
 * looking. Below it the t-distribution's tails are wide enough that the usual
 * |t| > 2 habit, which is a normal-distribution rule of thumb, is simply wrong.
 */
export const MIN_WINDOWS = 20;

export type Verdict = "underpowered" | "no evidence" | "suggestive";

/**
 * What a result is allowed to claim.
 *
 * There is deliberately no "significant". One reconstructed year cannot produce
 * one, and offering the word would invite the reader to find it. The best
 * available answer is "suggestive, go and get more data".
 */
export function verdict(s: Stats): Verdict {
  if (s.n < MIN_WINDOWS || s.t == null) return "underpowered";
  return Math.abs(s.t) > 2 ? "suggestive" : "no evidence";
}

export interface HorizonResult {
  readonly horizon: number;
  /** Windows sampled, before any tier had to be populated. */
  readonly windows: number;
  /** Per-tier stats over the cross-sectional mean of each window. */
  readonly byTier: ReadonlyMap<Tier, Stats>;
  /** Strong Buy minus Hold, per window. The headline claim. */
  readonly spread: Stats;
  /** Each tier's mean minus the benchmark's, per window. */
  readonly excess: ReadonlyMap<Tier, Stats>;
  /** Buy-and-hold benchmark over the same windows. */
  readonly benchmark: Stats;
  /** Equal-weight mean of every themed name, tier ignored. */
  readonly themeAll: Stats;
  /**
   * Strong Buy minus the whole theme, per window.
   *
   * The benchmark that actually decides whether the ruleset earns its keep. A
   * theme this concentrated beats SPY on theme selection alone; the question
   * the tier has to answer is whether ranking WITHIN the theme adds anything
   * over owning all of it equally. Beating SPY does not answer that.
   */
  readonly vsTheme: Stats;
}

export interface BacktestInput {
  /** Trading sessions, OLDEST FIRST. Index into this is a position in time. */
  readonly sessions: readonly string[];
  /** Tier rows; sessions absent from `sessions` are ignored. */
  readonly observations: readonly TierObservation[];
  readonly closes: CloseSeries;
  /** Ticker of the buy-and-hold comparison, e.g. "SPY". */
  readonly benchmark: string;
  readonly horizons: readonly number[];
}

/**
 * Run the whole comparison.
 *
 * The per-window unit is the cross-sectional EQUAL-WEIGHT mean of each tier.
 * Equal weight rather than the strategy's 7.43/5.00/2.60 on purpose: the
 * question here is whether the tier ranks names correctly, and weighting by the
 * tier would fold the answer into the question. Whether the published weights
 * are a good way to size the book is a separate test.
 */
export function runBacktest(input: BacktestInput): HorizonResult[] {
  const { sessions, observations, closes, benchmark, horizons } = input;
  const position = new Map(sessions.map((s, i) => [s, i]));

  // session -> tier -> tickers
  const bySession = new Map<string, Map<Tier, string[]>>();
  for (const o of observations) {
    if (!position.has(o.session)) continue;
    let tiers = bySession.get(o.session);
    if (!tiers) {
      tiers = new Map();
      bySession.set(o.session, tiers);
    }
    const list = tiers.get(o.tier);
    if (list) list.push(o.ticker);
    else tiers.set(o.tier, [o.ticker]);
  }

  const benchSeries = closes.get(benchmark) ?? [];

  return horizons.map((horizon) => {
    const starts = nonOverlappingStarts(sessions.length, horizon);

    const perTier = new Map<Tier, (number | null)[]>(TIERS.map((t) => [t, []]));
    const excessRaw = new Map<Tier, (number | null)[]>(TIERS.map((t) => [t, []]));
    const spreadRaw: (number | null)[] = [];
    const vsThemeRaw: (number | null)[] = [];
    const benchRaw: (number | null)[] = [];
    const allRaw: (number | null)[] = [];

    for (const at of starts) {
      const tiers = bySession.get(sessions[at]);
      const bench = forwardReturn(benchSeries, at, horizon);
      benchRaw.push(bench);

      const everyName: (number | null)[] = [];
      const means = new Map<Tier, number | null>();

      for (const tier of TIERS) {
        const tickers = tiers?.get(tier) ?? [];
        const rets = tickers.map((t) => forwardReturn(closes.get(t) ?? [], at, horizon));
        everyName.push(...rets);
        const m = meanOf(rets);
        means.set(tier, m);
        perTier.get(tier)!.push(m);
        excessRaw.get(tier)!.push(m == null || bench == null ? null : m - bench);
      }

      const all = meanOf(everyName);
      allRaw.push(all);
      const strong = means.get("Strong Buy");
      const hold = means.get("Hold");
      spreadRaw.push(strong == null || hold == null ? null : strong - hold);
      vsThemeRaw.push(strong == null || all == null ? null : strong - all);
    }

    return {
      horizon,
      windows: starts.length,
      byTier: new Map(TIERS.map((t) => [t, stats(perTier.get(t)!)])),
      excess: new Map(TIERS.map((t) => [t, stats(excessRaw.get(t)!)])),
      spread: stats(spreadRaw),
      benchmark: stats(benchRaw),
      themeAll: stats(allRaw),
      vsTheme: stats(vsThemeRaw),
    };
  });
}
