/**
 * Signal Trader persistence. Server-only. Every table is st_-prefixed and
 * created by ensureSchema (mirrors db/schema.sql), like company_health and
 * mail_sends are created by their consumers.
 *
 * persistSession writes one session in ONE transaction whose first statement
 * claims st_sessions(session). A concurrent run for the same session fails
 * that insert and rolls back everything it would have written.
 */
import { neon } from "@neondatabase/serverless";
import { ST_CONFIG } from "./config";
import type { EngineState, Grade, OpenPosition, PendingPick, SessionOutcome } from "./engine";
import type { SignalName } from "./config";
import type { Bar } from "./types";

function client() {
  if (typeof window !== "undefined") throw new Error("lib/signal-trader/store.ts is server-only.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

const n = (x: unknown) => Number(x);

let schemaReady = false;
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = client();
  await sql`CREATE TABLE IF NOT EXISTS st_sessions (session DATE PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS st_account (id INTEGER PRIMARY KEY CHECK (id = 1), cash DOUBLE PRECISION NOT NULL, paused BOOLEAN NOT NULL DEFAULT false)`;
  await sql`CREATE TABLE IF NOT EXISTS st_signals (session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL, acted BOOLEAN NOT NULL, note TEXT, PRIMARY KEY (session, ticker, signal))`;
  await sql`CREATE TABLE IF NOT EXISTS st_picks (pick_key TEXT PRIMARY KEY, decided_session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, note TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS st_positions (pick_key TEXT PRIMARY KEY REFERENCES st_picks(pick_key), ticker TEXT NOT NULL, signal TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL, entry_price DOUBLE PRECISION NOT NULL, entry_session DATE NOT NULL, stop_price DOUBLE PRECISION NOT NULL, sessions_held INTEGER NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL, close_requested_at TIMESTAMPTZ, status TEXT NOT NULL, exit_price DOUBLE PRECISION, exit_session DATE, exit_reason TEXT, realized_return DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS st_fills (pick_key TEXT NOT NULL, side TEXT NOT NULL, session DATE NOT NULL, qty DOUBLE PRECISION NOT NULL, price DOUBLE PRECISION NOT NULL, note TEXT, PRIMARY KEY (pick_key, side))`;
  await sql`CREATE TABLE IF NOT EXISTS st_marks (pick_key TEXT NOT NULL, session DATE NOT NULL, price DOUBLE PRECISION NOT NULL, PRIMARY KEY (pick_key, session))`;
  await sql`CREATE TABLE IF NOT EXISTS st_grades (pick_key TEXT PRIMARY KEY, signal TEXT NOT NULL, ticker TEXT NOT NULL, entry_session DATE NOT NULL, exit_session DATE NOT NULL, realized_return DOUBLE PRECISION NOT NULL, spy_return DOUBLE PRECISION, excess_return DOUBLE PRECISION, hit BOOLEAN NOT NULL, pnl DOUBLE PRECISION NOT NULL, expected_move DOUBLE PRECISION NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS st_runs (id BIGSERIAL PRIMARY KEY, job TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, status TEXT, note TEXT)`;
  await sql`INSERT INTO st_account (id, cash, paused) VALUES (1, ${ST_CONFIG.sizing.starting_cash}, false) ON CONFLICT (id) DO NOTHING`;
  schemaReady = true;
}

/** Bars for the universe over every stored (settled) session, oldest first. */
export async function loadUniverseBars(tickers: readonly string[]): Promise<Map<string, Bar[]>> {
  const sql = client();
  const rows = (await sql`
    SELECT b.ticker, b.session::text AS session, b.open, b.high, b.low, b.close, b.volume
    FROM daily_bars b JOIN stored_sessions s ON s.session = b.session
    WHERE b.ticker = ANY(${[...tickers]}::text[])
      AND b.open IS NOT NULL AND b.high IS NOT NULL AND b.low IS NOT NULL
    ORDER BY b.ticker, b.session
  `) as { ticker: string; session: string; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown }[];
  const out = new Map<string, Bar[]>();
  for (const r of rows) {
    const bar: Bar = { session: r.session, open: n(r.open), high: n(r.high), low: n(r.low), close: n(r.close), volume: n(r.volume) };
    const list = out.get(r.ticker);
    if (list) list.push(bar);
    else out.set(r.ticker, [bar]);
  }
  return out;
}

export async function storedSessionsAsc(): Promise<string[]> {
  const rows = (await client()`SELECT session::text AS session FROM stored_sessions ORDER BY session`) as { session: string }[];
  return rows.map((r) => r.session);
}

export async function processedSessions(): Promise<Set<string>> {
  await ensureSchema();
  const rows = (await client()`SELECT session::text AS session FROM st_sessions`) as { session: string }[];
  return new Set(rows.map((r) => r.session));
}

export async function loadState(): Promise<EngineState> {
  await ensureSchema();
  const sql = client();
  const [acct] = (await sql`SELECT cash, paused FROM st_account WHERE id = 1`) as { cash: unknown; paused: boolean }[];
  const pending = (await sql`
    SELECT pick_key, ticker, signal, decided_session::text AS decided_session, created_at, window_days, expected_move
    FROM st_picks WHERE status = 'pending' ORDER BY decided_session, pick_key
  `) as { pick_key: string; ticker: string; signal: SignalName; decided_session: string; created_at: Date | string; window_days: unknown; expected_move: unknown }[];
  const open = (await sql`
    SELECT pick_key, ticker, signal, qty, entry_price, entry_session::text AS entry_session, stop_price,
           sessions_held, window_days, expected_move, close_requested_at
    FROM st_positions WHERE status = 'open' ORDER BY entry_session, pick_key
  `) as { pick_key: string; ticker: string; signal: SignalName; qty: unknown; entry_price: unknown; entry_session: string; stop_price: unknown; sessions_held: unknown; window_days: unknown; expected_move: unknown; close_requested_at: Date | string | null }[];
  const iso = (d: Date | string) => new Date(d).toISOString();
  return {
    cash: n(acct.cash),
    paused: acct.paused,
    pending: pending.map((p): PendingPick => ({
      key: p.pick_key, ticker: p.ticker, signal: p.signal, decidedSession: p.decided_session,
      createdAt: iso(p.created_at), windowDays: n(p.window_days), expectedMove: n(p.expected_move),
    })),
    open: open.map((p): OpenPosition => ({
      key: p.pick_key, ticker: p.ticker, signal: p.signal, qty: n(p.qty), entryPrice: n(p.entry_price),
      entrySession: p.entry_session, stopPrice: n(p.stop_price), sessionsHeld: n(p.sessions_held),
      windowDays: n(p.window_days), expectedMove: n(p.expected_move),
      closeRequestedAt: p.close_requested_at ? iso(p.close_requested_at) : null,
    })),
  };
}

/**
 * True when a write failed only because another run already claimed this
 * session in st_sessions -- the Vercel cron and the GitHub backup racing.
 * The session WAS persisted, by the winner; nothing failed.
 */
export function isSessionClaimConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const { code, constraint } = e as Error & { code?: string; constraint?: string };
  return code === "23505" && (constraint === "st_sessions_pkey" || e.message.includes("st_sessions_pkey"));
}

