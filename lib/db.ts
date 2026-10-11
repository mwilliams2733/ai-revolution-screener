/**
 * Neon Postgres access layer. Server-only.
 *
 * Queries go over HTTP against the pooled endpoint rather than a long-lived
 * TCP socket, because each Vercel function instance would otherwise open its
 * own connection and exhaust the Postgres connection limit under concurrency.
 */

import { neon } from "@neondatabase/serverless";
import { classify, type SectorLabels } from "./sic";
import type { HealthFacts } from "./health-overlay";
import type { Fundamentals } from "./edgar";
import type { StoredFundamentals } from "./fundamentals-store";
import type { FactPoint } from "./solvency";
import { byTicker, type Split } from "./splits";
import type { Bar, BarsByTicker } from "./types";
import type { PolygonBar, TickerRefLike } from "./db-types";

function client() {
  if (typeof window !== "undefined") {
    throw new Error("lib/db.ts is server-only.");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

/** Rows-per-statement for bulk inserts. Keeps each HTTP body well under limits. */
const CHUNK = 1_000;

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------------------
// Reference universe
// ---------------------------------------------------------------------------

/** Upsert reference rows. Delisted names are kept deliberately. */
export async function upsertTickers(refs: readonly TickerRefLike[]): Promise<number> {
  const sql = client();
  let n = 0;
  for (const batch of chunk(refs, CHUNK)) {
    await sql`
      INSERT INTO tickers (ticker, name, primary_exchange, cik, active, delisted_utc, updated_at)
      SELECT * FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => r.name)}::text[],
        ${batch.map((r) => r.primaryExchange)}::text[],
        ${batch.map((r) => r.cik)}::bpchar[],
        ${batch.map((r) => r.active)}::boolean[],
        ${batch.map((r) => r.delistedUtc)}::timestamptz[]
      ) AS t(ticker, name, primary_exchange, cik, active, delisted_utc),
      LATERAL (SELECT now()) AS u(updated_at)
      ON CONFLICT (ticker) DO UPDATE SET
        name             = EXCLUDED.name,
        primary_exchange = EXCLUDED.primary_exchange,
        cik              = COALESCE(EXCLUDED.cik, tickers.cik),
        active           = EXCLUDED.active,
        delisted_utc     = EXCLUDED.delisted_utc,
        updated_at       = now()
    `;
    n += batch.length;
  }
  return n;
}

/** ticker -> company name, for display. */
export async function tickerNames(): Promise<Map<string, string>> {
  const sql = client();
  const rows = (await sql`SELECT ticker, name FROM tickers`) as { ticker: string; name: string }[];
  return new Map(rows.map((r) => [r.ticker, r.name]));
}

/**
 * Cached EDGAR balance-sheet facts, as ticker -> facts.
 *
 * Facts, not verdicts. Thresholds are policy and will be tuned; deriving the
 * judgment at read time means moving one costs a re-render rather than
 * re-fetching 4,300 filings.
 */
export async function companyHealth(): Promise<Map<string, HealthFacts>> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, shares, cash, ocf, revenue FROM company_health
  `) as {
    ticker: string;
    shares: FactPoint[] | null;
    cash: number | null;
    ocf: FactPoint[] | null;
    revenue: number | null;
  }[];
  return new Map(
    rows.map((r) => [
      r.ticker,
      { shares: r.shares ?? [], cash: r.cash, ocf: r.ocf ?? [], revenue: r.revenue },
    ]),
  );
}

/**
 * Split history, as ticker -> splits oldest first.
 *
 * Required before any year-on-year share-count comparison: cover-page counts
 * are never restated, so a 10-for-1 reads as +900% dilution.
 */
/** Upsert splits (same table and conflict rule as scripts/splits.ts). */
export async function upsertSplits(rows: readonly Split[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS splits (
      ticker         TEXT NOT NULL,
      execution_date DATE NOT NULL,
      split_from     DOUBLE PRECISION NOT NULL,
      split_to       DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (ticker, execution_date)
    )
  `;
  await sql`
    INSERT INTO splits (ticker, execution_date, split_from, split_to)
    SELECT * FROM UNNEST(
      ${rows.map((s) => s.ticker)}::text[],
      ${rows.map((s) => s.executionDate)}::date[],
      ${rows.map((s) => s.from)}::float8[],
      ${rows.map((s) => s.to)}::float8[]
    ) AS t(ticker, execution_date, split_from, split_to)
    ON CONFLICT (ticker, execution_date) DO UPDATE SET
      split_from = EXCLUDED.split_from, split_to = EXCLUDED.split_to
  `;
  return rows.length;
}

export async function splitHistory(): Promise<Map<string, Split[]>> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, execution_date::text AS execution_date, split_from, split_to FROM splits
  `) as { ticker: string; execution_date: string; split_from: number; split_to: number }[];
  return byTicker(
    rows.map((r) => ({
      ticker: r.ticker,
      executionDate: r.execution_date,
      from: Number(r.split_from),
      to: Number(r.split_to),
    })),
  );
}

/**
 * Median dollar volume over the last `sessions` sessions, as ticker -> value.
 *
 * The screen's own gate reads TODAY's dollar volume, a single bar -- which is
 * exactly what a pump-and-dump passes, since the whole category is defined by
 * episodic volume. A median over fifty sessions asks whether the liquidity is
 * actually there, which is the question the gate was always meant to ask.
 */
export async function medianDollarVolume(sessions: number): Promise<Map<string, number>> {
  const sql = client();
  const rows = (await sql`
    WITH recent AS (
      SELECT session FROM stored_sessions ORDER BY session DESC LIMIT ${sessions}
    )
    SELECT b.ticker,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY b.close * b.volume) AS med
    FROM daily_bars b
    WHERE b.session >= (SELECT min(session) FROM recent)
    GROUP BY b.ticker
  `) as { ticker: string; med: number }[];
  return new Map(rows.map((r) => [r.ticker, Number(r.med)]));
}

/**
 * SIC classification for every ticker that has one, as ticker -> labels.
 *
 * Only rows with a non-empty code are returned. A filer with no SIC and a
 * ticker never fetched are both absent, and the caller renders both as "Other"
 * -- the distinction matters to scripts/sectors.ts, which uses it to know what
 * is left to do, and to nobody downstream of here.
 */
export async function tickerSectors(): Promise<Map<string, SectorLabels>> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, sic, sic_description FROM tickers
    WHERE sic IS NOT NULL AND sic <> ''
  `) as { ticker: string; sic: string; sic_description: string | null }[];
  return new Map(rows.map((r) => [r.ticker, classify(r.sic, r.sic_description)]));
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/** Insert one session's bars. Idempotent: re-running a session overwrites it. */
export async function insertBars(session: string, bars: readonly PolygonBar[]): Promise<number> {
  const sql = client();
  const usable = bars.filter((b) => b?.T && Number.isFinite(b.c));
  let n = 0;
  for (const batch of chunk(usable, CHUNK)) {
    await sql`
      INSERT INTO daily_bars (session, ticker, open, high, low, close, volume, vwap)
      SELECT ${session}::date, * FROM UNNEST(
        ${batch.map((b) => b.T)}::text[],
        ${batch.map((b) => b.o ?? null)}::float8[],
        ${batch.map((b) => b.h ?? null)}::float8[],
        ${batch.map((b) => b.l ?? null)}::float8[],
        ${batch.map((b) => b.c)}::float8[],
        ${batch.map((b) => b.v ?? 0)}::float8[],
        ${batch.map((b) => b.vw ?? null)}::float8[]
      ) AS t(ticker, open, high, low, close, volume, vwap)
      ON CONFLICT (session, ticker) DO UPDATE SET
        open   = EXCLUDED.open,
        high   = EXCLUDED.high,
        low    = EXCLUDED.low,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume,
        vwap   = EXCLUDED.vwap
    `;
    n += batch.length;
  }
  return n;
}

