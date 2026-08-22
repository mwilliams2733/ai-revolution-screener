/**
 * Balance-sheet guardrails: market cap, dilution and cash runway.
 *
 * These exist to replace the $5 price floor. That floor was a single crude
 * proxy standing in for several different risks -- shells, illiquidity,
 * dilution, insolvency -- and it was bad at all of them in both directions: it
 * excluded sound companies whose shares happen to be cheap, and admitted a $12
 * stock with a $40M market cap. Each risk is measured directly here instead.
 *
 * WHAT XBRL GETS WRONG IF YOU READ IT NAIVELY
 *
 * Three traps, each of which silently produces a plausible wrong number:
 *
 *  1. CASH FLOW IS YEAR-TO-DATE, NOT QUARTERLY. A 10-Q reports the period from
 *     the start of the fiscal year to the quarter end, so only Q1 is ever a
 *     standalone quarter:
 *
 *         2026-01-01 -> 2026-03-31   89d   -630M   fp=Q1
 *         2026-01-01 -> 2026-06-30  180d  -1156M   fp=Q2   <- not a quarter
 *
 *     Reading the Q2 figure as a quarterly burn overstates it by ~2x, and the
 *     error grows through the year until Q4 overstates by 4x. Quarterly values
 *     have to be recovered by differencing consecutive periods within a fiscal
 *     year, which is what `quarterlySeries` does.
 *
 *  2. CASH IS NOT JUST CASH. `CashAndCashEquivalentsAtCarryingValue` excludes
 *     marketable securities, which is where a funded biotech keeps most of its
 *     money. Reading it alone can understate runway several-fold and would
 *     condemn well-capitalised companies.
 *
 *  3. THE SERIES CONTAINS DUPLICATES. The same period appears once per filing
 *     that reported it, including amendments. Summing without deduplication
 *     double-counts.
 *
 * Every function here returns null rather than a guess when the data cannot
 * support an answer, and `assess` reports "unknown" separately from "fail". A
 * company we could not measure must never be silently treated as a company
 * that failed -- that would quietly exclude every foreign filer and every name
 * whose CIK we never resolved.
 */

/** One XBRL fact. `start` is absent on instantaneous concepts like cash. */
export interface FactPoint {
  readonly end: string;
  readonly start?: string;
  readonly val: number;
  readonly fy?: number;
  readonly fp?: string;
  readonly form?: string;
}

const DAY_MS = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

/**
 * Newest point per period, amendments winning.
 *
 * Keyed by start+end so a restated period replaces rather than joins the
 * original. Later array entries win because companyfacts lists filings in
 * ascending order of filing date.
 */
