/**
 * Re-fetch named tickers' full stored history, filling holes.
 *
 *   npm run fill-history -- --tickers PLUG,GPRO,BBD
 *   npm run fill-history -- --tickers PLUG --dry
 *
 * WHY THIS HAS TO EXIST
 *
 * The 2026-08-21 backfill kept a bar only for already-tracked tickers or for
 * names that closed >= $5 with >= $10M traded THAT day. The next day the floor
 * dropped to $1 and liquidity moved to a 50-session median, but the skipped
 * bars were never fetched. A name under $5 then, or with a thin day, has holes
 * -- often its 12-month anchor -- and stays unranked however liquid it is now.
 *
 * Each ticker is re-fetched over the whole stored range, like the split
 * repair: Polygon's adjusted series is consistent with itself, and patching
 * only the gaps would leave seams if a split landed in between. Only sessions
 * already in the stored calendar are written (replaceTickerBars).
 */

import { neon } from "@neondatabase/serverless";
import { tickerBars } from "../lib/polygon";
import { replaceTickerBars } from "../lib/db";
import { toSessionBars, type RawAggregate } from "../lib/ticker-history";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY = process.argv.includes("--dry");
const TICKERS = (arg("tickers") ?? "")
  .split(",")
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (TICKERS.length === 0) throw new Error("pass --tickers A,B,C");
  const sql = neon(process.env.DATABASE_URL!);
  const [{ lo, hi, n: sessions }] = (await sql`
    SELECT min(session)::text AS lo, max(session)::text AS hi, count(*)::int AS n FROM stored_sessions
  `) as { lo: string; hi: string; n: number }[];
  console.log(`calendar ${lo} -> ${hi} (${sessions} sessions)${DRY ? "  [dry run]" : ""}\n`);

  const stored = async (t: string) =>
    Number(((await sql`SELECT count(*) AS n FROM daily_bars WHERE ticker = ${t}`) as { n: string }[])[0].n);

  let failed = 0;
  for (const t of TICKERS) {
    try {
      const before = await stored(t);
      const bars = toSessionBars((await tickerBars(t, lo, hi)) as unknown as RawAggregate[]);
      if (bars.length === 0) {
        console.log(`  ${t.padEnd(6)} Polygon returned no bars; left as is`);
        continue;
      }
      if (!DRY) await replaceTickerBars(t, bars);
      const after = DRY ? before : await stored(t);
      console.log(`  ${t.padEnd(6)} stored ${before} -> ${after}  (Polygon ${bars.length})`);
    } catch (e) {
      failed += 1;
      console.log(`  ${t.padEnd(6)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(90);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
