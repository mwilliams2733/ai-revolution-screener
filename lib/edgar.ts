/**
 * SEC EDGAR XBRL companyfacts. Server-only, free, no API key.
 *
 * Closes the three criteria price data cannot reach (STRATEGY_DECODED.md
 * section 6): revenue and EPS acceleration, operating margin expansion, and
 * trailing valuation. EDGAR is actuals only; forward estimates remain a gap.
 *
 * EDGAR enforces a descriptive User-Agent containing a contact address and
 * returns 403 without one. It asks for no more than 10 requests/second; this
 * module stays well under that.
 */

const BASE = "https://data.sec.gov";

/** Facts are restated across filings, so dedup by period keeping the newest. */
export interface Period {
  /** Period end, ISO date. */
  readonly end: string;
  readonly val: number;
  /** Fiscal year and period as EDGAR labels them, e.g. 2026 / "Q2". */
  readonly fy: number | null;
  readonly fp: string | null;
  readonly form: string;
  readonly filed: string;
  /** Length in days, used to separate quarterly from annual facts. */
  readonly days: number;
}

function userAgent(): string {
  const contact = process.env.SEC_EDGAR_USER_AGENT?.trim();
  if (!contact) {
    throw new Error(
      "SEC_EDGAR_USER_AGENT is not set. EDGAR returns 403 without a contact address.",
    );
  }
  // EDGAR wants something identifying plus a way to reach you.
  return contact.includes("@") ? `AI Revolution Screener (${contact})` : contact;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded-concurrency gate on EDGAR calls.
 *
 * EDGAR asks for no more than 10 requests/second. Full serialisation stayed far
 * under that but made a 42-name sweep take ~53s, because each round trip is
 * about a second and none of them overlapped. Five in flight with a small gap
 * keeps well inside the published limit while cutting the sweep to roughly a
 * fifth of the time.
 */
const MAX_IN_FLIGHT = 5;
const GAP_MS = 120;

let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function release(): void {
  inFlight -= 1;
  const next = waiting.shift();
  if (next) next();
}

function queued<T>(fn: () => Promise<T>): Promise<T> {
  return (async () => {
    await acquire();
    try {
      return await fn();
    } finally {
      await sleep(GAP_MS);
      release();
    }
  })();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface FactUnit {
  readonly end?: string;
  readonly start?: string;
  readonly val?: number;
  readonly fy?: number;
  readonly fp?: string;
  readonly form?: string;
  readonly filed?: string;
}

export interface CompanyFacts {
  readonly cik?: number;
  readonly entityName?: string;
  readonly facts?: {
    readonly "us-gaap"?: Record<string, { readonly units?: Record<string, FactUnit[]> }>;
    readonly "dei"?: Record<string, { readonly units?: Record<string, FactUnit[]> }>;
  };
}

/**
 * Raw companyfacts for one CIK, or null when EDGAR has no filer at that id.
 *
 * A 404 is an ordinary outcome, not a failure: foreign issuers and many OTC
 * names in the universe simply do not file with the SEC. Callers should treat
 * null as "no fundamentals available" and keep the price-only score.
 */
export async function companyFacts(cik: string): Promise<CompanyFacts | null> {
  const padded = cik.padStart(10, "0");
  return queued(async () => {
    const res = await fetch(`${BASE}/api/xbrl/companyfacts/CIK${padded}.json`, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (res.status === 403) {
      throw new Error("EDGAR returned 403. Check SEC_EDGAR_USER_AGENT carries a real address.");
    }
    if (!res.ok) throw new Error(`EDGAR HTTP ${res.status} for CIK${padded}`);
    return (await res.json()) as CompanyFacts;
  });
}

// ---------------------------------------------------------------------------
// Concept extraction
// ---------------------------------------------------------------------------

/**
 * Revenue tag, in preference order.
 *
 * Filers use different concepts for the same line, and the modern one
 * (RevenueFromContractWithCustomer...) only appears after ASC 606 adoption, so
 * older periods for the same company may sit under a different tag entirely.
 */
const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
] as const;

const OPERATING_INCOME_TAGS = [
  "OperatingIncomeLoss",
  // Fallbacks for filers that never tag OperatingIncomeLoss on a quarterly
  // basis. Pre-tax income is not operating income, but for a MARGIN TREND
  // compared against the same company a year earlier it tracks closely enough
  // to answer "expanding or compressing".
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
] as const;
const NET_INCOME_TAGS = ["NetIncomeLoss"] as const;
const EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"] as const;

function dayspan(start?: string, end?: string): number {
  if (!start || !end) return 0;
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
}

/**
 * Pull one concept as a clean, deduplicated period series.
 *
 * Two things make this less trivial than it looks. Companies restate, so the
 * same period appears several times across filings; the newest `filed` wins.
 * And a 10-K carries the full-year figure alongside quarterly ones, so callers
 * must filter by duration rather than assuming every fact is a quarter.
 */
export function extractConcept(
  facts: CompanyFacts,
  tags: readonly string[],
  unit = "USD",
): Period[] {
  const gaap = facts.facts?.["us-gaap"];
  if (!gaap) return [];

  // MERGE across tags rather than taking the first non-empty one.
  //
  // Filers migrate concepts mid-history (ASC 606 moved revenue off `Revenues`),
  // so the preferred tag often holds only the OLD series while current periods
  // sit under a newer name. Taking the first non-empty tag then silently
  // returns years-stale data that still looks well-formed. Earlier tags in the
  // list still win where two cover the same period.
  const byKey = new Map<string, Period>();

  for (const tag of tags) {
    const rows = gaap[tag]?.units?.[unit];
    if (!rows || rows.length === 0) continue;

    for (const r of rows) {
      if (!r.end || typeof r.val !== "number") continue;
      const days = dayspan(r.start, r.end);
      const key = `${r.end}:${days}`;
      const cur: Period = {
        end: r.end,
        val: r.val,
        fy: r.fy ?? null,
        fp: r.fp ?? null,
        form: r.form ?? "",
        filed: r.filed ?? "",
        days,
      };
      const prev = byKey.get(key);
      // First tag to cover a period wins (preference order). Within the same
      // tag, a later filing is a restatement and supersedes.
      if (!prev || cur.filed > prev.filed) byKey.set(key, cur);
    }
  }

  return [...byKey.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Quarterly facts only: roughly 90-day durations. */
export function quarterly(periods: readonly Period[]): Period[] {
  return periods.filter((p) => p.days >= 80 && p.days <= 100);
}

/** Annual facts only: roughly 365-day durations. */
export function annual(periods: readonly Period[]): Period[] {
  return periods.filter((p) => p.days >= 350 && p.days <= 380);
}

// ---------------------------------------------------------------------------
// Derived signals
// ---------------------------------------------------------------------------

export interface Fundamentals {
  readonly cik: string;
  readonly entityName: string;
  /** Most recent quarter end used for these figures. */
  readonly asOf: string | null;
  /** Year-over-year revenue growth for the latest quarter, percent. */
  readonly revYoY: number | null;
  /** Prior quarter's YoY growth, for comparison. */
  readonly revYoYPrior: number | null;
  /** revYoY minus revYoYPrior. Positive means growth is accelerating. */
  readonly revAccel: number | null;
  readonly epsYoY: number | null;
  readonly epsYoYPrior: number | null;
  readonly epsAccel: number | null;
  /** Operating margin for the latest quarter, percent. */
  readonly opMargin: number | null;
  /** Operating margin a year earlier, percent. */
  readonly opMarginYearAgo: number | null;
  /** Percentage POINTS of margin change. Positive means expanding. */
  readonly opMarginDelta: number | null;
  /** Trailing four quarters of diluted EPS. */
  readonly epsTtm: number | null;
  readonly quartersAvailable: number;
}

function pctChange(now: number, then: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
  // A sign flip makes percentage change meaningless (e.g. -5 to +5 is not
  // "+200% growth"), so decline to score it rather than emit a nonsense number.
  if (then < 0 && now < 0) return ((now - then) / Math.abs(then)) * 100;
  if (then < 0) return null;
  return ((now - then) / then) * 100;
}

/**
 * The period ending roughly one year before `periods[i]`, matched BY DATE.
 *
 * Index arithmetic (`periods[i - 4]`) is wrong here and wrong in a way that
 * looks right. A 10-K reports the full year, not a separate fiscal Q4, so
 * quarterly series carry a systematic annual gap: for NVDA the January quarters
 * are simply absent. Stepping back four entries therefore lands fifteen months
 * earlier, and every YoY figure comes out mismatched but plausible.
 *
 * Tolerance is 25 days, which absorbs 52/53-week fiscal calendars while still
 * refusing a match that is really two quarters away.
 */
const YEAR_MS = 365 * 86_400_000;
const TOLERANCE_MS = 25 * 86_400_000;

function yearAgo(periods: readonly Period[], i: number): number | null {
  const target = Date.parse(periods[i].end) - YEAR_MS;
  let best: Period | null = null;
  let bestDiff = Infinity;
  for (const p of periods) {
    const diff = Math.abs(Date.parse(p.end) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best && bestDiff <= TOLERANCE_MS ? best.val : null;
}

/** The period end roughly a year before `end`, or undefined if none is close. */
function yearAgoEnd(periods: readonly Period[], end: string | undefined): string | undefined {
  if (!end) return undefined;
  const target = Date.parse(end) - YEAR_MS;
  let best: Period | undefined;
  let bestDiff = Infinity;
  for (const p of periods) {
    const diff = Math.abs(Date.parse(p.end) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best && bestDiff <= TOLERANCE_MS ? best.end : undefined;
}

/**
 * Reduce raw facts to the signals the strategy actually asks about.
 *
 * Acceleration is deliberately second-order: not "is revenue growing" but "is
 * the growth RATE rising", which is what the transcript describes and what
 * separates a re-rating from a steady compounder.
 */
export function deriveFundamentals(cik: string, facts: CompanyFacts): Fundamentals {
  const revQ = quarterly(extractConcept(facts, REVENUE_TAGS));
  const opQ = quarterly(extractConcept(facts, OPERATING_INCOME_TAGS));
  const epsQ = quarterly(extractConcept(facts, EPS_TAGS, "USD/shares"));

  const base: Fundamentals = {
    cik,
    entityName: facts.entityName ?? "",
    asOf: revQ.at(-1)?.end ?? null,
    revYoY: null,
    revYoYPrior: null,
    revAccel: null,
    epsYoY: null,
    epsYoYPrior: null,
    epsAccel: null,
    opMargin: null,
    opMarginYearAgo: null,
    opMarginDelta: null,
    epsTtm: null,
    quartersAvailable: revQ.length,
  };

  const n = revQ.length;
  const revAgo = n >= 2 ? yearAgo(revQ, n - 1) : null;
  const revAgoPrior = n >= 3 ? yearAgo(revQ, n - 2) : null;
  const revYoY = n >= 2 && revAgo != null ? pctChange(revQ[n - 1].val, revAgo) : null;
  const revYoYPrior = n >= 3 && revAgoPrior != null ? pctChange(revQ[n - 2].val, revAgoPrior) : null;

  const m = epsQ.length;
  const epsAgo = m >= 2 ? yearAgo(epsQ, m - 1) : null;
  const epsAgoPrior = m >= 3 ? yearAgo(epsQ, m - 2) : null;
  const epsYoY = m >= 2 && epsAgo != null ? pctChange(epsQ[m - 1].val, epsAgo) : null;
  const epsYoYPrior = m >= 3 && epsAgoPrior != null ? pctChange(epsQ[m - 2].val, epsAgoPrior) : null;
  // TTM sums the last four AVAILABLE quarters. With the Q4 gap that can span
  // five calendar quarters, so it is an approximation, not a true trailing year.
  const epsTtm = m >= 4 ? epsQ.slice(-4).reduce((a, p) => a + p.val, 0) : null;

  // Margin needs revenue and operating income from the SAME quarter end, which
  // is not guaranteed: the two concepts can have different coverage.
  const revByEnd = new Map(revQ.map((p) => [p.end, p.val]));
  const marginAt = (end: string | undefined): number | null => {
    if (!end) return null;
    const rev = revByEnd.get(end);
    const op = opQ.find((p) => p.end === end)?.val;
    if (rev == null || op == null || rev === 0) return null;
    return (op / rev) * 100;
  };

  const latestEnd = revQ.at(-1)?.end;
  const opMargin = marginAt(latestEnd);
  const opMarginYearAgo = marginAt(yearAgoEnd(revQ, latestEnd));

  return {
    ...base,
    revYoY,
    revYoYPrior,
    revAccel: revYoY != null && revYoYPrior != null ? revYoY - revYoYPrior : null,
    epsYoY,
    epsYoYPrior,
    epsAccel: epsYoY != null && epsYoYPrior != null ? epsYoY - epsYoYPrior : null,
    opMargin,
    opMarginYearAgo,
    opMarginDelta:
      opMargin != null && opMarginYearAgo != null ? opMargin - opMarginYearAgo : null,
    epsTtm,
  };
}

/** Fetch and derive in one call. Null when the company does not file. */
export async function fundamentalsFor(cik: string): Promise<Fundamentals | null> {
  const facts = await companyFacts(cik);
  return facts ? deriveFundamentals(cik, facts) : null;
}