export async function persistSession(o: SessionOutcome, note: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  const q = [
    // First: claim the session. No ON CONFLICT -- a duplicate run must fail here.
    sql`INSERT INTO st_sessions (session, note) VALUES (${o.session}::date, ${note})`,
    // A pick the user cancelled after this run loaded its state must not be
    // filled behind their back. Casting the message to integer raises it as
    // the error, which rolls the whole session back; the retry reloads state.
    ...o.opened.map((p) => sql`
      SELECT CASE WHEN status <> 'pending'
        THEN CAST(('pick ' || pick_key || ' is ' || status || ', not pending: it changed while the job ran') AS integer)
        ELSE 0 END
      FROM st_picks WHERE pick_key = ${p.key}`),
    ...o.newPicks.map((p) => sql`
      INSERT INTO st_picks (pick_key, decided_session, ticker, signal, window_days, expected_move, created_at, status)
      VALUES (${p.key}, ${p.decidedSession}::date, ${p.ticker}, ${p.signal}, ${p.windowDays}, ${p.expectedMove}, ${p.createdAt}::timestamptz, 'pending')`),
    ...o.cancelled.map((c) => sql`UPDATE st_picks SET status = 'cancelled', note = ${c.note} WHERE pick_key = ${c.key}`),
    ...o.opened.map((p) => sql`
      INSERT INTO st_positions (pick_key, ticker, signal, qty, entry_price, entry_session, stop_price, sessions_held, window_days, expected_move, status)
      VALUES (${p.key}, ${p.ticker}, ${p.signal}, ${p.qty}, ${p.entryPrice}, ${p.entrySession}::date, ${p.stopPrice}, 0, ${p.windowDays}, ${p.expectedMove}, 'open')`),
    ...o.opened.map((p) => sql`UPDATE st_picks SET status = 'open' WHERE pick_key = ${p.key}`),
    ...o.fills.map((f) => sql`
      INSERT INTO st_fills (pick_key, side, session, qty, price, note)
      VALUES (${f.key}, ${f.side}, ${f.session}::date, ${f.qty}, ${f.price}, ${f.note})`),
    ...o.marks.map((m) => sql`INSERT INTO st_marks (pick_key, session, price) VALUES (${m.key}, ${m.session}::date, ${m.price})`),
    // qty, entry and stop too: a split restates all three (engine.ts).
    ...o.state.open.map((p) => sql`
      UPDATE st_positions SET sessions_held = ${p.sessionsHeld}, qty = ${p.qty},
        entry_price = ${p.entryPrice}, stop_price = ${p.stopPrice}
      WHERE pick_key = ${p.key}`),
    ...o.exits.map((e) => sql`
      UPDATE st_positions SET status = 'closed', exit_price = ${e.price}, exit_session = ${e.session}::date,
        exit_reason = ${e.reason}, realized_return = ${e.realizedReturn},
        qty = ${e.qty}, entry_price = ${e.entryPrice}
      WHERE pick_key = ${e.key}`),
    ...o.exits.map((e) => sql`UPDATE st_picks SET status = 'closed' WHERE pick_key = ${e.key}`),
    ...o.grades.map((g: Grade) => sql`
      INSERT INTO st_grades (pick_key, signal, ticker, entry_session, exit_session, realized_return, spy_return, excess_return, hit, pnl, expected_move)
      VALUES (${g.key}, ${g.signal}, ${g.ticker}, ${g.entrySession}::date, ${g.exitSession}::date, ${g.realizedReturn},
              ${g.spyReturn}, ${g.excessReturn}, ${g.hit}, ${g.pnl}, ${g.expectedMove})`),
    ...o.signals.map((s) => sql`
      INSERT INTO st_signals (session, ticker, signal, acted, note)
      VALUES (${s.session}::date, ${s.ticker}, ${s.signal}, ${s.acted}, ${s.note})`),
    sql`UPDATE st_account SET cash = ${o.state.cash} WHERE id = 1`,
  ];
  await sql.transaction(q);
}