export function dedupe(points: readonly FactPoint[]): FactPoint[] {
  const byPeriod = new Map<string, FactPoint>();
  for (const p of points) {
    if (!Number.isFinite(p.val)) continue;
    byPeriod.set(`${p.start ?? ""}|${p.end}`, p);
  }
  return [...byPeriod.values()].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

/** Most recent point, or null. */
export function latest(points: readonly FactPoint[]): FactPoint | null {
  const clean = dedupe(points);
  return clean.length ? clean[clean.length - 1] : null;
}

/**
 * The point closest to one year before `from`, within `toleranceDays`.
 *
 * Matched by DATE, never by index. Quarterly XBRL series skip fiscal Q4 -- the
 * 10-K carries the annual figure instead -- so "four points back" is not a year
 * back, and an index-based comparison drifts a quarter for every year of
 * history.
 */
export function yearEarlier(
  points: readonly FactPoint[],
  from: string,
  toleranceDays = 75,
): FactPoint | null {
  const target = Date.parse(from) - 365 * DAY_MS;
  let best: FactPoint | null = null;
  let bestGap = Infinity;
  for (const p of dedupe(points)) {
    const gap = Math.abs(Date.parse(p.end) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  return best != null && bestGap <= toleranceDays * DAY_MS ? best : null;
}

export interface Dilution {
  readonly shares: number;
  readonly sharesYearAgo: number;
  /** Fractional growth, so 0.25 is +25%. */
  readonly growth: number;
  readonly asOf: string;
}

/**
 * Year-on-year growth in shares outstanding.
 *
 * The clearest single tell for a company funding itself by issuing stock. A
 * name growing its share count 40% a year is transferring the business away
 * from its holders faster than most operating improvements can add value, and
 * its chart can look healthy the entire time.
 */
export function dilution(points: readonly FactPoint[]): Dilution | null {
  const now = latest(points);
  if (now == null || now.val <= 0) return null;
  const then = yearEarlier(points, now.end);
  if (then == null || then.val <= 0) return null;
  return {
    shares: now.val,
    sharesYearAgo: then.val,
    growth: now.val / then.val - 1,
    asOf: now.end,
  };
}

/**
 * Recover standalone quarterly values from year-to-date reporting.
 *
 * Within a fiscal year the periods nest -- Q1, then Q1+Q2, then Q1+Q2+Q3, then
 * the full year -- so each quarter is the difference between consecutive
 * cumulative figures. Grouped by `start`, because that is what identifies a
 * fiscal year's worth of cumulative periods regardless of how the filer labels
 * fy and fp.
 */
export function quarterlySeries(points: readonly FactPoint[]): FactPoint[] {
  const byStart = new Map<string, FactPoint[]>();
  for (const p of dedupe(points)) {
    if (!p.start) continue;
    const g = byStart.get(p.start);
    if (g) g.push(p);
    else byStart.set(p.start, [p]);
  }

  const out: FactPoint[] = [];
  for (const [, group] of byStart) {
    group.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
    let prior: FactPoint | null = null;
    for (const p of group) {
      const span = days(p.start!, p.end);
      // A period already about a quarter long needs no differencing. Anything
      // longer is cumulative and the previous cumulative figure is subtracted.
      if (span <= 100) {
        out.push(p);
      } else if (prior != null) {
        out.push({ end: p.end, start: prior.end, val: p.val - prior.val, form: p.form });
      }
      prior = p;
    }
  }
  return out.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

export interface Burn {
  /** Trailing twelve months of operating cash flow. Negative means burning. */
  readonly annual: number;
  readonly method: "ttm" | "annualised";
  readonly asOf: string;
}

/**
 * Trailing-twelve-month operating cash flow.
 *
 * Prefers four real quarters. Falls back to annualising the latest cumulative
 * period when fewer exist -- a young filer with two quarters of history is
 * exactly the kind of name this whole exercise is about, and refusing to
 * estimate would exclude it for being young rather than for being weak. The
 * method is reported so the caller can say which one it used.
 */
export function trailingBurn(points: readonly FactPoint[]): Burn | null {
  const quarters = quarterlySeries(points);
  if (quarters.length >= 4) {
    const last4 = quarters.slice(-4);
    // Only trust the sum if the four really span about a year; a gap in the
    // filings would otherwise produce a nine-month "annual" figure.
    const span = days(last4[0].start ?? last4[0].end, last4[3].end);
    if (span >= 300 && span <= 430) {
      return {
        annual: last4.reduce((a, p) => a + p.val, 0),
        method: "ttm",
        asOf: last4[3].end,
      };
    }
  }

  const cumulative = dedupe(points).filter((p) => p.start);
  const last = cumulative.length ? cumulative[cumulative.length - 1] : null;
  if (last == null) return null;
  const span = days(last.start!, last.end);
  if (span < 60) return null;
  return { annual: last.val * (365 / span), method: "annualised", asOf: last.end };
}

/**
 * Months of cash left at the current burn rate.
 *
 * Null for a company that is not burning: runway is not a meaningful number
 * when operations fund themselves, and returning a huge one would invite a
 * comparison that means nothing.
 */
export function runwayMonths(cash: number, burn: Burn | null): number | null {
  if (burn == null || burn.annual >= 0 || cash <= 0) return null;
  return cash / (Math.abs(burn.annual) / 12);
}

export interface Thresholds {
  readonly minMarketCap: number;
  /** Fractional, so 0.25 rejects share counts growing more than 25% a year. */
  readonly maxDilution: number;
  readonly minRunwayMonths: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minMarketCap: 150_000_000,
  maxDilution: 0.25,
  minRunwayMonths: 12,
};

export interface HealthInput {
  readonly price: number;
  /**
   * Shares outstanding, ALREADY SPLIT-ADJUSTED.
   *
   * Pass raw cover-page points through splits.adjustSeries first. The raw
   * series is never restated for splits, so a 10-for-1 reads as +900%
   * dilution -- see lib/splits.ts.
   */
  readonly shares: readonly FactPoint[];
  /** Cash and equivalents plus short-term investments, already summed. */
  readonly cash: number | null;
  readonly operatingCashFlow: readonly FactPoint[];
  /**
   * Trailing-twelve-month revenue, when known.
   *
   * Only used to decide whether the runway test APPLIES. See `assess`.
   */
  readonly revenue?: number | null;
}

export interface Health {
  readonly marketCap: number | null;
  readonly dilution: Dilution | null;
  readonly burn: Burn | null;
  readonly runway: number | null;
  /** "pass" | "fail" | "unknown" -- unknown is never treated as fail. */
  readonly verdict: "pass" | "fail" | "unknown";
  /** Which thresholds were breached, in the order they are checked. */
  readonly failures: readonly string[];
  /** Which checks could not be run at all. */
  readonly missing: readonly string[];
}

/**
 * Judge a company against the thresholds.
 *
 * A check that cannot be run is recorded in `missing`, never counted as a
 * failure. The verdict is "fail" only when something was actually measured and
 * breached; a name we know nothing about comes back "unknown" so the caller can
 * decide whether to show it, and say so on screen either way.
 */
export function assess(
  input: HealthInput,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Health {
  const failures: string[] = [];
  const missing: string[] = [];

  const sharesNow = latest(input.shares);
  const marketCap =
    sharesNow != null && sharesNow.val > 0 && input.price > 0
      ? sharesNow.val * input.price
      : null;
  if (marketCap == null) missing.push("market cap");
  else if (marketCap < t.minMarketCap) failures.push("market cap");

  const dil = dilution(input.shares);
  if (dil == null) missing.push("dilution");
  else if (dil.growth > t.maxDilution) failures.push("dilution");

  const burn = trailingBurn(input.operatingCashFlow);
  const runway = input.cash == null ? null : runwayMonths(input.cash, burn);

  /**
   * Runway is a PRE-REVENUE measure. A company whose sales exceed its cash
   * burn is not running out of money in the sense this test means -- its
   * negative operating cash flow is working-capital timing, and it can slow
   * purchasing at will.
   *
   * Applying it regardless flagged SMCI at "2 months", from $7.6bn of
   * inventory build against $25bn of revenue. That is a false alarm on one of
   * the largest operating businesses in the universe, and it would have read
   * as insolvency.
   */
  const fundsItself =
    input.revenue != null && burn != null && input.revenue >= Math.abs(burn.annual);

  if (fundsItself) {
    // Not missing and not failed: the question does not apply.
  } else if (burn == null || input.cash == null) {
    missing.push("runway");
  } else if (runway != null && runway < t.minRunwayMonths) {
    // Only a BURNING company can fail this. A cash-generative one has a null
    // runway and passes by not being asked the question.
    failures.push("runway");
  }

  // "unknown" only when NOTHING could be measured. A name with one usable
  // check is judged on it.
  const verdict =
    failures.length > 0 ? "fail" : missing.length >= 3 ? "unknown" : "pass";

  return { marketCap, dilution: dil, burn, runway, verdict, failures, missing };
}
