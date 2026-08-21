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

import { groupedDaily, candidateSessions, fullUniverse } from "../lib/polygon";
import {
  upsertTickers,
  insertBars,
  recordSession,
  missingSessions,
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
/** Courtesy pause between grouped calls. */
const THROTTLE_MS = Number(arg("throttle", "120"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const started = Date.now();

  // Walk back enough weekdays to clear TARGET_SESSIONS trading days even after
  // ~10 market holidays a year are removed.
  const slack = Math.ceil(TARGET_SESSIONS * 0.06) + 10;
  const candidates = candidateSessions(new Date(), TARGET_SESSIONS + slack);

  if (DRY) {
    console.log(`[dry] ${candidates.length} candidate weekdays`);
    console.log(`[dry] newest ${candidates[0]}  oldest ${candidates[candidates.length - 1]}`);
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

    const todo = await missingSessions(candidates);
    console.log(`${candidates.length} candidates, ${todo.length} not yet fetched`);

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

      // 200 OK with zero results means weekend or market holiday, not failure.
      // Record it so a later run does not retry the same non-session forever.
      if (bars.length === 0) {
        await recordSession(date, 0, false);
        console.log(`  ${date}  holiday/non-session`);
        await sleep(THROTTLE_MS);
        continue;
      }

      const n = await insertBars(date, bars);
      await recordSession(date, n, true);
      sessionsAdded += 1;
      barsAdded += n;
      console.log(`  ${date}  ${n} bars   [${sessionsAdded}/${TARGET_SESSIONS}]`);
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
