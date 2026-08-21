/**
 * Trend template and Weinstein stage. (METRICS_SPEC family 1)
 *
 * Both depend on TRUE rolling moving averages. The five-point proxy in
 * lib/factors.ts is a reasonable stand-in for the sign of a trend but cannot
 * support these: criterion 3 compares the 200d average against itself 22
 * sessions ago, and a proxy has no history to compare. Per the spec, a trend
 * template scored against a proxy is not the trend template.
 *
 * So the whole template returns null without sufficient history rather than a
 * partial score. Criterion 8 alone is computable today from rsPct, but
 * reporting "1/8" would read as a near-total failure rather than as absent
 * data — which is exactly the way a screener lies to its user.
 *
 * Pure and I/O-free.
 */

/** Daily bar fields the trend family needs. Intraday extremes are required. */
export interface TrendBar {
  readonly close: number;
  readonly high: number;
  readonly low: number;
}

/** 200 sessions for the longest average, plus 22 for its slope test. */
export const TREND_MIN_HISTORY = 222;

/** Sessions in a 52-week window. */
export const YEAR_SESSIONS = 252;

/** Sessions used to smooth the stage slope. */
const STAGE_SLOPE_LOOKBACK = 10;

/** Minimum for a 150d average plus its 10-session slope. */
const STAGE_MIN_HISTORY = 160;

export interface TrendFlags {
  /** 1: above both the 150d and 200d averages. */
  readonly priceAboveLongMas: boolean;
  /** 2: the 150d average is above the 200d. */
  readonly ma150AboveMa200: boolean;
  /** 3: the 200d average is higher than it was 22 sessions ago. */
  readonly ma200Rising: boolean;
  /** 4: the 50d average is above both longer ones. */
  readonly ma50AboveLongMas: boolean;
  /** 5: price is above the 50d average. */
  readonly priceAboveMa50: boolean;
  /** 6: at least 30% above the 52-week low. */
  readonly above30PctOfLow: boolean;
  /** 7: within 25% of the 52-week high. */
  readonly within25PctOfHigh: boolean;
  /** 8: relative strength at or above the 70th percentile. */
  readonly rsAtLeast70: boolean;
}

export interface TrendTemplate {
  readonly flags: TrendFlags;
  /** How many of the eight passed. */
  readonly count: number;
  readonly ma50: number;
  readonly ma150: number;
  readonly ma200: number;
  readonly high52: number;
  readonly low52: number;
}

const finite = (n: number): boolean => typeof n === "number" && Number.isFinite(n);

/**
 * Rolling means for several windows in a single pass.
 *
 * Prefix sums rather than one reduction per window: the spec asks for all three
 * averages from one traversal, and recomputing 250 bars three times per ticker
 * per night across 2,200 names is the kind of waste that turns a nightly job
 * into an hourly one.
 */
export function rollingMeans(
  closes: readonly number[],
  windows: readonly number[],
): Map<number, (number | null)[]> {
  const prefix = new Array<number>(closes.length + 1).fill(0);
  for (let i = 0; i < closes.length; i++) prefix[i + 1] = prefix[i] + closes[i];

  const out = new Map<number, (number | null)[]>();
  for (const w of windows) {
    const series: (number | null)[] = new Array(closes.length).fill(null);
    for (let i = w - 1; i < closes.length; i++) {
      series[i] = (prefix[i + 1] - prefix[i + 1 - w]) / w;
    }
    out.set(w, series);
  }
  return out;
}

/**
 * Score the eight criteria, or null when the series cannot support them.
 *
 * @param bars  oldest first
 * @param rsPct universe-wide relative-strength percentile, for criterion 8
 */
