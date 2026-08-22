/**
 * Fetch SIC codes from SEC EDGAR so the full ranked universe can be filtered
 * by sector.
 *
 *   npm run sectors                 # every ticker with a CIK and no SIC yet
 *   npm run sectors -- --limit 50   # trial
 *   npm run sectors -- --refresh    # re-fetch names already classified
 *
 * Polygon's reference LIST endpoint carries no SIC -- its fields are ticker,
 * name, cik, exchange, type and figis, nothing industrial -- and the details
 * endpoint returns no sic_code on this plan. EDGAR's submissions document does
 * carry it, keyed by the CIK the tickers table already stores.
 *
 * RESUMABLE, AND NOT BY COUNTING
 *
 * The work list is "tickers with a CIK and a null sic", recomputed on every
 * run. It is a set difference, never a high-water mark, so an interrupted run
 * resumes exactly where it stopped and a newly-added ticker is picked up
 * without a full re-fetch. A filer that genuinely has no SIC is written as the
 * empty string rather than left null, so it is not retried forever.
 */

import { neon } from "@neondatabase/serverless";
import { classify } from "../lib/sic";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};
const has = (name: string) => process.argv.includes(`--${name}`);

const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const REFRESH = has("refresh");

/**
 * SEC asks for no more than 10 requests a second and blocks on abuse. 120ms
 * between calls is ~8/s, comfortably inside it and still under ten minutes for
 * the whole universe.
 */
const THROTTLE_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Submissions {
  readonly sic?: string;
  readonly sicDescription?: string;
}

async function fetchSic(cik: string, ua: string): Promise<Submissions | null> {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": ua, Accept: "application/json" },
  });
  // 404 is a real answer: the CIK is stale or the filer never submitted. Treat
  // it as classified-as-nothing so the name is not retried on every run.
  if (res.status === 404) return {};
  if (!res.ok) return null;
  return (await res.json()) as Submissions;
}

async function main(): Promise<void> {
  const ua = process.env.SEC_EDGAR_USER_AGENT;
  if (!ua) {
    console.error("SEC_EDGAR_USER_AGENT is not set. EDGAR rejects anonymous clients.");
    process.exitCode = 1;
    return;
  }
  const sql = neon(process.env.DATABASE_URL!);
  const started = Date.now();

  // Only names that can appear on the screen are worth the round trip: a CIK
  // to look up, and at least one stored bar.
  const todo = (
    (await sql`
      SELECT k.ticker, k.cik
      FROM tickers k
      WHERE k.cik IS NOT NULL
        AND (${REFRESH}::boolean OR k.sic IS NULL)
        AND EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = k.ticker)
      ORDER BY k.ticker
    `) as { ticker: string; cik: string }[]
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`${todo.length.toLocaleString()} tickers to classify\n`);
  if (todo.length === 0) return;

  let done = 0;
  let failed = 0;
  const batch: { ticker: string; sic: string; desc: string }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await sql`
      UPDATE tickers AS k
      SET sic = v.sic, sic_description = v.sic_desc, updated_at = now()
      FROM (
        SELECT * FROM UNNEST(
          ${batch.map((b) => b.ticker)}::text[],
          ${batch.map((b) => b.sic)}::text[],
          ${batch.map((b) => b.desc)}::text[]
        ) AS t(ticker, sic, sic_desc)   -- "desc" alone is a reserved word
      ) AS v
      WHERE k.ticker = v.ticker
    `;
    batch.length = 0;
  };

  for (const row of todo) {
    try {
      const sub = await fetchSic(row.cik, ua);
      if (sub == null) {
        failed += 1;
      } else {
        batch.push({
          ticker: row.ticker,
          sic: sub.sic ?? "",
          desc: sub.sicDescription ?? "",
        });
      }
    } catch {
      failed += 1;
    }

    done += 1;
    if (batch.length >= 200) await flush();
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(
        `  ${done}/${todo.length}  ${rate.toFixed(1)}/s  ` +
          `${failed} failed  ~${(((todo.length - done) / rate) / 60).toFixed(1)} min left`,
      );
    }
    await sleep(THROTTLE_MS);
  }
  await flush();

  const summary = (await sql`
    SELECT k.sic, k.sic_description, count(*) AS n
    FROM tickers k
    WHERE k.sic IS NOT NULL AND k.sic <> ''
      AND EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = k.ticker)
    GROUP BY k.sic, k.sic_description
  `) as { sic: string; sic_description: string; n: string }[];

  const bySector = new Map<string, number>();
  for (const r of summary) {
    const { sector } = classify(r.sic, r.sic_description);
    bySector.set(sector, (bySector.get(sector) ?? 0) + Number(r.n));
  }

  console.log(`\ndone: ${done} fetched, ${failed} failed, ${((Date.now() - started) / 60_000).toFixed(1)} min\n`);
  console.log("classified universe by sector:");
  for (const [sector, n] of [...bySector].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sector.padEnd(26)} ${String(n).padStart(5)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
