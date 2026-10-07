/**
 * Screen orchestration: resolve anchors, load the five snapshots, run the
 * pipeline, and shape the payload for the UI. Server-only.
 *
 * Cache-first with a live fallback. Every anchor is served from Postgres when
 * the backfill has stored it and fetched from the API when it has not, so the
 * route works before the backfill exists and gets faster afterwards without a
 * code change.
 */

import {
  anchorDates,
  groupedDaily,
  referenceTickers,
  SECURITY_TYPES,
  tradingCalendar,
} from "./polygon";
import { barsByTicker } from "./factors";
import {
  previousMomentumTiers,
  previousTiers,
  loadTierHistory,
  loadTrendHistory,
  loadCloseHistory,
  loadOpens,
  loadSnapshot,
  loadVolumeHistory,
  storedTradingSessions,
  tickerNames,
  tickerSectors,
  companyHealth,
  splitHistory,
  medianDollarVolume,
  lastRefresh,
  loadStoredFundamentals,
} from "./db";
import { MA_WINDOW, applyTrueMa, trueMaCount, type MaSource } from "./moving-average";
import { assessStaleness, type StalenessReport } from "./staleness";
import type { RefreshRun } from "./refresh-stamp";
import { periodChanges, type PeriodChanges } from "./period-change";
import { VOLUME_WINDOW, type VolumeBar } from "./volume";
import { applyVolume, volumeMeasuredCount, type VolumeFields } from "./volume-overlay";
import { TREND_MIN_HISTORY, applyTrend, trendScoredCount, type TrendFields } from "./trend-overlay";
import { applyStageRule, stageDemotedCount, type StageFields } from "./stage-overlay";
import { applyHysteresis, heldCount, type HysteresisFields } from "./hysteresis";
import {
  HISTORY_WINDOW,
  summariseTierHistory,
  type TierHistorySummary,
} from "./tier-history-overlay";
import type { TrendBar } from "./trend-template";
import { portfolioRisk, type PortfolioRisk } from "./portfolio-overlay";
import { buildPortfolio } from "./tiers";
import {
  bookFetchList,
  usableFundamentals,
  wantedFundamentals,
  type StoredFundamentals,
} from "./fundamentals-store";
import { defaultTopUpDeps, topUpFundamentals } from "./fundamentals-topup";
import { splitBook, toMarketRow, type MarketRow } from "./market-rows";
import { applyFundamentalOverlay, demotedCount } from "./fundamental-gate";
import { capHeldCount, capStrongBuy, cappedCount, type CappedRow } from "./strong-buy-cap";
import {
  applyHealth,
  healthCappedCount,
  healthUnknownCount,
  type HealthFacts,
  type HealthFields,
} from "./health-overlay";
import type { Split } from "./splits";
import { runScreen, DEFAULT_PARAMS, withParams } from "./index";
import { exclusionReason, themeUniverse } from "./theme";
import type { AnchorLabel, BarsByTicker, ScreenRow, Snapshots, Tier } from "./types";
import type { SectorLabels } from "./sic";
import { isoDaysAgo } from "./dates";

const ANCHOR_LABELS: readonly AnchorLabel[] = ["r1m", "r3m", "r6m", "r12m"] as const;

export type Source = "db" | "api";

export interface VetoedRow extends ScreenRow {
  /** Why this name is excluded, e.g. "crowding veto: memory/storage". */
  readonly excluded: string;
}

/**
 * Daily closes for the moving-average window, empty when there is no database.
 *
 * With no stored history every row falls back to the five-point proxy, which is
 * the current state of this deployment. The fallback is explicit and reported
 * rather than silent, so the UI can say which average it used.
 */
