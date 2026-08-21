/**
 * Portfolio-level risk. (METRICS_SPEC family 3)
 *
 * The board meeting concedes the book is "diversified within a narrow focus"
 * and that the whole thing drew down together in July 2026. Nothing in the app
 * measured that. These operate on the SELECTED portfolio rather than on
 * candidates: the question is not "is this name good" but "how much of what I
 * already own is the same bet twice".
 *
 * Pure and I/O-free. Null on insufficient data, never a partial figure.
 */

const finite = (n: number): boolean => typeof n === "number" && Number.isFinite(n);

// ---------------------------------------------------------------------------
// 3.1 Correlation
// ---------------------------------------------------------------------------

/**
 * Daily log returns.
 *
 * Logs rather than simple returns because they add across periods, which is
 * what makes a correlation over a window meaningful. A non-positive price
 * yields null rather than -Infinity poisoning every downstream statistic.
 */
export function logReturns(closes: readonly number[]): number[] | null {
  if (closes.length < 2) return null;
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!finite(prev) || !finite(cur) || prev <= 0 || cur <= 0) return null;
    out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Pearson correlation.
 *
 * Returns null when either series is flat. Zero variance means correlation is
 * undefined, and reporting 0 would claim measured independence — exactly the
 * kind of invented number this codebase keeps refusing to emit.
 */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;

  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    if (!finite(a[i]) || !finite(b[i])) return null;
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/** Sessions of return history used for the correlation window. */
export const CORRELATION_WINDOW = 60;

/**
 * Correlation matrix across holdings, or null if any holding lacks history.
 *
 * All-or-nothing on purpose: a matrix missing rows would silently change what
 * the mean and the effective-bets figures are averaging over, and a smaller
 * book always looks more diversified.
 */
export function correlationMatrix(
  tickers: readonly string[],
  closesByTicker: ReadonlyMap<string, readonly number[]>,
  window: number = CORRELATION_WINDOW,
): number[][] | null {
  if (tickers.length < 2) return null;

  const returns: number[][] = [];
  for (const t of tickers) {
    const closes = closesByTicker.get(t);
    if (!closes || closes.length < window + 1) return null;
    const r = logReturns(closes.slice(closes.length - (window + 1)));
    if (r == null) return null;
    returns.push(r);
  }

  const n = tickers.length;
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = correlation(returns[i], returns[j]);
      if (c == null) return null;
      m[i][j] = c;
      m[j][i] = c;
    }
  }
  return m;
}

/** Mean of the off-diagonal entries. The diagonal is always 1 and would lie. */
export function meanPairwiseCorrelation(matrix: readonly (readonly number[])[]): number | null {
  const n = matrix.length;
  if (n < 2) return null;
  let total = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      total += matrix[i][j];
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

export interface CorrelatedPair {
  readonly a: string;
  readonly b: string;
  readonly correlation: number;
}

/** The most correlated pairs, where redundancy actually lives. */
export function topCorrelatedPairs(
  tickers: readonly string[],
  matrix: readonly (readonly number[])[],
  limit = 5,
): CorrelatedPair[] {
  const pairs: CorrelatedPair[] = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      pairs.push({ a: tickers[i], b: tickers[j], correlation: matrix[i][j] });
    }
  }
  return pairs.sort((x, y) => y.correlation - x.correlation).slice(0, limit);
}

// ---------------------------------------------------------------------------
// 3.2 Effective number of bets
// ---------------------------------------------------------------------------

/**
 * Herfindahl index over weights, normalised so they need not sum to one.
 *
 * The published book sums to 100.01% because the tier weights are rounded, so
 * assuming an exact 1.0 would bias every figure derived from it.
 */
export function herfindahl(weights: readonly number[]): number | null {
  let total = 0;
  for (const w of weights) {
    if (!finite(w) || w < 0) return null;
    total += w;
  }
  if (total <= 0) return null;

  let hhi = 0;
  for (const w of weights) {
    const share = w / total;
    hhi += share * share;
  }
  return hhi;
}

/** Concentration-only effective bets: 1 / HHI. */
export function effectiveBetsWeight(weights: readonly number[]): number | null {
  const hhi = herfindahl(weights);
  return hhi == null || hhi <= 0 ? null : 1 / hhi;
}

/**
 * Correlation-adjusted effective bets: (sum w)^2 / (w' C w).
 *
 * The honest version. A book of perfectly correlated names is ONE bet however
 * many tickers it holds, and the gap between this and the weight-only figure is
 * the cost of theme concentration — the single most decision-relevant number
 * this family produces.
 */
export function effectiveBetsCorrelation(
  weights: readonly number[],
  matrix: readonly (readonly number[])[],
): number | null {
  const n = weights.length;
  if (n === 0 || matrix.length !== n) return null;

  let sum = 0;
  for (const w of weights) {
    if (!finite(w) || w < 0) return null;
    sum += w;
  }
  if (sum <= 0) return null;

  let quad = 0;
  for (let i = 0; i < n; i++) {
    if (matrix[i].length !== n) return null;
    for (let j = 0; j < n; j++) quad += weights[i] * weights[j] * matrix[i][j];
  }
  if (quad <= 0) return null;

  return (sum * sum) / quad;
}

// ---------------------------------------------------------------------------
// 3.3 Sector concentration
// ---------------------------------------------------------------------------

export interface SectorShare {
  readonly sector: string;
  readonly weight: number;
  readonly share: number;
}

