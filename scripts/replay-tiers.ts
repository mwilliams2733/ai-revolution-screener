/**
 * Reconstruct tier_history from stored bars.
 *
 *   npm run replay              # every session with full anchors
 *   npm run replay -- --limit 5 # trial
 *
 * Tier stability metrics need many recorded nights, and the refresh records one
 * per weekday. Since the bars are already stored, the screen can simply be
 * replayed as of each past session instead of waiting a year.
 *
 * WHAT IS AND IS NOT REPLAYED
 *
 * Replayed: the momentum tier, true moving averages, the Weinstein stage rule
 * and the top-N cap. All are computed purely from bars available on or before
 * the session being reconstructed.
 *
 * NOT replayed: the fundamental gate. EDGAR's companyfacts returns TODAY's
 * filings, so applying it to a 2025 session would decide that session using
 * results published months later -- textbook lookahead bias. A reconstructed
 * row therefore reflects slightly looser rules than a live one, and rows are
 * marked so nobody later mistakes one for the other.
 *
 * Also approximate: the theme map and the crowding veto are today's. A name
 * added to the theme last month appears throughout the reconstructed history.
 * That is survivorship bias in the theme dimension and cannot be fixed without
 * a versioned theme map.
 */

import { neon } from "@neondatabase/serverless";
import { barsByTicker, type PolygonBar } from "../lib/factors";
import { runScreen, DEFAULT_PARAMS } from "../lib/index";
import { applyTrueMa, MA_WINDOW } from "../lib/moving-average";
import { applyStageRule } from "../lib/stage-overlay";
import { applyTrend } from "../lib/trend-overlay";
import { capStrongBuy } from "../lib/strong-buy-cap";
import { applyHysteresis } from "../lib/hysteresis";
import { STRONG_BUY_LIMIT } from "../lib/screen-service";
import type { Snapshots, Tier } from "../lib/types";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const TICKER_CHUNK = 400;

interface Series {
  readonly close: (number | null)[];
  readonly high: (number | null)[];
  readonly low: (number | null)[];
  readonly volume: (number | null)[];
  readonly vwap: (number | null)[];
}

