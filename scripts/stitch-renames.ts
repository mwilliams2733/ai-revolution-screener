/**
 * Join renamed tickers' history across the change of symbol.
 *
 *   npm run stitch-renames -- --dry        # report, write nothing
 *   npm run stitch-renames                 # stitch every confirmed rename
 *   npm run stitch-renames -- --tickers MPT,P
 *
 * Candidates are tickers that traded in the latest stored session but whose
 * stored history starts after the calendar's first day -- new listings and
 * renames look identical from the bars alone. Polygon's ticker events tell
 * them apart (one call each), and lib/renames.ts refuses any seam that is not
 * adjacent and within 25%. Tickers already in ticker_renames are skipped,
 * stitched or dropped alike; re-stitching after a split is the split repair's
 * job (lib/renames-service.ts).
 *
 * Rows a stitch deletes under the new symbol -- another company's bars from
 * before the symbol was reused -- are written to .claude/backups first.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { tickerEvents } from "../lib/polygon";
import { tickerRenames } from "../lib/db";
import { parseRename } from "../lib/renames";
import { defaultStitchDeps, stitch } from "../lib/renames-service";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry");
const ONLY = (arg("tickers") ?? "")
  .split(",")
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  const deps = await defaultStitchDeps();
  const { lo, hi } = deps.bounds;
  const known = await tickerRenames();

  const candidates =
    ONLY.length > 0
      ? ONLY
      : (
          (await sql`
            SELECT t.ticker FROM daily_bars t
            WHERE t.session = ${hi}::date
              AND (SELECT min(session) FROM daily_bars f WHERE f.ticker = t.ticker) > ${lo}::date
            ORDER BY t.ticker
          `) as { ticker: string }[]
        ).map((r) => r.ticker);
  const todo = candidates.filter((t) => ONLY.length > 0 || !known.has(t));
  console.log(`calendar ${lo} -> ${hi}; ${todo.length} candidates${DRY ? "  [dry run]" : ""}\n`);

  const backup = `.claude/backups/stitch_renames_deleted_${new Date().toISOString().slice(0, 10)}.jsonl`;
  mkdirSync(".claude/backups", { recursive: true });

  let stitched = 0;
  let refused = 0;
  let failed = 0;
  for (const ticker of todo) {
    try {
      // A 404 is Polygon having no event record for the symbol: no rename.
      const events = await tickerEvents(ticker).catch((e: unknown) => {
        if (e instanceof Error && /HTTP 404/.test(e.message)) return [];
        throw e;
      });
      const rename = parseRename(ticker, events);
      if (!rename || rename.changeDate <= lo) continue; // a new listing, or renamed before our history
      const r = { newTicker: ticker, ...rename };

      const plan = await stitch(r, deps, { dropOnFailure: false, dry: true });
      if (!plan.ok) {
        refused += 1;
        console.log(`  ${ticker.padEnd(6)} <- ${r.oldTicker.padEnd(6)} ${r.changeDate}  REFUSED: ${plan.reason}`);
        continue;
      }
      if (!DRY) {
        const doomed = await sql`
          SELECT session::text AS session, ticker, open, high, low, close, volume, vwap
          FROM daily_bars WHERE ticker = ${ticker} AND session < ${r.changeDate}::date`;
        if (doomed.length > 0) appendFileSync(backup, JSON.stringify({ ticker, rows: doomed }) + "\n");
        await deps.apply(ticker, r.oldTicker, r.changeDate, plan.rows, plan.seam);
      }
      stitched += 1;
      const { seam } = plan;
      console.log(
        `  ${ticker.padEnd(6)} <- ${r.oldTicker.padEnd(6)} ${r.changeDate}  ${plan.rows.length} bars, ` +
          `seam ${seam.oldClose} -> ${seam.newOpen}`,
      );
    } catch (e) {
      failed += 1;
      console.log(`  ${ticker.padEnd(6)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(90);
  }
  console.log(`\n${DRY ? "would stitch" : "stitched"} ${stitched}, refused ${refused}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
