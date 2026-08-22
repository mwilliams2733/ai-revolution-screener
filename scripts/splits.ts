/**
 * Cache Polygon's split history.
 *
 *   npm run splits              # from 2023-01-01
 *   npm run splits -- --from 2020-01-01
 *
 * Two consumers, both of which are broken without it:
 *
 *   - lib/solvency.ts reads share counts from EDGAR cover pages, which are
 *     never restated for splits. Unadjusted, a 10-for-1 reads as +900%
 *     dilution and the metric condemns whichever companies appreciated enough
 *     to split.
 *   - scripts/backfill.ts never re-fetches a stored session, but Polygon
 *     restates price history when a split executes, so stored bars go stale.
 *     `tickersNeedingRefetch` names the casualties.
 */

import { neon } from "@neondatabase/serverless";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

const FROM = arg("from") ?? "2023-01-01";
const KEY = process.env.POLYGON_API_KEY!;

interface PolygonSplit {
  ticker: string;
  execution_date: string;
  split_from: number;
  split_to: number;
}

async function main(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  await sql`
    CREATE TABLE IF NOT EXISTS splits (
      ticker         TEXT NOT NULL,
      execution_date DATE NOT NULL,
      split_from     DOUBLE PRECISION NOT NULL,
      split_to       DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (ticker, execution_date)
    )
  `;

  const all: PolygonSplit[] = [];
  let url: string | null =
    `https://api.polygon.io/v3/reference/splits?execution_date.gte=${FROM}` +
    `&order=asc&sort=execution_date&limit=1000&apiKey=${KEY}`;

  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`splits: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: PolygonSplit[]; next_url?: string };
    all.push(...(body.results ?? []));
    // next_url carries the cursor but not the key.
    url = body.next_url ? `${body.next_url}&apiKey=${KEY}` : null;
    process.stdout.write(".");
  }
  console.log(`\nfetched ${all.length.toLocaleString()} splits since ${FROM}`);

  // Polygon can list the same (ticker, date) more than once -- corrections, or
  // a split recorded against two share classes. Postgres refuses an ON CONFLICT
  // DO UPDATE that touches one row twice in a statement, so dedupe first.
  const unique = [
    ...new Map(all.map((s) => [`${s.ticker}|${s.execution_date}`, s])).values(),
  ];
  if (unique.length !== all.length) {
    console.log(`${all.length - unique.length} duplicate rows collapsed`);
  }

  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    await sql`
      INSERT INTO splits (ticker, execution_date, split_from, split_to)
      SELECT * FROM UNNEST(
        ${batch.map((s) => s.ticker)}::text[],
        ${batch.map((s) => s.execution_date)}::date[],
        ${batch.map((s) => s.split_from)}::float8[],
        ${batch.map((s) => s.split_to)}::float8[]
      ) AS t(ticker, execution_date, split_from, split_to)
      ON CONFLICT (ticker, execution_date) DO UPDATE SET
        split_from = EXCLUDED.split_from, split_to = EXCLUDED.split_to
    `;
  }

  const held = (await sql`
    SELECT count(DISTINCT s.ticker) AS n,
           count(*) FILTER (WHERE s.split_to > s.split_from) AS forward,
           count(*) FILTER (WHERE s.split_to < s.split_from) AS reverse
    FROM splits s
    WHERE EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = s.ticker)
  `) as { n: string; forward: string; reverse: string }[];
  console.log(
    `stored. ${held[0].n} of them are tickers we hold bars for ` +
      `(${held[0].forward} forward, ${held[0].reverse} reverse)`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