/**
 * Replace one ticker's stored bars across many sessions.
 *
 * Used to repair a series stranded by a split. Only sessions we already track
 * are written: a re-fetch must not quietly widen the stored calendar, which
 * would leave one ticker with sessions no other name has and make every
 * positional lookback off by one for it.
 */
export async function replaceTickerBars(
  ticker: string,
  bars: readonly { session: string; o?: number; h?: number; l?: number; c: number; v?: number; vw?: number }[],
): Promise<number> {
  if (bars.length === 0) return 0;
  const sql = client();
  let n = 0;
  for (const batch of chunk(bars, CHUNK)) {
    await sql`
      INSERT INTO daily_bars (session, ticker, open, high, low, close, volume, vwap)
      SELECT t.session, ${ticker}, t.open, t.high, t.low, t.close, t.volume, t.vwap
      FROM UNNEST(
        ${batch.map((b) => b.session)}::date[],
        ${batch.map((b) => b.o ?? null)}::float8[],
        ${batch.map((b) => b.h ?? null)}::float8[],
        ${batch.map((b) => b.l ?? null)}::float8[],
        ${batch.map((b) => b.c)}::float8[],
        ${batch.map((b) => b.v ?? 0)}::float8[],
        ${batch.map((b) => b.vw ?? null)}::float8[]
      ) AS t(session, open, high, low, close, volume, vwap)
      WHERE EXISTS (SELECT 1 FROM stored_sessions s WHERE s.session = t.session)
      ON CONFLICT (session, ticker) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        close = EXCLUDED.close, volume = EXCLUDED.volume, vwap = EXCLUDED.vwap
    `;
    n += batch.length;
  }
  return n;
}

