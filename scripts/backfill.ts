/**
 * One-off historical backfill.
 *
 * Run locally, not as a route: 250 sessions will not finish inside a Vercel
 * function timeout. The nightly refresh route reuses the same functions for
 * the one-session case.
 *
 *   npm run backfill              # 250 trading sessions
 *   npm run backfill -- --limit 5 # small trial
 *   npm run backfill -- --sessions 250 --dry
 *
 * Safe to interrupt and re-run. Work is computed as
 * (candidate dates) MINUS (dates already in the sessions ledger), so a resumed
 * run fills whatever is actually missing rather than assuming the completed
 * work forms a contiguous prefix.
 */

import { groupedDaily, tradingCalendar, fullUniverse } from "../lib/polygon";
import { classifySession, sessionsToFetch } from "../lib/session-ledger";
import { neon } from "@neondatabase/serverless";
import { isoDaysAgo } from "../lib/dates";
import {
  upsertTickers,
  insertBars,
  recordSession,
  storedTradingSessions,
  startRun,
  finishRun,
} from "../lib/db";


function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const TARGET_SESSIONS = Number(arg("sessions", "250"));
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const DRY = has("dry");
const SKIP_TICKERS = has("skip-tickers");

/**
 * Restrict stored bars to the tickers already tracked.
 *
 * Storing all ~12,000 names costs 2.0 MB per session, of which ~82% are
 * sub-$5 shells that can never appear on the screen. Restricting to names that
 * have been meaningfully liquid drops that to 0.7 MB and keeps a 500-session
 * history inside Neon's free tier.
 *
 * Recoverable: grouped-daily serves any past date, so widening later costs a
 * re-run rather than the data.
 */
const LIQUID_ONLY = has("liquid-only");
/** Courtesy pause between grouped calls. */
const THROTTLE_MS = Number(arg("throttle", "120"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const started = Date.now();

  // Work list comes from the REAL trading calendar, not from weekday arithmetic.
  // A weekday list includes today before the market has opened, and fetching it
  // returns an empty response that used to be recorded as a holiday. See H1 in
  // lib/session-ledger.ts.
  const lookbackDays = Math.ceil(TARGET_SESSIONS * 1.5) + 30;
  const calendar = await tradingCalendar(isoDaysAgo(lookbackDays), isoDaysAgo(0));

  if (DRY) {
    console.log(`[dry] ${calendar.length} real trading sessions available`);
    console.log(`[dry] newest ${calendar[0]}  oldest ${calendar[calendar.length - 1]}`);
    console.log(`[dry] would target the newest ${Math.min(TARGET_SESSIONS, calendar.length)}`);
    return;
  }

  const runId = await startRun("backfill");
  let sessionsAdded = 0;
  let barsAdded = 0;

  try {
    if (!SKIP_TICKERS) {
      console.log("fetching reference universe (active + delisted)...");
      const refs = await fullUniverse();
      const dead = refs.filter((r) => !r.active).length;
      const n = await upsertTickers(refs);
      console.log(`  stored ${n} tickers (${dead} delisted, kept for backtest integrity)`);
    }

    // The keep set is whatever already has bars: the pruned, meaningfully
    // liquid universe. A name liquid on the day itself is also kept, so
    // historically liquid names are not lost entirely.
    let keep: Set<string> | null = null;
    if (LIQUID_ONLY) {
      const sql = neon(process.env.DATABASE_URL!);
      const rows = (await sql`SELECT DISTINCT ticker FROM daily_bars`) as { ticker: string }[];
      keep = new Set(rows.map((r) => r.ticker));
      console.log(`liquid-only: retaining ${keep.size.toLocaleString()} tracked tickers`);
    }

    const stored = await storedTradingSessions();
    const todo = sessionsToFetch(calendar, stored, TARGET_SESSIONS);
    console.log(
      `${calendar.length} sessions in calendar, ${stored.length} stored, ${todo.length} to fetch`,
    );

    for (const date of todo) {
      if (sessionsAdded >= LIMIT) {
        console.log(`reached --limit ${LIMIT}, stopping`);
        break;
      }
      if (sessionsAdded >= TARGET_SESSIONS) {
        console.log(`reached ${TARGET_SESSIONS} trading sessions, done`);
        break;
      }

      const bars = await groupedDaily(date);

      // Every date here came from the real trading calendar, so an empty
      // response is a transient upstream problem, NOT a holiday. Leave it out
      // of the ledger so the next run picks it up again.
      if (classifySession(bars.length, true) === "retry") {
        console.warn(`  ${date}  empty response for a known session - will retry`);
        await sleep(THROTTLE_MS);
        continue;
      }

      const usable = keep
        ? bars.filter(
            (b) =>
              keep.has(b.T) ||
              (typeof b.c === "number" &&
                b.c >= 5 &&
                (b.v ?? 0) * (b.vw ?? b.c) >= 10_000_000),
          )
        : bars;

      const n = await insertBars(date, usable);
      await recordSession(date, n, true);
      sessionsAdded += 1;
      barsAdded += n;
      console.log(`  ${date}  ${n} bars${keep ? ` (of ${bars.length})` : ""}   [${sessionsAdded}/${TARGET_SESSIONS}]`);
      await sleep(THROTTLE_MS);
    }

    await finishRun(runId, sessionsAdded, barsAdded, true);
    const mins = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(`\ndone: ${sessionsAdded} sessions, ${barsAdded} bars, ${mins} min`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(runId, sessionsAdded, barsAdded, false, msg);
    console.error(`\nfailed after ${sessionsAdded} sessions: ${msg}`);
    console.error("re-run the same command; completed sessions are skipped.");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
