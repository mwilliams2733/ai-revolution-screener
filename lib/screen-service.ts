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
  tradingCalendar,
} from "./polygon";
import { barsByTicker } from "./factors";
import { loadCloseHistory, loadOpens, loadSnapshot, storedTradingSessions, tickerNames } from "./db";
import { MA_WINDOW, applyTrueMa, trueMaCount, type MaSource } from "./moving-average";
import { assessStaleness, type StalenessReport } from "./staleness";
import { fundamentalsFor, type Fundamentals } from "./edgar";
import { applyFundamentalOverlay, demotedCount, type OverlaidRow } from "./fundamental-gate";
import { capStrongBuy, cappedCount, type CappedRow } from "./strong-buy-cap";
import { runScreen, DEFAULT_PARAMS } from "./index";
import { exclusionReason, themeUniverse } from "./theme";
import type { AnchorLabel, BarsByTicker, ScreenRow, Snapshots } from "./types";

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
async function loadHistory(): Promise<Map<string, number[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadCloseHistory(MA_WINDOW);
  } catch {
    return new Map();
  }
}

/** How many names may hold the Strong Buy tier at once. */
export const STRONG_BUY_LIMIT = 10;

/** A screen row carrying the day's open alongside the close. */
export interface PricedRow extends CappedRow {
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
  readonly themed: readonly PricedRow[];
  readonly portfolio: readonly ScreenRow[];
  /** How many momentum Strong Buys the fundamental gate moved down. */
  readonly demoted: number;
  /** How many cleared every rule but fell outside the top N. */
  readonly capped: number;
  readonly strongBuyLimit: number;
  /** Theme names held out by the crowding veto, ranked, never silently dropped. */
  readonly vetoed: readonly VetoedRow[];
  readonly meta: {
    readonly namesSource: Source;
    readonly calendarSource: Source;
    readonly dbAvailable: boolean;
    readonly elapsedMs: number;
    /** Names the fundamental gate could actually judge. */
    readonly fundamentalsChecked: number;
    /** Rows whose vsMa is a true rolling mean rather than the proxy. */
    readonly trueMaRows: number;
    readonly maWindow: number;
  };
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
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
 * Fundamentals for the names the gate can actually act on.
 *
 * Only momentum Strong Buys are fetched: the gate exists to tighten the top
 * tier, and pulling EDGAR for all ~104 themed names would triple the wait for
 * data that changes nothing. Results are memoised per server instance.
 *
 * This belongs in the nightly refresh once DATABASE_URL exists — computed once,
 * stored, served instantly. Until then it is an in-memory cache that dies on a
 * cold start, which is why the gate must treat "not fetched" as unverified
 * rather than as a failing grade.
 */
const fundamentalCache = new Map<string, Fundamentals | null>();

async function fundamentalsForCandidates(
  rows: readonly ScreenRow[],
  ciks: ReadonlyMap<string, string>,
): Promise<Map<string, Fundamentals>> {
  const out = new Map<string, Fundamentals>();
  const candidates = rows.filter((r) => r.tier === "Strong Buy");

  // Issue all candidates at once; lib/edgar.ts caps how many are actually in
  // flight, so this respects EDGAR's rate limit without serialising the wait.
  await Promise.all(
    candidates.map(async (r) => {
      if (fundamentalCache.has(r.ticker)) {
        const hit = fundamentalCache.get(r.ticker);
        if (hit) out.set(r.ticker, hit);
        return;
      }
      const cik = ciks.get(r.ticker);
      if (!cik) {
        fundamentalCache.set(r.ticker, null);
        return;
      }
      try {
        const f = await fundamentalsFor(cik);
        fundamentalCache.set(r.ticker, f);
        if (f) out.set(r.ticker, f);
      } catch {
        // A single EDGAR failure must not sink the whole screen.
        fundamentalCache.set(r.ticker, null);
      }
    }),
  );
  return out;
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
  readonly source: Source;
}

let referenceCache: { at: number; value: Reference } | null = null;
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveReference(): Promise<Reference> {
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) {
    return referenceCache.value;
  }

  const refs = await referenceTickers(true);
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

  const value: Reference = { names, ciks, source };
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

  const { names, ciks, source: namesSource } = await resolveReference();

  const { ranked, themed, portfolio, universeSize } = runScreen({
    snapshots: snapshots as unknown as Snapshots,
    names,
  });

  // True moving averages FIRST: they change vsMa, which re-decides the tier,
  // which decides who the fundamental gate and the cap even consider.
  const history = await loadHistory();
  const trended = applyTrueMa(themed, history);

  // Fundamental overlay: tighten Strong Buy without touching the momentum core.
  const fundamentals = await fundamentalsForCandidates(trended, ciks);
  const overlaid = applyFundamentalOverlay(trended, fundamentals);

  // Cap AFTER the gate: the gate removes names that do not deserve the tier on
  // merit, then the cap takes the best of what is left. Reversed, a decelerating
  // name would burn a slot on its way out.
  const limited = capStrongBuy(overlaid, STRONG_BUY_LIMIT);

  const priced: PricedRow[] = limited.map((r) => ({
    ...r,
    open: opens.get(r.ticker) ?? null,
  }));

  return {
    asOf: dates.now as string,
    staleness: assessStaleness(dates.now as string, calendar),
    anchors,
    universeSize,
    themed: priced,
    portfolio,
    demoted: demotedCount(overlaid),
    capped: cappedCount(limited),
    strongBuyLimit: STRONG_BUY_LIMIT,
    vetoed: collectVetoed(ranked, new Set(names.keys())),
    meta: {
      namesSource,
      calendarSource,
      dbAvailable: dbConfigured(),
      elapsedMs: Date.now() - started,
      fundamentalsChecked: fundamentals.size,
      trueMaRows: trueMaCount(trended),
      maWindow: MA_WINDOW,
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
    staleness: assessStaleness(dates.now as string, calendar),
  };
}