/** Splits already repaired, as "TICKER|YYYY-MM-DD" keys. */
export async function handledSplits(): Promise<Set<string>> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, execution_date::text AS execution_date FROM split_refetch
  `) as { ticker: string; execution_date: string }[];
  return new Set(rows.map((r) => `${r.ticker}|${r.execution_date}`));
}

/** Record splits whose history has been re-fetched. */
export async function markSplitsHandled(
  splits: readonly { ticker: string; executionDate: string }[],
): Promise<void> {
  if (splits.length === 0) return;
  const sql = client();
  await sql`
    INSERT INTO split_refetch (ticker, execution_date)
    SELECT * FROM UNNEST(
      ${splits.map((s) => s.ticker)}::text[],
      ${splits.map((s) => s.executionDate)}::date[]
    ) AS t(ticker, execution_date)
    ON CONFLICT (ticker, execution_date) DO NOTHING
  `;
}

/** Oldest and newest stored session, bounding any repair. */
export async function storedCalendarBounds(): Promise<{ lo: string; hi: string }> {
  const sql = client();
  const rows = (await sql`
    SELECT min(session)::text AS lo, max(session)::text AS hi FROM stored_sessions
  `) as { lo: string | null; hi: string | null }[];
  return { lo: rows[0]?.lo ?? "", hi: rows[0]?.hi ?? "" };
}

/** Tickers we store any bars for. */
export async function tickersWithBars(): Promise<Set<string>> {
  const sql = client();
  const rows = (await sql`SELECT DISTINCT ticker FROM daily_bars`) as { ticker: string }[];
  return new Set(rows.map((r) => r.ticker));
}

/**
 * Daily closes per ticker over the last `window` stored sessions, oldest first.
 *
 * One query for the whole universe rather than one per ticker: 2,200 round
 * trips to build moving averages would be the same per-ticker mistake the
 * grouped-daily endpoint exists to avoid.
 */
export async function loadCloseHistory(
  window: number,
  tickers: readonly string[],
): Promise<Map<string, number[]>> {
  if (tickers.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    WITH recent AS (
      SELECT session FROM stored_sessions ORDER BY session DESC LIMIT ${window}
    )
    SELECT b.ticker, b.session::text AS session, b.close
    FROM daily_bars b
    JOIN recent r ON r.session = b.session
    WHERE b.ticker = ANY(${[...tickers]}::text[])
    ORDER BY b.ticker, b.session ASC
  `) as { ticker: string; session: string; close: number }[];

  const out = new Map<string, number[]>();
  for (const r of rows) {
    const list = out.get(r.ticker);
    if (list) list.push(Number(r.close));
    else out.set(r.ticker, [Number(r.close)]);
  }
  return out;
}

/**
 * Close and volume for EVERY ticker over the last `window` stored sessions.
 *
 * Deliberately unscoped: volume metrics grade a name against the full ranked
 * universe, not the theme (see the applyVolume call in lib/screen-service.ts),
 * so every ticker's bars are needed. Size is bounded by `window`, not by a
 * ticker list: about 51 sessions across ~12,000 names is ~600k rows, well under
 * Neon's 64MB HTTP response cap. Widening `window` toward 200 would cross it
 * (2.4M rows returned HTTP 507 when that was tried) -- scope by ticker first.
 */