export function trendTemplate(
  bars: readonly TrendBar[],
  rsPct: number | null,
): TrendTemplate | null {
  if (bars.length < TREND_MIN_HISTORY) return null;
  for (const b of bars) {
    if (!finite(b.close) || !finite(b.high) || !finite(b.low)) return null;
  }

  const closes = bars.map((b) => b.close);
  const mas = rollingMeans(closes, [50, 150, 200]);
  const last = closes.length - 1;

  const ma50 = mas.get(50)![last];
  const ma150 = mas.get(150)![last];
  const ma200 = mas.get(200)![last];
  const ma200Prior = mas.get(200)![last - 22];
  if (ma50 == null || ma150 == null || ma200 == null || ma200Prior == null) return null;

  // The 52-week range uses intraday extremes, not closes: a stock that spiked
  // to a high it never closed at is still 25% below that high.
  const yearBars = bars.slice(Math.max(0, bars.length - YEAR_SESSIONS));
  let high52 = -Infinity;
  let low52 = Infinity;
  for (const b of yearBars) {
    if (b.high > high52) high52 = b.high;
    if (b.low < low52) low52 = b.low;
  }
  if (!finite(high52) || !finite(low52) || low52 <= 0) return null;

  const close = closes[last];
  const flags: TrendFlags = {
    priceAboveLongMas: close > ma150 && close > ma200,
    ma150AboveMa200: ma150 > ma200,
    ma200Rising: ma200 > ma200Prior,
    ma50AboveLongMas: ma50 > ma150 && ma50 > ma200,
    priceAboveMa50: close > ma50,
    above30PctOfLow: close >= low52 * 1.3,
    within25PctOfHigh: close >= high52 * 0.75,
    // A missing percentile fails the criterion rather than throwing. It cannot
    // pass on absent evidence, but it must not sink the other seven either.
    rsAtLeast70: rsPct != null && finite(rsPct) && rsPct >= 70,
  };

  const count = Object.values(flags).filter(Boolean).length;
  return { flags, count, ma50, ma150, ma200, high52, low52 };
}

// ---------------------------------------------------------------------------
// 1.2 Weinstein stage
// ---------------------------------------------------------------------------

export type Stage = 1 | 2 | 3 | 4 | "Transitional";

export interface StageReport {
  readonly stage: Stage;
  /** Fractional change in the 150d average over ten sessions. */
  readonly slope150: number;
  readonly ma150: number;
  readonly label: string;
}

const STAGE_LABELS: Record<Exclude<Stage, "Transitional">, string> = {
  1: "Base / accumulation",
  2: "Advance",
  3: "Top / distribution",
  4: "Decline",
};

/**
 * Classify the stage from the 150d average, its smoothed slope, and price.
 *
 * The slope is measured over ten sessions rather than one so a single soft day
 * cannot flip a name between stages; stage analysis is meant to describe a
 * regime, and a one-day derivative describes noise.
 *
 * Anything that matches no rule is labelled Transitional rather than forced
 * into a bucket. The boundaries here are genuinely fuzzy and pretending
 * otherwise would claim precision the method does not have.
 */
export function weinsteinStage(bars: readonly TrendBar[]): StageReport | null {
  if (bars.length < STAGE_MIN_HISTORY) return null;

  const closes = bars.map((b) => b.close);
  for (const c of closes) if (!finite(c)) return null;

  const series = rollingMeans(closes, [150]).get(150)!;
  const last = closes.length - 1;
  const ma150 = series[last];
  const prior = series[last - STAGE_SLOPE_LOOKBACK];
  if (ma150 == null || prior == null || prior <= 0) return null;

  const slope150 = (ma150 - prior) / prior;
  const close = closes[last];
  const above = close > ma150;
  const farAbove = close > ma150 * 1.05;
  const farBelow = close < ma150 * 0.95;
  const flat = Math.abs(slope150) <= 0.02;

  let stage: Stage = "Transitional";
  if (flat && !farAbove && !farBelow) stage = 1;
  else if (slope150 > 0.02 && above) stage = 2;
  else if ((flat && farAbove) || (slope150 > 0 && !above)) stage = 3;
  else if (slope150 < -0.02 && !above) stage = 4;

  return {
    stage,
    slope150,
    ma150,
    label: stage === "Transitional" ? "Transitional" : STAGE_LABELS[stage],
  };
}
