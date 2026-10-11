/**
 * Repair price history stranded by a split.
 *
 *   npm run refetch-splits              # everything outstanding
 *   npm run refetch-splits -- --limit 50
 *   npm run refetch-splits -- --dry
 *
 * WHY THIS HAS TO EXIST
 *
 * Polygon restates a ticker's ENTIRE price history when a split executes, but
 * scripts/backfill.ts computes its work list as a set difference over SESSIONS
 * and so can never see that an already-stored session's values changed. Left
 * alone, a 10-for-1 reverse split leaves every pre-split bar on the old basis:
 * the twelve-month lookback spans the discontinuity, computes roughly +900%,
 * and sends a collapsing micro-cap to RS 99 at the top of the screen.
 *
 * The stored data is currently clean, but only by accident -- the whole
 * 500-session history was fetched in one recent sweep, after the splits it
 * contains. Nothing before this script would have kept it that way.
 *
 * Progress is tracked per (ticker, split) in split_refetch, never as a
 * high-water date. A watermark assumes everything older was handled, so one
 * failed repair in the middle is skipped forever and a split discovered late
 * with an older execution date is never done at all.
 */

import { isoDaysAgo } from "../lib/dates";
import { neon } from "@neondatabase/serverless";
import { tickerBars } from "../lib/polygon";
import {
  handledSplits,
  markSplitsHandled,
  replaceTickerBars,
  splitHistory,
  tickersWithBars,
} from "../lib/db";
import { pendingRefetches, refetchTargets, type Split } from "../lib/splits";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const DRY = has("dry");
const THROTTLE_MS = Number(arg("throttle") ?? "90");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  await sql`
    CREATE TABLE IF NOT EXISTS split_refetch (
      ticker         TEXT NOT NULL,
      execution_date DATE NOT NULL,
      done_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, execution_date)
    )
  `;

  const [bySymbol, handled, held] = await Promise.all([
    splitHistory(),
    handledSplits(),
    tickersWithBars(),
  ]);
  const all: Split[] = [...bySymbol.values()].flat();
  const pending = pendingRefetches(all, handled, held, isoDaysAgo(0));
  const targets = refetchTargets(pending);

  // The stored calendar bounds the work: a repair must not widen it, or one
  // ticker ends up with sessions no other name has and every positional
  // lookback is off by one for it.
  const bounds = (await sql`
    SELECT min(session)::text AS lo, max(session)::text AS hi FROM stored_sessions
  `) as { lo: string; hi: string }[];
  const { lo, hi } = bounds[0];

  console.log(
    `${all.length.toLocaleString()} splits known, ${handled.size.toLocaleString()} already repaired\n` +
      `${pending.length} pending across ${targets.length} tickers\n` +
      `calendar ${lo} -> ${hi}\n`,
  );
  if (targets.length === 0) {
    console.log("nothing to do");
    return;
  }
  if (DRY) {
    for (const t of targets.slice(0, 40)) console.log(`  ${t.ticker.padEnd(7)} since ${t.since}`);
    if (targets.length > 40) console.log(`  ... and ${targets.length - 40} more`);
    return;
  }

  const todo = targets.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const started = Date.now();
  let repaired = 0;
  let rows = 0;
  let failed = 0;

  for (const t of todo) {
    try {
      // The whole stored range, not just since the split: Polygon restates
      // everything, so a partial repair leaves a seam at whatever date we
      // happened to start from.
      const bars = await tickerBars(t.ticker, lo, hi);
      if (bars.length === 0) {
        // Delisted, or renamed. Mark it done rather than retrying forever;
        // the bars we hold are all there will ever be.
        failed += 1;
      } else {
        rows += await replaceTickerBars(
          t.ticker,
          bars.map((b) => ({
            session: new Date((b as unknown as { t: number }).t).toISOString().slice(0, 10),
            o: b.o,
            h: b.h,
            l: b.l,
            c: b.c,
            v: b.v,
            vw: b.vw,
          })),
        );
        repaired += 1;
      }
      await markSplitsHandled(
        pending.filter((s) => s.ticker === t.ticker).map((s) => ({
          ticker: s.ticker,
          executionDate: s.executionDate,
        })),
      );
    } catch (e) {
      // NOT marked handled: an error must leave the work outstanding, or the
      // ledger records a repair that never happened.
      failed += 1;
      console.log(`  ${t.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((repaired + failed) % 100 === 0) {
      const rate = (repaired + failed) / ((Date.now() - started) / 1000);
      console.log(
        `  ${repaired + failed}/${todo.length}  ${rate.toFixed(1)}/s  ` +
          `~${(((todo.length - repaired - failed) / rate) / 60).toFixed(1)} min left`,
      );
    }
    await sleep(THROTTLE_MS);
  }

  console.log(
    `\nrepaired ${repaired} tickers, ${rows.toLocaleString()} bars rewritten, ` +
      `${failed} with no data, ${((Date.now() - started) / 60_000).toFixed(1)} min`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