export interface Concentration {
  readonly hhi: number | null;
  readonly topThreeShare: number | null;
  readonly bySector: readonly SectorShare[];
}

/**
 * Concentration across the theme's sectors.
 *
 * The map has eleven sectors; if three of them hold most of the weight, the
 * sector labels are decorative rather than diversifying.
 */
export function sectorConcentration(
  rows: readonly { sector: string; weight: number }[],
): Concentration {
  if (rows.length === 0) return { hhi: null, topThreeShare: null, bySector: [] };

  const totals = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (!finite(r.weight) || r.weight < 0) continue;
    totals.set(r.sector, (totals.get(r.sector) ?? 0) + r.weight);
    total += r.weight;
  }
  if (total <= 0) return { hhi: null, topThreeShare: null, bySector: [] };

  const bySector = [...totals.entries()]
    .map(([sector, weight]) => ({ sector, weight, share: weight / total }))
    .sort((a, b) => b.weight - a.weight);

  const hhi = bySector.reduce((acc, s) => acc + s.share * s.share, 0);
  const topThreeShare = bySector.slice(0, 3).reduce((acc, s) => acc + s.share, 0);
  return { hhi, topThreeShare, bySector };
}

// ---------------------------------------------------------------------------
// 3.4 Drawdown contribution
// ---------------------------------------------------------------------------

export interface DrawdownWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  /** Fractional peak-to-trough loss, <= 0. */
  readonly drawdown: number;
}

/**
 * The worst decline over any rolling window of `window` sessions.
 *
 * Measured peak-to-trough WITHIN each window rather than first-to-last, since a
 * book that fell hard and partly recovered still had the drawdown.
 */
export function worstDrawdownWindow(
  series: readonly number[],
  window = 20,
): DrawdownWindow | null {
  if (series.length < window || window < 2) return null;

  let worst: DrawdownWindow = { startIndex: 0, endIndex: window - 1, drawdown: 0 };
  for (let end = window - 1; end < series.length; end++) {
    const start = end - window + 1;
    let peak = -Infinity;
    let trough = 0;
    let peakAt = start;
    for (let i = start; i <= end; i++) {
      const v = series[i];
      if (!finite(v) || v <= 0) return null;
      if (v > peak) {
        peak = v;
        trough = v;
        peakAt = i;
      } else if (v < trough) {
        trough = v;
      }
    }
    const dd = peak > 0 ? trough / peak - 1 : 0;
    if (dd < worst.drawdown) worst = { startIndex: peakAt, endIndex: end, drawdown: dd };
  }
  return worst;
}

export interface Contribution {
  readonly ticker: string;
  readonly contribution: number;
}

/** Decompose a loss by position: weight times that position's return. */
export function drawdownContributions(
  rows: readonly { ticker: string; weight: number; ret: number }[],
): Contribution[] {
  return rows
    .filter((r) => finite(r.weight) && finite(r.ret))
    .map((r) => ({ ticker: r.ticker, contribution: r.weight * r.ret }))
    .sort((a, b) => a.contribution - b.contribution);
}

// ---------------------------------------------------------------------------
// 3.5 Tier history
// ---------------------------------------------------------------------------

export interface TierRecord {
  readonly session: string;
  readonly ticker: string;
  /** Nullable: a name can drop out of the liquid universe entirely. */
  readonly tier: string | null;
}

export interface Transition {
  readonly ticker: string;
  readonly session: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** Group records per ticker, ordered oldest first. */
function byTicker(history: readonly TierRecord[]): Map<string, TierRecord[]> {
  const out = new Map<string, TierRecord[]>();
  for (const r of history) {
    const list = out.get(r.ticker);
    if (list) list.push(r);
    else out.set(r.ticker, [r]);
  }
  for (const list of out.values()) list.sort((a, b) => a.session.localeCompare(b.session));
  return out;
}

/**
 * Actual tier changes, not one row per session.
 *
 * A name moving to null is a real transition: it left the liquid universe, and
 * losing that fact would understate turnover.
 */
export function tierTransitions(history: readonly TierRecord[]): Transition[] {
  const out: Transition[] = [];
  for (const [ticker, rows] of byTicker(history)) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tier !== rows[i - 1].tier) {
        out.push({ ticker, session: rows[i].session, from: rows[i - 1].tier, to: rows[i].tier });
      }
    }
  }
  return out.sort((a, b) => a.session.localeCompare(b.session) || a.ticker.localeCompare(b.ticker));
}

/** Consecutive sessions each name has held its current tier. */
export function timeInTier(history: readonly TierRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [ticker, rows] of byTicker(history)) {
    const current = rows[rows.length - 1].tier;
    let count = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i].tier === current; i--) count += 1;
    out.set(ticker, count);
  }
  return out;
}

/** Trading sessions in a year, for annualising. */
const SESSIONS_PER_YEAR = 252;

/**
 * Tier changes per position per year.
 *
 * Above roughly 200% the cutoffs are chasing noise rather than tracking a
 * regime — a name oscillating weekly between Buy and Hold is a signal-quality
 * problem, not a trading opportunity.
 */
export function annualisedTurnover(history: readonly TierRecord[]): number | null {
  const sessions = new Set(history.map((r) => r.session));
  const names = new Set(history.map((r) => r.ticker));
  if (sessions.size < 2 || names.size === 0) return null;

  const changes = tierTransitions(history).length;
  const perNamePerSession = changes / names.size / (sessions.size - 1);
  return perNamePerSession * SESSIONS_PER_YEAR;
}