export async function loadVolumeHistory(
  window: number,
): Promise<Map<string, { close: number; volume: number }[]>> {
  const sql = client();
  const rows = (await sql`
    WITH recent AS (
      SELECT session FROM stored_sessions ORDER BY session DESC LIMIT ${window}
    )
    SELECT b.ticker, b.close, b.volume
    FROM daily_bars b
    JOIN recent r ON r.session = b.session
    ORDER BY b.ticker, b.session ASC
  `) as { ticker: string; close: number; volume: number }[];

  const out = new Map<string, { close: number; volume: number }[]>();
  for (const r of rows) {
    const bar = { close: Number(r.close), volume: Number(r.volume) };
    const list = out.get(r.ticker);
    if (list) list.push(bar);
    else out.set(r.ticker, [bar]);
  }
  return out;
}

/**
 * Close, high and low per ticker over the last `window` stored sessions.
 *
 * The trend template needs intraday extremes for the 52-week range, which
 * closes cannot supply, plus 222 sessions for the 200d MA and its slope test.
 */
export async function loadTrendHistory(
  window: number,
  tickers: readonly string[],
): Promise<Map<string, { close: number; high: number; low: number }[]>> {
  if (tickers.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    WITH recent AS (
      SELECT session FROM stored_sessions ORDER BY session DESC LIMIT ${window}
    )
    SELECT b.ticker, b.close, b.high, b.low
    FROM daily_bars b
    JOIN recent r ON r.session = b.session
    WHERE b.high IS NOT NULL AND b.low IS NOT NULL
      AND b.ticker = ANY(${[...tickers]}::text[])
    ORDER BY b.ticker, b.session ASC
  `) as { ticker: string; close: number; high: number; low: number }[];

  const out = new Map<string, { close: number; high: number; low: number }[]>();
  for (const r of rows) {
    const bar = { close: Number(r.close), high: Number(r.high), low: Number(r.low) };
    const list = out.get(r.ticker);
    if (list) list.push(bar);
    else out.set(r.ticker, [bar]);
  }
  return out;
}

/** Open prices for one stored session, ticker -> open. */
export async function loadOpens(session: string): Promise<Map<string, number>> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, open FROM daily_bars
    WHERE session = ${session}::date AND open IS NOT NULL
  `) as { ticker: string; open: number }[];
  return new Map(rows.map((r) => [r.ticker, Number(r.open)]));
}

/** One stored session as the lookup shape the screen consumes. */
export async function loadSnapshot(session: string): Promise<BarsByTicker> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, close, volume, vwap FROM daily_bars WHERE session = ${session}::date
  `) as { ticker: string; close: number; volume: number; vwap: number | null }[];

  const m = new Map<string, Bar>();
  for (const r of rows) {
    m.set(r.ticker, {
      ticker: r.ticker,
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
      vwap: Number(r.vwap ?? r.close),
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Session ledger
// ---------------------------------------------------------------------------

export async function recordSession(
  session: string,
  barCount: number,
  isTrading: boolean,
): Promise<void> {
  const sql = client();
  await sql`
    INSERT INTO sessions (session, bar_count, is_trading, fetched_at)
    VALUES (${session}::date, ${barCount}, ${isTrading}, now())
    ON CONFLICT (session) DO UPDATE SET
      bar_count  = EXCLUDED.bar_count,
      is_trading = EXCLUDED.is_trading,
      fetched_at = now()
  `;
}

/**
 * Which candidate dates still need fetching.
 *
 * Deliberately set-based, not a high-water mark. Any date already recorded is
 * skipped whether it turned out to be a trading session or a holiday, so an
 * interrupted backfill resumes correctly even when its gaps are not a
 * contiguous prefix.
 */
export async function missingSessions(candidates: readonly string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const sql = client();
  const rows = (await sql`
    SELECT session::text AS session FROM sessions
    WHERE session = ANY(${[...candidates]}::date[])
  `) as { session: string }[];
  const known = new Set(rows.map((r) => r.session));
  return candidates.filter((d) => !known.has(d));
}

/**
 * When each candidate session was last fetched, for those in the ledger.
 *
 * The refresh uses this with sessionsNeedingFetch() to re-fetch any session
 * stored before it settled. Presence alone is not enough: from 2026-08-31 to
 * 2026-09-23 every stored session was a mid-morning snapshot.
 */
export async function sessionFetchTimes(candidates: readonly string[]): Promise<Map<string, Date>> {
  if (candidates.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    SELECT session::text AS session, fetched_at FROM sessions
    WHERE session = ANY(${[...candidates]}::date[]) AND is_trading
  `) as { session: string; fetched_at: string }[];
  return new Map(rows.map((r) => [r.session, new Date(r.fetched_at)]));
}

