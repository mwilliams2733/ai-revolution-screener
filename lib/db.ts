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
      INSERT INTO daily_bars (session, ticker, open, close, volume, vwap)
      SELECT ${session}::date, * FROM UNNEST(
        ${batch.map((b) => b.T)}::text[],
        ${batch.map((b) => b.o ?? null)}::float8[],
        ${batch.map((b) => b.c)}::float8[],
        ${batch.map((b) => b.v ?? 0)}::float8[],
        ${batch.map((b) => b.vw ?? null)}::float8[]
      ) AS t(ticker, open, close, volume, vwap)
      ON CONFLICT (session, ticker) DO UPDATE SET
        open   = EXCLUDED.open,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume,
        vwap   = EXCLUDED.vwap
    `;
    n += batch.length;
  }
  return n;
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
      INSERT INTO tier_history (session, ticker, rs_pct, vs_ma, tier, weight)
      SELECT ${session}::date, * FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => r.rsPct)}::float8[],
        ${batch.map((r) => r.vsMa)}::float8[],
        ${batch.map((r) => r.tier)}::text[],
        ${batch.map((r) => r.weight)}::float8[]
      ) AS t(ticker, rs_pct, vs_ma, tier, weight)
      ON CONFLICT (session, ticker) DO UPDATE SET
        rs_pct = EXCLUDED.rs_pct,
        vs_ma  = EXCLUDED.vs_ma,
        tier   = EXCLUDED.tier,
        weight = EXCLUDED.weight
    `;
    n += batch.length;
  }
  return n;
}

/**
 * The most recent stored screen BEFORE `session`, as ticker -> tier.
 *
 * Deliberately "the latest session that exists earlier", not "yesterday": after
 * a long weekend or a missed cron run there is no row for yesterday, and
 * comparing against an empty map would report every position as newly changed.
 */
export async function previousTiers(session: string): Promise<Map<string, string>> {
  const sql = client();
  const prev = (await sql`
    SELECT session::text AS session FROM tier_history
    WHERE session < ${session}::date
    ORDER BY session DESC LIMIT 1
  `) as { session: string }[];
  if (prev.length === 0) return new Map();

  const rows = (await sql`
    SELECT ticker, tier FROM tier_history WHERE session = ${prev[0].session}::date
  `) as { ticker: string; tier: string | null }[];
  return new Map(rows.filter((r) => r.tier).map((r) => [r.ticker, r.tier as string]));
}