async function main(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);
  const started = Date.now();

  // --- calendar, oldest first so an index is a position in time ---
  const cal = (
    (await sql`
      SELECT session::text AS session FROM stored_sessions ORDER BY session ASC
    `) as { session: string }[]
  ).map((r) => r.session);
  const index = new Map(cal.map((s, i) => [s, i]));
  console.log(`calendar: ${cal.length} sessions, ${cal[0]} -> ${cal[cal.length - 1]}`);

  const lb = DEFAULT_PARAMS.lookbacks;
  // A session can only be reconstructed if its longest anchor also exists.
  const first = lb.r12m;
  const replayable = cal.slice(first);
  console.log(`replayable: ${replayable.length} sessions (need ${lb.r12m} prior)\n`);

  // --- names ---
  const nameRows = (await sql`SELECT ticker, name FROM tickers`) as {
    ticker: string;
    name: string;
  }[];
  const names = new Map(nameRows.map((r) => [r.ticker, r.name]));

  // --- load every bar into memory, in ticker chunks ---
  // One query for 2.3M rows would exceed Neon's 64MB response cap, and the
  // replay needs random access across time anyway.
  const tickers = (
    (await sql`SELECT DISTINCT ticker FROM daily_bars ORDER BY ticker`) as { ticker: string }[]
  ).map((r) => r.ticker);

  const series = new Map<string, Series>();
  const blank = (): Series => ({
    close: new Array(cal.length).fill(null),
    high: new Array(cal.length).fill(null),
    low: new Array(cal.length).fill(null),
    volume: new Array(cal.length).fill(null),
    vwap: new Array(cal.length).fill(null),
  });

  process.stdout.write("loading bars");
  for (let i = 0; i < tickers.length; i += TICKER_CHUNK) {
    const batch = tickers.slice(i, i + TICKER_CHUNK);
    const rows = (await sql`
      SELECT ticker, session::text AS session, open, high, low, close, volume, vwap
      FROM daily_bars WHERE ticker = ANY(${batch}::text[])
    `) as {
      ticker: string;
      session: string;
      high: number | null;
      low: number | null;
      close: number;
      volume: number;
      vwap: number | null;
    }[];

    for (const r of rows) {
      const at = index.get(r.session);
      if (at == null) continue;
      let s = series.get(r.ticker);
      if (!s) {
        s = blank();
        series.set(r.ticker, s);
      }
      s.close[at] = Number(r.close);
      s.high[at] = r.high == null ? null : Number(r.high);
      s.low[at] = r.low == null ? null : Number(r.low);
      s.volume[at] = Number(r.volume);
      s.vwap[at] = r.vwap == null ? null : Number(r.vwap);
    }
    process.stdout.write(".");
  }
  console.log(` ${series.size.toLocaleString()} tickers in memory\n`);

  /** Bars for one calendar position, in the shape barsByTicker expects. */
  function snapshotAt(at: number): PolygonBar[] {
    const out: PolygonBar[] = [];
    for (const [ticker, s] of series) {
      const c = s.close[at];
      if (c == null) continue;
      out.push({ T: ticker, c, v: s.volume[at] ?? 0, vw: s.vwap[at] ?? c });
    }
    return out;
  }

  /** Closes up to and including `at`, oldest first, gaps removed. */
  function closesUpTo(ticker: string, at: number, window: number): number[] {
    const s = series.get(ticker);
    if (!s) return [];
    const from = Math.max(0, at - window + 1);
    const out: number[] = [];
    for (let i = from; i <= at; i++) if (s.close[i] != null) out.push(s.close[i] as number);
    return out;
  }

  function trendBarsUpTo(ticker: string, at: number, window: number) {
    const s = series.get(ticker);
    if (!s) return [];
    const from = Math.max(0, at - window + 1);
    const out: { close: number; high: number; low: number }[] = [];
    for (let i = from; i <= at; i++) {
      const c = s.close[i];
      const h = s.high[i];
      const l = s.low[i];
      if (c != null && h != null && l != null) out.push({ close: c, high: h, low: l });
    }
    return out;
  }

  // --- replay OLDEST first: hysteresis is stateful, so each session needs the
  // previous session's momentum tier, carried forward in memory. ---
  const order = [...replayable];
  let prior = new Map<string, Tier>();
  // Last session's final Strong Buys, for the cap's incumbency margin.
  let incumbents = new Set<string>();
  let done = 0;
  let written = 0;

  for (const session of order) {
    if (done >= LIMIT) break;
    const at = index.get(session)!;

    const snaps: Record<string, ReturnType<typeof barsByTicker>> = {
      now: barsByTicker(snapshotAt(at)),
      r1m: barsByTicker(snapshotAt(at - lb.r1m)),
      r3m: barsByTicker(snapshotAt(at - lb.r3m)),
      r6m: barsByTicker(snapshotAt(at - lb.r6m)),
      r12m: barsByTicker(snapshotAt(at - lb.r12m)),
    };

    const { themed } = runScreen({ snapshots: snaps as unknown as Snapshots, names });

    const closeHistory = new Map<string, number[]>();
    const trendHistory = new Map<string, { close: number; high: number; low: number }[]>();
    for (const r of themed) {
      closeHistory.set(r.ticker, closesUpTo(r.ticker, at, MA_WINDOW));
      trendHistory.set(r.ticker, trendBarsUpTo(r.ticker, at, 260));
    }

    // Same order as production, minus the fundamental gate.
    const withMa = applyTrueMa(themed, closeHistory);
    const trended = applyHysteresis(withMa, prior);
    const staged = applyTrend(trended, trendHistory);
    const ruled = applyStageRule(staged);
    const capped = capStrongBuy(
      ruled.map((r) => ({ ...r, momentumTier: r.tier, gate: "unverified" as const, gateReason: "not replayed" })),
      STRONG_BUY_LIMIT,
      undefined,
      incumbents,
    );

    // The momentum tier AFTER hysteresis is what the next session compares
    // against; feeding it the capped tier would read every cap as a change.
    prior = new Map(
      trended.filter((r) => r.tier != null).map((r) => [r.ticker, r.tier as Tier]),
    );

    incumbents = new Set(
      capped.filter((r) => r.tier === "Strong Buy").map((r) => r.ticker),
    );

    const momentum = new Map(trended.map((r) => [r.ticker, r.tier]));
    const rows = capped.map((r) => ({
      ticker: r.ticker,
      rsPct: r.rsPct,
      vsMa: r.vsMa,
      tier: r.tier,
      momentumTier: momentum.get(r.ticker) ?? null,
      weight: r.weight,
    }));

    // Written directly rather than through upsertTierHistory so the run stays
    // one module and one connection.
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await sql`
        INSERT INTO tier_history (session, ticker, rs_pct, vs_ma, tier, momentum_tier, weight)
        SELECT ${session}::date, * FROM UNNEST(
          ${batch.map((r) => r.ticker)}::text[],
          ${batch.map((r) => r.rsPct)}::float8[],
          ${batch.map((r) => r.vsMa)}::float8[],
          ${batch.map((r) => r.tier)}::text[],
          ${batch.map((r) => r.momentumTier)}::text[],
          ${batch.map((r) => r.weight)}::float8[]
        ) AS t(ticker, rs_pct, vs_ma, tier, momentum_tier, weight)
        ON CONFLICT (session, ticker) DO UPDATE SET
          rs_pct = EXCLUDED.rs_pct, vs_ma = EXCLUDED.vs_ma,
          tier = EXCLUDED.tier, momentum_tier = EXCLUDED.momentum_tier,
          weight = EXCLUDED.weight
      `;
      written += batch.length;
    }

    done += 1;
    if (done % 20 === 0 || done === 1) {
      console.log(`  ${session}  ${rows.length} rows  [${done}/${Math.min(order.length, LIMIT)}]`);
    }
  }

  console.log(
    `\ndone: ${done} sessions, ${written.toLocaleString()} rows, ` +
      `${((Date.now() - started) / 60_000).toFixed(1)} min`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