/** Trading sessions with bars, newest first. Drives anchor selection. */
export async function storedTradingSessions(): Promise<string[]> {
  const sql = client();
  const rows = (await sql`
    SELECT session::text AS session FROM stored_sessions ORDER BY session DESC
  `) as { session: string }[];
  return rows.map((r) => r.session);
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export async function startRun(kind: string): Promise<number> {
  const sql = client();
  const rows = (await sql`
    INSERT INTO refresh_runs (kind) VALUES (${kind}) RETURNING id
  `) as { id: number }[];
  return Number(rows[0].id);
}

export async function finishRun(
  id: number,
  sessionsAdded: number,
  barsAdded: number,
  ok: boolean,
  error?: string,
): Promise<void> {
  const sql = client();
  await sql`
    UPDATE refresh_runs SET
      finished_at    = now(),
      sessions_added = ${sessionsAdded},
      bars_added     = ${barsAdded},
      ok             = ${ok},
      error          = ${error ?? null}
    WHERE id = ${id}
  `;
}

/**
 * The most recent run, whatever its outcome.
 *
 * Deliberately NOT "the most recent successful run". A failed or half-finished
 * run is the thing worth surfacing, and filtering to ok = true would quietly
 * show the last good check while the pipeline had been failing for days --
 * which is the exact silent failure the stamp exists to expose.
 */
export async function lastRefresh(): Promise<{
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  kind: string;
  sessionsAdded: number;
  barsAdded: number;
} | null> {
  const sql = client();
  const rows = (await sql`
    SELECT started_at, finished_at, ok, kind, sessions_added, bars_added
    FROM refresh_runs
    ORDER BY started_at DESC
    LIMIT 1
  `) as {
    started_at: string;
    finished_at: string | null;
    ok: boolean | null;
    kind: string;
    sessions_added: number;
    bars_added: number;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    ok: r.ok,
    kind: r.kind,
    sessionsAdded: Number(r.sessions_added),
    barsAdded: Number(r.bars_added),
  };
}

// ---------------------------------------------------------------------------
// Cohort history
// ---------------------------------------------------------------------------

/**
 * Sessions a cohort can honestly be shown for: LIVE only.
 *
 * A replayed session was reconstructed under a different ruleset -- no
 * fundamental gate, today's theme map, a universe pruned with hindsight -- so
 * its "top 10" never existed. Offering it in a date picker would present
 * fiction wearing a date, which is worse than offering nothing, so replayed
 * sessions are excluded here rather than filtered in the UI.
 */
export async function liveSessions(): Promise<string[]> {
  const sql = client();
  const rows = (await sql`
    SELECT session::text AS session
    FROM tier_history
    WHERE source = 'live'
    GROUP BY session
    ORDER BY session DESC
  `) as { session: string }[];
  return rows.map((r) => r.session);
}

/**
 * One session's cohort: the Strong Buys, plus every themed name that day.
 *
 * Both are needed together. The cohort's absolute return is close to
 * meaningless on its own -- every live cohort so far is NEGATIVE while the
 * theme fell further, which is the signal working, not failing -- so the theme
 * is read from the same snapshot rather than reconstructed later.
 */
export async function cohortAt(session: string): Promise<{
  top: { ticker: string; rsPct: number | null }[];
  themed: string[];
}> {
  const sql = client();
  const rows = (await sql`
    SELECT ticker, rs_pct, tier
    FROM tier_history
    WHERE session = ${session}::date AND source = 'live'
    ORDER BY rs_pct DESC NULLS LAST, ticker
  `) as { ticker: string; rs_pct: number | null; tier: string | null }[];
  return {
    top: rows
      .filter((r) => r.tier === "Strong Buy")
      .map((r) => ({ ticker: r.ticker, rsPct: r.rs_pct == null ? null : Number(r.rs_pct) })),
    themed: rows.map((r) => r.ticker),
  };
}

/** Closes for a set of tickers on one session. */
export async function closesOn(
  session: string,
  tickers: readonly string[],
): Promise<Map<string, number | null>> {
  if (tickers.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    SELECT ticker, close
    FROM daily_bars
    WHERE session = ${session}::date AND ticker = ANY(${tickers as string[]})
  `) as { ticker: string; close: number }[];
  return new Map(rows.map((r) => [r.ticker, Number(r.close)]));
}

/**
 * One ticker's full stored price history, plus its LIVE tier changes.
 *
 * Prices span everything -- they are real regardless of which ruleset produced
 * a tier that day. Tier markers do not: a replayed tier badge drawn on a chart
 * is the same fiction as a replayed cohort, so only live rows are returned.
 */
export async function tickerTrend(ticker: string): Promise<{
  bars: { session: string; close: number }[];
  tiers: { session: string; tier: string | null; rsPct: number | null }[];
}> {
  const sql = client();
  const [barRows, tierRows] = await Promise.all([
    sql`
      SELECT session::text AS session, close
      FROM daily_bars WHERE ticker = ${ticker}
      ORDER BY session ASC
    `,
    sql`
      SELECT session::text AS session, tier, rs_pct
      FROM tier_history WHERE ticker = ${ticker} AND source = 'live'
      ORDER BY session ASC
    `,
  ]);
  const bars = barRows as { session: string; close: number }[];
  const tiers = tierRows as { session: string; tier: string | null; rs_pct: number | null }[];
  return {
    bars: bars.map((b) => ({ session: b.session, close: Number(b.close) })),
    tiers: tiers.map((t) => ({
      session: t.session,
      tier: t.tier,
      rsPct: t.rs_pct == null ? null : Number(t.rs_pct),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tier history
// ---------------------------------------------------------------------------

export interface TierRow {
  readonly ticker: string;
  readonly rsPct: number | null;
  readonly vsMa: number;
  readonly tier: string | null;
  /** Tier before the demoting overlays; what hysteresis compares against. */
  readonly momentumTier?: string | null;
  readonly weight: number;
}

/** Snapshot one screen run so tier CHANGES can be diffed later. */
export async function upsertTierHistory(
  session: string,
  rows: readonly TierRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = client();
  let n = 0;
  for (const batch of chunk(rows, CHUNK)) {
    await sql`
      INSERT INTO tier_history (session, ticker, rs_pct, vs_ma, tier, momentum_tier, weight, source)
      SELECT ${session}::date, *, 'live' FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => r.rsPct)}::float8[],
        ${batch.map((r) => r.vsMa)}::float8[],
        ${batch.map((r) => r.tier)}::text[],
        ${batch.map((r) => r.momentumTier ?? null)}::text[],
        ${batch.map((r) => r.weight)}::float8[]
      ) AS t(ticker, rs_pct, vs_ma, tier, momentum_tier, weight)
      ON CONFLICT (session, ticker) DO UPDATE SET
        rs_pct        = EXCLUDED.rs_pct,
        vs_ma         = EXCLUDED.vs_ma,
        tier          = EXCLUDED.tier,
        momentum_tier = EXCLUDED.momentum_tier,
        weight        = EXCLUDED.weight,
        -- A live row promotes a replayed one. The refresh has better
        -- information than any reconstruction of the same day.
        source        = 'live'
    `;
    n += batch.length;
  }
  return n;
}

/**
 * Tier history over the last `days` recorded sessions.
 *
 * Bounded by session count rather than by date so a gap in the cron does not
 * silently shrink the window: thirty recorded sessions is thirty data points
 * whether they span six weeks or six months.
 */
export async function loadTierHistory(days: number): Promise<
  { session: string; ticker: string; tier: string | null }[]
> {
  const sql = client();
  const rows = (await sql`
    WITH recent AS (
      SELECT DISTINCT session FROM tier_history ORDER BY session DESC LIMIT ${days}
    )
    SELECT h.session::text AS session, h.ticker, h.tier
    FROM tier_history h
    JOIN recent r ON r.session = h.session
    ORDER BY h.session ASC, h.ticker ASC
  `) as { session: string; ticker: string; tier: string | null }[];
  return rows;
}

/** How a stored tier row was produced. See db/schema.sql. */
export type TierSource = "live" | "replay";

export interface TierSnapshot {
  readonly session: string;
  /**
   * Provenance of the snapshot as a whole.
   *
   * A session counts as "live" only when EVERY row in it is live. A part-live
   * session means a replay overwrote some of it or a refresh died halfway, and
   * either way it is not sound evidence to diff against.
   */
  readonly source: TierSource;
  readonly tiers: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Stored fundamentals
// ---------------------------------------------------------------------------

/** Created by its consumer, like company_health and mail_sends. */
async function ensureFundamentalsTable(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS company_fundamentals (
      ticker     TEXT PRIMARY KEY,
      facts      JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/** Every stored row. A few thousand small JSON objects, well under the response cap. */
export async function loadStoredFundamentals(): Promise<Map<string, StoredFundamentals>> {
  await ensureFundamentalsTable();
  const sql = client();
  const rows = (await sql`
    SELECT ticker, facts, fetched_at::text AS fetched_at FROM company_fundamentals
  `) as { ticker: string; facts: Fundamentals | null; fetched_at: string }[];
  return new Map(rows.map((r) => [r.ticker, { facts: r.facts, fetchedAt: r.fetched_at }]));
}

/** Store fetched facts. Null facts record "no usable SEC data" so it is not re-fetched nightly. */
export async function upsertFundamentals(
  rows: readonly { ticker: string; facts: Fundamentals | null }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureFundamentalsTable();
  const sql = client();
  let n = 0;
  for (const batch of chunk(rows, CHUNK)) {
    await sql`
      INSERT INTO company_fundamentals (ticker, facts, fetched_at)
      SELECT t.ticker, t.facts, now() FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => (r.facts == null ? null : JSON.stringify(r.facts)))}::jsonb[]
      ) AS t(ticker, facts)
      ON CONFLICT (ticker) DO UPDATE SET facts = EXCLUDED.facts, fetched_at = now()
    `;
    n += batch.length;
  }
  return n;
}

/** ticker -> CIK for the given tickers, from the reference table. */
export async function ciksFor(tickers: readonly string[]): Promise<Map<string, string>> {
  if (tickers.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    SELECT ticker, cik FROM tickers
    WHERE ticker = ANY(${[...tickers]}::text[]) AND cik IS NOT NULL
  `) as { ticker: string; cik: string }[];
  return new Map(rows.map((r) => [r.ticker, String(r.cik).trim()]));
}

