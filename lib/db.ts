/**
 * Neon Postgres access layer. Server-only.
 *
 * Queries go over HTTP against the pooled endpoint rather than a long-lived
 * TCP socket, because each Vercel function instance would otherwise open its
 * own connection and exhaust the Postgres connection limit under concurrency.
 */

import { neon } from "@neondatabase/serverless";
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
 * Close and volume per ticker over the last `window` stored sessions.
 *
 * One query, but SCOPED to the tickers that need it. Neon's HTTP driver caps a
 * response at 64MB, and 200 sessions across ~12,000 tickers is 2.4M rows, which
 * returns HTTP 507. Scoping is also correct on its own terms: only the themed
 * rows are ever scored.
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