async function loadHistory(
  tickers: readonly string[],
  warnings: string[],
): Promise<Map<string, number[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadCloseHistory(MA_WINDOW, tickers);
  } catch (e) {
    warnings.push(`close history: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

/** Recorded tier history. Empty without a database. */
async function loadHistorySummary(warnings: string[]): Promise<TierHistorySummary> {
  if (!dbConfigured()) return summariseTierHistory([]);
  try {
    return summariseTierHistory(await loadTierHistory(HISTORY_WINDOW));
  } catch (e) {
    warnings.push(`tier history: ${e instanceof Error ? e.message : String(e)}`);
    return summariseTierHistory([]);
  }
}

/** Close, high and low for the trend family. Empty without a database. */
async function loadTrendBars(
  tickers: readonly string[],
  warnings: string[],
): Promise<Map<string, TrendBar[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadTrendHistory(Math.max(TREND_MIN_HISTORY, 252), tickers);
  } catch (e) {
    warnings.push(`trend history: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

/** Close and volume for the volume family. Empty without a database. */
async function loadVolumeBars(warnings: string[]): Promise<Map<string, VolumeBar[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadVolumeHistory(VOLUME_WINDOW + 1);
  } catch (e) {
    warnings.push(`volume history: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

/** How many names may hold the Strong Buy tier at once. */
export const STRONG_BUY_LIMIT = 10;

/**
 * Screen parameters, overriding two decoded defaults.
 *
 * `minPrice` drops from $5 to $1. $5 was a convention -- the Reg T
 * marginability line -- and said nothing about a company; every risk it stood
 * in for is now measured directly by the balance-sheet guardrails. $1 is a
 * fact: below it an exchange opens delisting deficiency proceedings, so "above
 * $1" means "currently in compliance with its listing standards".
 *
 * `minDollarVolume` drops to zero here because the same-day gate has been
 * replaced by a PERSISTENT one -- see LIQUIDITY_WINDOW. Leaving both active
 * would gate twice on the same idea, once badly.
 */
export const SCREEN_PARAMS = withParams({ minPrice: 1, minDollarVolume: 0 });

/** Sessions the persistent liquidity gate measures over. */
export const LIQUIDITY_WINDOW = 50;

/** Median dollar volume a name must sustain to be ranked at all. */
export const MIN_MEDIAN_DOLLAR_VOLUME = 10_000_000;

/** A screen row carrying the day's open alongside the close. */
export interface PricedRow extends CappedRow, VolumeFields, TrendFields, StageFields, HysteresisFields, HealthFields {
  /** Day, week and month price changes. */
  readonly changes: PeriodChanges;
  /** Whether vsMa came from a real rolling mean or the five-point proxy. */
  readonly maSource: MaSource;
  /** Session open. Null when the source did not carry one. */
  readonly open: number | null;
}

export interface ScreenPayload {
  readonly asOf: string;
  readonly anchors: Record<string, { date: string; bars: number; source: Source }>;
  readonly universeSize: number;
  /** How far behind the latest trading session this data is. */
  readonly staleness: StalenessReport;
  /**
   * The last refresh run, or null when the log is empty or unreadable.
   *
   * Separate from `staleness`: that measures the DATA, this measures the
   * PIPELINE. A dead cron leaves staleness looking fine until the calendar
   * moves past the stored session, which is hours later and never at all over
   * a weekend.
   */
  readonly lastRefresh: RefreshRun | null;
  readonly themed: readonly PricedRow[];
  readonly portfolio: readonly ScreenRow[];
  /** How many momentum Strong Buys the fundamental gate moved down. */
  readonly demoted: number;
  /** How many cleared every rule but fell outside the top N. */
  readonly capped: number;
  /** How many top-N slots were decided by incumbency rather than raw rank. */
  readonly capHeld: number;
  /** How many the balance-sheet guardrails capped at Hold. */
  readonly healthCapped: number;
  /** How many could not be measured against the guardrails at all. */
  readonly healthUnknown: number;
  /** How many were capped by the Weinstein stage rule. */
  readonly stageDemoted: number;
  /** How many kept a tier they would otherwise have flipped out of. */
  readonly held: number;
  /** Concentration and correlation across the selected book. */
  readonly risk: PortfolioRisk;
  /** Tier stability over the recorded nights. */
  readonly history: TierHistorySummary;
  readonly strongBuyLimit: number;
  /**
   * Every ranked name in the liquid universe, under the full ruleset, grouped
   * for display. Tiers here have NO Strong Buy cap; the cap is a property of
   * the AI book (`themed`), not of the market.
   */
  readonly market: readonly MarketRow[];
  /** How many market rows carry a real SIC classification. */
  readonly marketClassified: number;
  /** Strong Buy candidates whose stored fundamentals are missing or stale. */
  readonly fundamentalsWanted: readonly string[];
  /** Theme names held out by the crowding veto, ranked, never silently dropped. */
  readonly vetoed: readonly VetoedRow[];
  readonly meta: {
    readonly namesSource: Source;
    readonly calendarSource: Source;
    readonly dbAvailable: boolean;
    readonly elapsedMs: number;
    /** Names the fundamental gate could actually judge. */
    readonly fundamentalsChecked: number;
    /** Market-wide momentum Strong Buys the gate could not judge (no stored facts yet). */
    readonly fundamentalsUnverified: number;
    /** Rows whose vsMa is a true rolling mean rather than the proxy. */
    readonly trueMaRows: number;
    readonly maWindow: number;
    /** Rows with enough history for an up/down volume ratio. */
    readonly volumeMeasured: number;
    readonly volumeWindow: number;
    /** Rows with enough history for a full 8-criterion trend template. */
    readonly trendScored: number;
    readonly trendMinHistory: number;
    /** Data-loading failures, so a broken query never looks like missing data. */
    readonly warnings: readonly string[];
  };
}


/** Is a Postgres connection configured at all? */
function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Trading-session dates, newest first.
 *
 * Prefers the session ledger, which only contains dates confirmed to have bars.
 * Falls back to one aggregates call. The ledger is only trusted when it holds
 * enough sessions to reach the r12m anchor; a partial backfill must not
 * silently yield a too-recent 12-month anchor, which would inflate every
 * long-horizon return in the book.
 */
async function resolveCalendar(): Promise<{ calendar: string[]; source: Source }> {
  const needed = DEFAULT_PARAMS.lookbacks.r12m + 1;
  if (dbConfigured()) {
    try {
      const stored = await storedTradingSessions();
      if (stored.length >= needed) return { calendar: stored, source: "db" };
    } catch {
      // fall through to the API
    }
  }
  const calendar = await tradingCalendar(isoDaysAgo(430), isoDaysAgo(0));
  return { calendar, source: "api" };
}

/**
 * A trading calendar that does NOT come from what we have stored.
 *
 * Staleness asks "is our newest stored session the newest session that exists".
 * Answering it with the stored ledger is circular -- the ledger's head IS our
 * as-of date, so indexOf is always 0 and the check can never fail. The proxy
 * aggregates know about sessions this app has never fetched, which is exactly
 * the gap a stalled refresh opens.
 *
 * Today is excluded: this plan serves delayed end-of-day bars, so the current
 * session is never the expected as-of date, and counting it would report every
 * afternoon as one session behind.
 *
 * Returns null when the reference cannot be fetched. Callers must treat that as
 * "unknown", never as "fresh".
 */
async function referenceCalendar(warnings: string[]): Promise<string[] | null> {
  try {
    const today = isoDaysAgo(0);
    const cal = await tradingCalendar(isoDaysAgo(30), today);
    return cal.filter((d) => d < today);
  } catch (e) {
    warnings.push(`reference calendar: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * One snapshot, from Postgres when stored and from the API otherwise.
 *
 * `opens` is only populated for the current session, which is the only one the
 * UI shows an open price for. Historical anchors do not need it.
 */
async function loadOne(
  date: string,
  wantOpens = false,
): Promise<{ bars: BarsByTicker; opens: Map<string, number>; source: Source }> {
  if (dbConfigured()) {
    try {
      const cached = await loadSnapshot(date);
      if (cached.size > 0) {
        const opens = wantOpens ? await loadOpens(date) : new Map<string, number>();
        return { bars: cached, opens, source: "db" };
      }
    } catch {
      // fall through to the API
    }
  }
  const raw = await groupedDaily(date);
  const opens = new Map<string, number>();
  if (wantOpens) {
    for (const b of raw) {
      if (b?.T && typeof b.o === "number" && Number.isFinite(b.o)) opens.set(b.T, b.o);
    }
  }
  return { bars: barsByTicker(raw), opens, source: "api" };
}

/**
 * Stored fundamentals, empty without a database.
 *
 * Never live EDGAR: ~400 market-wide Strong Buy candidates cannot be fetched
 * inside a 60s request. The nightly refresh and scripts/fundamentals.ts fill
 * the table. A failure here is a warning; the gate then reads every candidate
 * as unverified, which demotes nothing.
 */
/** ticker -> fetched_at, the shape wantedFundamentals reads. */
function fetchedAtOf(stored: ReadonlyMap<string, StoredFundamentals>): Map<string, string> {
  return new Map([...stored].map(([t, s]) => [t, s.fetchedAt]));
}

/**
 * Ceiling on the in-request fetch for the book's own candidates. Measured EDGAR
 * throughput is 172-240 ms per name, so this covers ~80+ names -- more than the
 * book's ~56 momentum Strong Buys even with an empty store.
 */
const BOOK_FETCH_BUDGET_MS = 20_000;

async function storedFundamentals(warnings: string[]): Promise<Map<string, StoredFundamentals>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadStoredFundamentals();
  } catch (e) {
    warnings.push(`fundamentals: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}


/**
 * Names and CIKs from a SINGLE reference pass.
 *
 * These were briefly two functions, each paginating all ~5,300 tickers, which
 * doubled the cost of every screen for data that arrives in the same response.
 * One fetch, two maps.
 *
 * Memoised per instance: the reference universe changes on listing events, not
 * within a page load, and re-paginating it per request dominated the runtime.
 */
interface Reference {
  readonly names: Map<string, string>;
  readonly ciks: Map<string, string>;
  /** SIC labels for the full universe. Empty until scripts/sectors.ts runs. */
  readonly sectors: Map<string, SectorLabels>;
  readonly source: Source;
  /**
   * Failures from building THIS reference snapshot.
   *
   * Stored with the value rather than pushed to the caller, because the value
   * is cached for six hours: a caller that hits the cache must still learn
   * that its sectors are missing. Replaying from the cache entry keeps the one
   * fact in one place instead of two that must agree.
   */
  readonly warnings: readonly string[];
}

let referenceCache: { at: number; value: Reference } | null = null;
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveReference(): Promise<Reference> {
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) {
    return referenceCache.value;
  }

  const warnings: string[] = [];

  // Every security type the screen considers, not just common stock. Fetching
  // CS alone excluded every ADR -- TSM, ASML and ARM among them -- from a
  // screener whose whole subject is the AI supply chain.
  const pages = await Promise.all(SECURITY_TYPES.map((t) => referenceTickers(true, {}, t)));
  const refs = pages.flat();
  const names = new Map<string, string>();
  const ciks = new Map<string, string>();
  for (const r of refs) {
    names.set(r.ticker, r.name);
    if (r.cik) ciks.set(r.ticker, r.cik);
  }

  // Postgres wins for names once the backfill has populated it, but it carries
  // no CIKs on this path, so the reference call still supplies those.
  let source: Source = "api";
  if (dbConfigured()) {
    try {
      const cached = await tickerNames();
      if (cached.size > 0) {
        for (const [t, n] of cached) names.set(t, n);
        source = "db";
      }
    } catch {
      // keep the API values
    }
  }

  // SIC labels for the whole ranked universe, so the leaders view can be
  // filtered by sector. Empty until scripts/sectors.ts has run; every
  // unclassified name then renders as "Other" rather than disappearing.
  let sectors = new Map<string, SectorLabels>();
  if (dbConfigured()) {
    try {
      sectors = await tickerSectors();
    } catch (e) {
      warnings.push(`sectors: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const value: Reference = { names, ciks, sectors, source, warnings };
  referenceCache = { at: Date.now(), value };
  return value;
}

/**
 * Theme names withheld by the crowding veto, carrying the ranks they would
 * otherwise have received.
 *
 * runScreen filters these out before returning, so they are recovered here
 * rather than by changing the core: diff the veto-inclusive theme against the
 * default one, then look those tickers up in the full ranked universe. Keeping
 * this at the service layer means the veto is presentational and reversible,
 * and the reason travels with the row.
 */
function collectVetoed(
  ranked: readonly ScreenRow[],
  restrictTo: ReadonlySet<string>,
): VetoedRow[] {
  const all = themeUniverse({ includeVetoed: true, restrictTo });
  const visible = themeUniverse({ restrictTo });
  const byTicker = new Map(ranked.map((r) => [r.ticker, r]));

  const out: VetoedRow[] = [];
  for (const [ticker, sector] of all) {
    if (visible.has(ticker)) continue;
    const row = byTicker.get(ticker);
    if (!row) continue; // not liquid enough to have been scored
    out.push({ ...row, sector, excluded: exclusionReason(ticker) ?? "excluded" });
  }
  return out.sort((a, b) => (b.rsPct ?? 0) - (a.rsPct ?? 0));
}

/**
 * Memoised payload shared by the page and the route.
 *
 * The page is a server component that calls getScreen() on every render, while
 * the route kept its own cache — so a page view paid the full cost (calendar,
 * five grouped sessions, the reference universe and up to 42 EDGAR sweeps)
 * even when the route had just computed exactly the same thing. One memo here
 * serves both. Bars are delayed end-of-day, so 15 minutes costs no freshness.
 */
const SCREEN_TTL_MS = 15 * 60 * 1000;
let screenCache: { at: number; value: ScreenPayload } | null = null;

export async function getScreen(force = false): Promise<ScreenPayload> {
  if (!force && screenCache && Date.now() - screenCache.at < SCREEN_TTL_MS) {
    return screenCache.value;
  }
  const payload = await computeScreen();
  screenCache = { at: Date.now(), value: payload };
  return payload;
}

async function computeScreen(): Promise<ScreenPayload> {
  const started = Date.now();
  /**
   * Loader failures must not look like "no database".
   *
   * A swallowed error here previously made every row fall back to the proxy while
   * the audit reported "needs the backfill" -- which was false, the backfill had
   * run. Failures are recorded and surfaced in meta.warnings instead.
   *
   * Request-scoped: a module-level array was being cleared mid-pipeline, which
   * erased every warning raised before the reset, and leaked the ones raised
   * after it into the next request served by the same warm instance.
   */
  const warnings: string[] = [];

  const { calendar, source: calendarSource } = await resolveCalendar();
  // Keep the calendar so staleness is measured in sessions, not calendar days.
  const dates = anchorDates(calendar, DEFAULT_PARAMS.lookbacks);

  const missing = Object.entries(dates).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`insufficient history for anchors: ${missing.join(", ")}`);
  }

  const anchors: ScreenPayload["anchors"] = {};
  const snapshots: Record<string, BarsByTicker> = {};

  let opens = new Map<string, number>();
  for (const label of ["now", ...ANCHOR_LABELS] as const) {
    const date = dates[label] as string;
    const { bars, opens: o, source } = await loadOne(date, label === "now");
    if (label === "now") opens = o;
    snapshots[label] = bars;
    anchors[label] = { date, bars: bars.size, source };
  }

  const { names, sectors, source: namesSource, warnings: refWarnings } =
    await resolveReference();
  warnings.push(...refWarnings);

  const reference = await referenceCalendar(warnings);

  // Persistent liquidity, applied by narrowing the universe BEFORE ranking.
  // Filtering afterwards would leave the percentiles computed over a different
  // set than the one on screen, and an RS of 90 would stop meaning the same
  // thing in both places.
  //
  // A name with no stored history falls back to today's dollar volume rather
  // than being excluded for being new -- a recent listing is not illiquid, it
  // is unmeasured, and the two must not be confused.
  const medians = dbConfigured()
    ? await medianDollarVolume(LIQUIDITY_WINDOW).catch((e: unknown) => {
        warnings.push(`median volume: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, number>();
      })
    : new Map<string, number>();

  const liquid = new Map<string, string>();
  for (const [ticker, name] of names) {
    const med = medians.get(ticker);
    const today = snapshots.now?.get(ticker);
    const dv = today ? today.close * today.volume : 0;
    if (med != null ? med >= MIN_MEDIAN_DOLLAR_VOLUME : dv >= MIN_MEDIAN_DOLLAR_VOLUME) {
      liquid.set(ticker, name);
    }
  }

  const { ranked, universeSize } = runScreen({
    snapshots: snapshots as unknown as Snapshots,
    names: liquid,
    params: SCREEN_PARAMS,
  });

  // Hysteresis sits between the momentum tier and the demoting overlays: it
  // adjusts the tier a name is entitled to, and the overlays then cap it.
  const priorTiers = dbConfigured()
    ? await previousMomentumTiers(dates.now as string).catch((e: unknown) => {
        warnings.push(`prior tiers: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, string>();
      })
    : new Map<string, string>();

  // Incumbents for the cap are last session's FINAL Strong Buys -- who actually
  // held a slot -- which is a different question from the momentum tier the
  // band above works on.
  const priorFinal = dbConfigured()
    ? await previousTiers(dates.now as string).catch((e: unknown) => {
        warnings.push(`prior final tiers: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      })
    : null;
  const incumbents = new Set(
    [...(priorFinal?.tiers ?? new Map<string, string>())]
      .filter(([, t]) => t === "Strong Buy")
      .map(([ticker]) => ticker),
  );

  // Every ranked name runs the full ruleset; the AI book is a filter of the
  // same rows (lib/market-rows.ts). True moving averages FIRST: they change
  // vsMa, which re-decides the tier, which decides who the gate considers.
  const rankedTickers = ranked.map((r) => r.ticker);
  const history = await loadHistory(rankedTickers, warnings);
  const withMa = applyTrueMa(ranked, history);
  const trended = applyHysteresis(withMa, priorTiers as ReadonlyMap<string, Tier>);

  // Stage needs the trend history, and the stage rule must run before the
  // fundamental gate and the cap: a topping name should not consume one of the
  // ten Strong Buy slots on its way down.
  const trendBars = await loadTrendBars(rankedTickers, warnings);
  const staged = applyTrend(trended, trendBars);
  const stageRuled = applyStageRule(staged);

  // Fundamental overlay from the nightly store. Candidates are the names the
  // gate can act on: Strong Buys after the stage rule.
  const candidates = stageRuled.filter((r) => r.tier === "Strong Buy").map((r) => r.ticker);
  // The AI book: theme members minus spenders and the crowding veto, restricted
  // to the liquid universe exactly as runScreen restricted `themed`.
  const bookTheme = themeUniverse({ restrictTo: new Set(liquid.keys()) });
  let stored = await storedFundamentals(warnings);

  // The book never waits a night for a new Strong Buy's facts: its own
  // candidates that are missing or stale are fetched now, as the live fetch
  // used to. Normally none; a failure leaves the name unverified, as before.
  const bookFetch = dbConfigured()
    ? bookFetchList(candidates, bookTheme, fetchedAtOf(stored), new Date())
    : [];
  if (bookFetch.length > 0) {
    try {
      const r = await topUpFundamentals(bookFetch, BOOK_FETCH_BUDGET_MS, defaultTopUpDeps());
      if (r.failed.length > 0 || r.remaining > 0) {
        warnings.push(
          `fundamentals: ${r.failed.length} book candidates failed and ${r.remaining} ran out of time; they read as unverified`,
        );
      }
      if (r.fetched > 0) stored = await storedFundamentals(warnings);
    } catch (e) {
      warnings.push(`fundamentals (book fetch): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fundamentals = usableFundamentals(stored, candidates);
  const fundamentalsWanted = wantedFundamentals(
    candidates,
    fetchedAtOf(stored),
    new Date(),
  );
  const overlaid = applyFundamentalOverlay(stageRuled, fundamentals);

  // Balance-sheet guardrails run BEFORE the cap, for the same reason the stage
  // rule does: a name that is about to be capped at Hold must not consume one
  // of the ten Strong Buy slots on its way down.
  const [healthFacts, splits] = dbConfigured()
    ? await Promise.all([
        companyHealth().catch((e: unknown) => {
          warnings.push(`company health: ${e instanceof Error ? e.message : String(e)}`);
          return new Map<string, HealthFacts>();
        }),
        splitHistory().catch((e: unknown) => {
          warnings.push(`splits: ${e instanceof Error ? e.message : String(e)}`);
          return new Map<string, Split[]>();
        }),
      ])
    : [new Map<string, HealthFacts>(), new Map<string, Split[]>()];
  const guarded = applyHealth(overlaid, healthFacts, splits);

  // Only the book is capped.
  const inBook = <T extends ScreenRow>(rows: readonly T[]) => splitBook(rows, bookTheme);
  const limited = capStrongBuy(inBook(guarded), STRONG_BUY_LIMIT, undefined, incumbents);
  const bookCapped = new Set(limited.filter((r) => r.capped).map((r) => r.ticker));

  // The book is selected from the FINAL tiers. runScreen also returns a
  // portfolio, but it is built from the raw momentum tiers before the
  // overlays above re-decide them.
  const portfolio = buildPortfolio(limited, SCREEN_PARAMS);


  // Volume metrics grade against the FULL ranked universe, never the theme.
  const volumeBars = await loadVolumeBars(warnings);
  const withVolume = applyVolume(ranked, limited, volumeBars);


  const priced: PricedRow[] = withVolume.map((r) => {
    const open = opens.get(r.ticker) ?? null;
    // Reuses the close history already loaded for the moving averages, so the
    // short-horizon changes cost no additional query.
    return { ...r, open, changes: periodChanges(history.get(r.ticker) ?? [], open) };
  });

  // "No database configured" is a SUPPORTED mode, not a loader failure -- CI
  // runs the audit without DATABASE_URL and every other loader here returns
  // empty silently. Reporting it as a warning made the audit's "history loaded
  // without errors" check fail on a screen that was working exactly as
  // designed. Guard first; only a real query error is worth a warning.
  //
  // And never fatal either way: the stamp is an observability nicety, and a
  // screen that refuses to render because its "last updated" line is
  // unavailable would be strictly worse than one that omits the line.
  const refreshRun = dbConfigured()
    ? await lastRefresh().catch((e: unknown) => {
        warnings.push(`refresh log: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      })
    : null;

  return {
    asOf: dates.now as string,
    staleness: reference
      ? assessStaleness(dates.now as string, reference)
      : {
          freshness: "very-stale" as const,
          sessionsBehind: Number.POSITIVE_INFINITY,
          label: "Freshness could not be checked",
        },
    lastRefresh: refreshRun,
    anchors,
    universeSize,
    themed: priced,
    portfolio,
    demoted: demotedCount(inBook(overlaid)),
    // Risk is measured over the SELECTED BOOK -- buildPortfolio's 7/7/5 shape
    // -- not over every buy-side candidate. "How correlated is what I own"
    // is a different question from "how correlated are the names I could own",
    // and measuring 66 candidates would understate concentration badly.
    risk: portfolioRisk(portfolio, history),
    history: await loadHistorySummary(warnings),
    market: guarded.map((r) =>
      toMarketRow(r, sectors.get(r.ticker), {
        inBook: bookTheme.has(r.ticker),
        bookCapped: bookCapped.has(r.ticker),
      }),
    ),
    marketClassified: ranked.filter((r) => sectors.has(r.ticker)).length,
    fundamentalsWanted,
    capped: cappedCount(limited),
    capHeld: capHeldCount(limited),
    healthCapped: healthCappedCount(limited),
    healthUnknown: healthUnknownCount(limited),
    stageDemoted: stageDemotedCount(inBook(stageRuled)),
    held: heldCount(inBook(trended)),
    strongBuyLimit: STRONG_BUY_LIMIT,
    vetoed: collectVetoed(ranked, new Set(names.keys())),
    meta: {
      namesSource,
      calendarSource,
      dbAvailable: dbConfigured(),
      elapsedMs: Date.now() - started,
      fundamentalsChecked: candidates.filter((t) => fundamentals.has(t)).length,
      fundamentalsUnverified: guarded.filter(
        (r) => r.momentumTier === "Strong Buy" && r.gate === "unverified",
      ).length,
      trueMaRows: trueMaCount(inBook(trended)),
      maWindow: MA_WINDOW,
      volumeMeasured: volumeMeasuredCount(withVolume),
      volumeWindow: VOLUME_WINDOW,
      trendScored: trendScoredCount(inBook(staged)),
      trendMinHistory: TREND_MIN_HISTORY,
      warnings: [...warnings],
    },
  };
}

// ---------------------------------------------------------------------------
// Ad-hoc ticker lookup
// ---------------------------------------------------------------------------

export interface LookupResult {
  readonly ticker: string;
  readonly found: boolean;
  /** The full scored row when the name cleared the liquidity gate. */
  readonly row: ScreenRow | null;
  /** Present in the theme universe? */
  readonly inTheme: boolean;
  /** Why it is not on the screen, when it is not. */
  readonly reason: string | null;
  readonly universeSize: number;
  /** How far behind the latest trading session this data is. */
  readonly staleness: StalenessReport;
  readonly asOf: string;
}

/**
 * Apply the full ruleset to any ticker, themed or not.
 *
 * The screen already ranks every liquid name before narrowing to the theme, so
 * an arbitrary ticker's percentile is a lookup rather than a recomputation, and
 * it carries the same universe-wide meaning as everything on the table.
 *
 * When a name is absent, say WHY. "Not found" is useless; "below the $10M
 * dollar-volume floor" is actionable, and distinguishes a deliberate exclusion
 * from a data gap.
 */
export async function lookupTicker(rawTicker: string): Promise<LookupResult> {
  const ticker = rawTicker.trim().toUpperCase();
  const screen = await getScreenRanked();
  const row = screen.ranked.find((r) => r.ticker === ticker) ?? null;
  const theme = themeUniverse({ includeVetoed: true });

  let reason: string | null = null;
  if (!row) {
    const bar = screen.nowBars.get(ticker);
    if (!bar) {
      reason = `no bar for ${screen.asOf} — not a listed US common stock, or it did not trade`;
    } else if (bar.close < DEFAULT_PARAMS.minPrice) {
      reason = `price $${bar.close.toFixed(2)} is below the $${DEFAULT_PARAMS.minPrice} floor`;
    } else {
      const dv = bar.volume * (bar.vwap || bar.close);
      if (dv < DEFAULT_PARAMS.minDollarVolume) {
        reason = `dollar volume $${(dv / 1e6).toFixed(1)}M is below the $${
          DEFAULT_PARAMS.minDollarVolume / 1e6
        }M floor`;
      } else {
        reason = "missing one or more return anchors — likely listed under 12 months";
      }
    }
  } else if (!theme.has(ticker)) {
    reason = exclusionReason(ticker) ?? "not in the AI CapEx-taker theme";
  } else {
    reason = exclusionReason(ticker);
  }

  return {
    ticker,
    found: row !== null,
    row,
    inTheme: theme.has(ticker) && exclusionReason(ticker) === null,
    reason,
    universeSize: screen.universeSize,
    asOf: screen.asOf,
    staleness: screen.staleness,
  };
}

/** Shared ranking pass used by both the screen and the lookup. */
async function getScreenRanked(): Promise<{
  ranked: readonly ScreenRow[];
  nowBars: BarsByTicker;
  universeSize: number;
  asOf: string;
  staleness: StalenessReport;
}> {
  const { calendar } = await resolveCalendar();
  const dates = anchorDates(calendar, DEFAULT_PARAMS.lookbacks);
  // Throwaway: this path returns no meta.warnings, so a failed reference fetch
  // has nowhere to be reported. The staleness fallback below still refuses to
  // claim freshness, which is the part that matters.
  const refWarnings: string[] = [];
  const reference = await referenceCalendar(refWarnings);
  const snapshots: Record<string, BarsByTicker> = {};

  for (const label of ["now", ...ANCHOR_LABELS] as const) {
    const { bars } = await loadOne(dates[label] as string);
    snapshots[label] = bars;
  }
  const { names } = await resolveReference();
  const { ranked, universeSize } = runScreen({
    snapshots: snapshots as unknown as Snapshots,
    names,
  });
  return {
    ranked,
    nowBars: snapshots.now,
    universeSize,
    asOf: dates.now as string,
    staleness: reference
      ? assessStaleness(dates.now as string, reference)
      : {
          freshness: "very-stale" as const,
          sessionsBehind: Number.POSITIVE_INFINITY,
          label: "Freshness could not be checked",
        },
  };
}