/**
 * The most recent stored screen BEFORE `session`, with its provenance.
 *
 * Deliberately "the latest session that exists earlier", not "yesterday": after
 * a long weekend or a missed cron run there is no row for yesterday, and
 * comparing against an empty map would report every position as newly changed.
 *
 * Returns null when there is nothing earlier at all, which the caller must
 * treat as "record silently" rather than as "everything changed".
 */
export async function previousTiers(session: string): Promise<TierSnapshot | null> {
  const sql = client();
  const prev = (await sql`
    SELECT session::text AS session,
           bool_and(source = 'live') AS all_live
    FROM tier_history
    WHERE session < ${session}::date
    GROUP BY session
    ORDER BY session DESC LIMIT 1
  `) as { session: string; all_live: boolean }[];
  if (prev.length === 0) return null;

  const rows = (await sql`
    SELECT ticker, tier FROM tier_history WHERE session = ${prev[0].session}::date
  `) as { ticker: string; tier: string | null }[];

  return {
    session: prev[0].session,
    source: prev[0].all_live ? "live" : "replay",
    tiers: new Map(rows.filter((r) => r.tier).map((r) => [r.ticker, r.tier as string])),
  };
}

/**
 * The previous session's PRE-overlay tiers, for hysteresis.
 *
 * Falls back to the final tier on rows written before momentum_tier existed, so
 * the band still works over reconstructed history rather than silently doing
 * nothing for the first thirty sessions.
 */