export async function setPaused(paused: boolean): Promise<void> {
  await ensureSchema();
  await client()`UPDATE st_account SET paused = ${paused} WHERE id = 1`;
}

/** Cancel a pick that has not filled; otherwise ask for a close at the next open. */
export async function requestClose(key: string, now: Date): Promise<"cancelled" | "close_requested" | "not_found"> {
  await ensureSchema();
  const sql = client();
  const cancelled = (await sql`
    UPDATE st_picks SET status = 'cancelled', note = 'cancelled by user before it filled'
    WHERE pick_key = ${key} AND status = 'pending' RETURNING pick_key`) as unknown[];
  if (cancelled.length) return "cancelled";
  const flagged = (await sql`
    UPDATE st_positions SET close_requested_at = ${now.toISOString()}::timestamptz
    WHERE pick_key = ${key} AND status = 'open' AND close_requested_at IS NULL RETURNING pick_key`) as unknown[];
  return flagged.length ? "close_requested" : "not_found";
}

export async function startRun(job: string): Promise<number> {
  await ensureSchema();
  const [r] = (await client()`INSERT INTO st_runs (job) VALUES (${job}) RETURNING id`) as { id: unknown }[];
  return n(r.id);
}

export async function finishRun(id: number, status: "ok" | "error", note: string): Promise<void> {
  await client()`UPDATE st_runs SET finished_at = now(), status = ${status}, note = ${note} WHERE id = ${id}`;
}