export async function previousMomentumTiers(session: string): Promise<Map<string, string>> {
  const sql = client();
  const prev = (await sql`
    SELECT session::text AS session FROM tier_history
    WHERE session < ${session}::date
    ORDER BY session DESC LIMIT 1
  `) as { session: string }[];
  if (prev.length === 0) return new Map();

  const rows = (await sql`
    SELECT ticker, COALESCE(momentum_tier, tier) AS tier
    FROM tier_history WHERE session = ${prev[0].session}::date
  `) as { ticker: string; tier: string | null }[];
  return new Map(rows.filter((r) => r.tier).map((r) => [r.ticker, r.tier as string]));
}

/**
 * Band tiers for the names OUTSIDE the book, from the same prior session
 * previousMomentumTiers reads.
 *
 * Separate from previousMomentumTiers on purpose: the caller catches each one
 * on its own, so a failure here costs non-book names one night of band memory
 * and can never empty the book's.
 */
export async function previousMarketBandTiers(session: string): Promise<Map<string, string>> {
  const sql = client();
  const prev = (await sql`
    SELECT session::text AS session FROM tier_history
    WHERE session < ${session}::date
    ORDER BY session DESC LIMIT 1
  `) as { session: string }[];
  if (prev.length === 0) return new Map();

  await ensureMarketBandTiers();
  const rows = (await sql`
    SELECT ticker, band_tier FROM market_band_tiers WHERE session = ${prev[0].session}::date
  `) as { ticker: string; band_tier: string | null }[];
  return new Map(rows.filter((r) => r.band_tier).map((r) => [r.ticker, r.band_tier as string]));
}