// ---- Read helpers for the page ----

export async function readAccount(): Promise<{ cash: number; paused: boolean }> {
  await ensureSchema();
  const [a] = (await client()`SELECT cash, paused FROM st_account WHERE id = 1`) as { cash: unknown; paused: boolean }[];
  return { cash: n(a.cash), paused: a.paused };
}

export interface PickRow {
  key: string; decidedSession: string; ticker: string; signal: SignalName; windowDays: number;
  expectedMove: number; status: string; note: string | null; entrySession: string | null; entryPrice: number | null;
}

export async function readPicks(sinceSession: string): Promise<PickRow[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT p.pick_key, p.decided_session::text AS decided_session, p.ticker, p.signal, p.window_days,
           p.expected_move, p.status, p.note, s.entry_session::text AS entry_session, s.entry_price
    FROM st_picks p LEFT JOIN st_positions s ON s.pick_key = p.pick_key
    WHERE p.decided_session >= ${sinceSession}::date
    ORDER BY p.decided_session DESC, p.ticker`) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: r.pick_key as string, decidedSession: r.decided_session as string, ticker: r.ticker as string,
    signal: r.signal as SignalName, windowDays: n(r.window_days), expectedMove: n(r.expected_move),
    status: r.status as string, note: (r.note as string | null) ?? null,
    entrySession: (r.entry_session as string | null) ?? null,
    entryPrice: r.entry_price == null ? null : n(r.entry_price),
  }));
}

export async function readOpenPositions(): Promise<(OpenPosition & { lastMark: number | null; lastMarkSession: string | null })[]> {
  const state = await loadState();
  const marks = await readLatestMarks();
  return state.open.map((p) => ({ ...p, lastMark: marks.get(p.key)?.price ?? null, lastMarkSession: marks.get(p.key)?.session ?? null }));
}

export async function readLatestMarks(): Promise<Map<string, { price: number; session: string }>> {
  await ensureSchema();
  const rows = (await client()`
    SELECT DISTINCT ON (pick_key) pick_key, session::text AS session, price
    FROM st_marks ORDER BY pick_key, session DESC`) as { pick_key: string; session: string; price: unknown }[];
  return new Map(rows.map((r) => [r.pick_key, { price: n(r.price), session: r.session }]));
}

export async function readGrades(): Promise<Grade[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT pick_key, signal, ticker, entry_session::text AS entry_session, exit_session::text AS exit_session,
           realized_return, spy_return, excess_return, hit, pnl, expected_move
    FROM st_grades ORDER BY exit_session DESC`) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: r.pick_key as string, signal: r.signal as SignalName, ticker: r.ticker as string,
    entrySession: r.entry_session as string, exitSession: r.exit_session as string,
    realizedReturn: n(r.realized_return), spyReturn: r.spy_return == null ? null : n(r.spy_return),
    excessReturn: r.excess_return == null ? null : n(r.excess_return), hit: r.hit as boolean,
    pnl: n(r.pnl), expectedMove: n(r.expected_move),
  }));
}

export async function readRecentSignals(sinceSession: string): Promise<{ session: string; ticker: string; signal: SignalName; acted: boolean; note: string }[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT session::text AS session, ticker, signal, acted, note FROM st_signals
    WHERE session >= ${sinceSession}::date ORDER BY session DESC, ticker`) as { session: string; ticker: string; signal: SignalName; acted: boolean; note: string }[];
  return rows;
}

export async function readLastProcessed(): Promise<string | null> {
  await ensureSchema();
  const [r] = (await client()`SELECT max(session)::text AS s FROM st_sessions`) as { s: string | null }[];
  return r?.s ?? null;
}

export async function readLastRun(job: string): Promise<{ startedAt: string; finishedAt: string | null; status: string | null; note: string | null } | null> {
  await ensureSchema();
  const [r] = (await client()`
    SELECT started_at, finished_at, status, note FROM st_runs WHERE job = ${job}
    ORDER BY started_at DESC LIMIT 1`) as { started_at: Date | string; finished_at: Date | string | null; status: string | null; note: string | null }[];
  if (!r) return null;
  return {
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    status: r.status, note: r.note,
  };
}