// ---------------------------------------------------------------------------
// Market band tiers
// ---------------------------------------------------------------------------

/** Sessions of band memory kept. Hysteresis only ever reads the previous one. */
export const MARKET_BAND_KEEP_SESSIONS = 10;

async function ensureMarketBandTiers(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS market_band_tiers (
      session   DATE NOT NULL,
      ticker    TEXT NOT NULL,
      band_tier TEXT,
      PRIMARY KEY (session, ticker)
    )
  `;
}

/**
 * Record each non-book name's band tier for tomorrow's hysteresis, then prune.
 * Never touches tier_history.
 */
export async function upsertMarketBandTiers(
  session: string,
  rows: readonly { ticker: string; bandTier: string | null }[],
): Promise<number> {
  await ensureMarketBandTiers();
  const sql = client();
  let n = 0;
  for (const batch of chunk(rows, CHUNK)) {
    await sql`
      INSERT INTO market_band_tiers (session, ticker, band_tier)
      SELECT ${session}::date, * FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => r.bandTier)}::text[]
      ) AS t(ticker, band_tier)
      ON CONFLICT (session, ticker) DO UPDATE SET band_tier = EXCLUDED.band_tier
    `;
    n += batch.length;
  }
  await sql`
    DELETE FROM market_band_tiers WHERE session < (
      SELECT min(session) FROM (
        SELECT DISTINCT session FROM market_band_tiers
        ORDER BY session DESC LIMIT ${MARKET_BAND_KEEP_SESSIONS}
      ) recent
    )
  `;
  return n;
}

// ---------------------------------------------------------------------------
// Mail send ledger
// ---------------------------------------------------------------------------

/**
 * Create the ledger if absent. Cheap and idempotent, matching how splits,
 * split_refetch and company_health are created by their consumers.
 */
async function ensureMailLedger(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS mail_sends (
      kind       TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, dedupe_key)
    )
  `;
}

/**
 * Try to claim a message key. True means this caller owns delivery.
 *
 * The claim is one atomic INSERT, so two schedulers arriving inside the same
 * few seconds cannot both win: the second sees a conflict and skips. The
 * earlier check-then-record design left the whole SMTP round trip as a
 * window in which both callers had checked and neither had recorded.
 *
 * Returns true when there is no database: without one we cannot know, and a
 * possible duplicate is a far smaller harm than suppressing the only email
 * that would have told you the pipeline is alive.
 */
export async function claimMailSend(kind: string, dedupeKey: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return true;
  await ensureMailLedger();
  const sql = client();
  const rows = (await sql`
    INSERT INTO mail_sends (kind, dedupe_key) VALUES (${kind}, ${dedupeKey})
    ON CONFLICT (kind, dedupe_key) DO NOTHING
    RETURNING 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Give a claim back after a failed send, so a later caller can retry.
 *
 * This is what keeps claim-first from being at-most-once delivery: a send
 * that fails releases its key and the next scheduler sends normally. The
 * only way a key stays claimed without an email is the process dying
 * between claim and release; delete that row by hand (a `mail-ledger forget`
 * script is planned for exactly this).
 */
export async function releaseMailSend(kind: string, dedupeKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const sql = client();
  await sql`DELETE FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${dedupeKey}`;
}

/**
 * Has this key been claimed? Read-only, for the schedulers' status probe.
 *
 * False when there is no database. A query error is thrown, not read as
 * either answer: the probe then fails, and the workflow treats a failed probe
 * as "not done" and calls the route, which decides for itself.
 */
export async function mailSent(kind: string, dedupeKey: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const sql = client();
  const rows = (await sql`
    SELECT 1 FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${dedupeKey} LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/** Does tier_history hold a live snapshot for this session? */
export async function hasLiveSnapshot(session: string): Promise<boolean> {
  const sql = client();
  const rows = (await sql`
    SELECT 1 FROM tier_history WHERE session = ${session}::date AND source = 'live' LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}
