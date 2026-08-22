/**
 * Does the tier predict forward return?
 *
 *   npm run backtest                    # SPY benchmark, 1/5/21-session horizons
 *   npm run backtest -- --benchmark QQQ
 *   npm run backtest -- --horizons 5,21,63
 *
 * Reads the reconstructed tier_history and the stored bars; writes nothing.
 * All of the statistical care lives in lib/backtest.ts -- this file is IO and
 * formatting. Read the header comment there before trusting any number here.
 */

import { neon } from "@neondatabase/serverless";
import {
  TIERS,
  runBacktest,
  verdict,
  type Stats,
  type TierObservation,
} from "../lib/backtest";
import type { Tier } from "../lib/types";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

const BENCHMARK = arg("benchmark") ?? "SPY";
const HORIZONS = (arg("horizons") ?? "1,5,21")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** Extra buy-and-hold comparisons, always loaded so the table can show them. */
const ALSO = ["SPY", "QQQ", "RSP", "IWM"];

const pct = (v: number | null, dp = 2): string =>
  v == null ? "--" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;
const fixed = (v: number | null, dp = 2): string => (v == null ? "--" : v.toFixed(dp));

function line(label: string, s: Stats, annualise: number | null): string {
  const ann = annualise != null && s.mean != null ? (1 + s.mean) ** annualise - 1 : null;
  return [
    label.padEnd(16),
    pct(s.mean).padStart(9),
    (ann == null ? "--" : pct(ann, 1)).padStart(10),
    fixed(s.t).padStart(7),
    (s.hitRate == null ? "--" : `${(s.hitRate * 100).toFixed(0)}%`).padStart(7),
    String(s.n).padStart(4),
  ].join("  ");
}

async function main(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);

  // --- the sessions that carry a tier, oldest first ---
  const sessions = (
    (await sql`
      SELECT DISTINCT session::text AS session FROM tier_history ORDER BY session ASC
    `) as { session: string }[]
  ).map((r) => r.session);

  if (sessions.length === 0) {
    console.error("tier_history is empty -- run `npm run replay` first.");
    process.exitCode = 1;
    return;
  }

  // --- tier rows, both the final tier and the pre-overlay momentum tier ---
  const rows = (await sql`
    SELECT session::text AS session, ticker, tier, momentum_tier
    FROM tier_history
    WHERE tier IS NOT NULL
  `) as { session: string; ticker: string; tier: string; momentum_tier: string | null }[];

  const isTier = (v: string | null): v is Tier =>
    v === "Strong Buy" || v === "Buy" || v === "Hold";

  const final: TierObservation[] = [];
  const momentum: TierObservation[] = [];
  for (const r of rows) {
    if (isTier(r.tier)) final.push({ session: r.session, ticker: r.ticker, tier: r.tier });
    if (isTier(r.momentum_tier)) {
      momentum.push({ session: r.session, ticker: r.ticker, tier: r.momentum_tier });
    }
  }

  // --- closes for every name that ever held a tier, plus the benchmarks ---
  const tickers = [...new Set([...rows.map((r) => r.ticker), ...ALSO, BENCHMARK])];
  const index = new Map(sessions.map((s, i) => [s, i]));
  const bars = (await sql`
    SELECT ticker, session::text AS session, close
    FROM daily_bars
    WHERE ticker = ANY(${tickers}::text[])
      AND session >= ${sessions[0]}::date
  `) as { ticker: string; session: string; close: number }[];

  const closes = new Map<string, (number | null)[]>();
  for (const b of bars) {
    const at = index.get(b.session);
    if (at == null) continue;
    let series = closes.get(b.ticker);
    if (!series) {
      series = new Array(sessions.length).fill(null);
      closes.set(b.ticker, series);
    }
    series[at] = Number(b.close);
  }

  // Provenance up front, because it decides what the numbers below are worth.
  // A replayed session is reconstructed with today's theme map, over a universe
  // pruned with today's knowledge, and without the fundamental gate. A live one
  // is a real out-of-sample observation.
  const split = (await sql`
    SELECT source, count(DISTINCT session) AS sessions
    FROM tier_history GROUP BY source
  `) as { source: string; sessions: string }[];
  const live = Number(split.find((r) => r.source === "live")?.sessions ?? 0);
  const replayed = Number(split.find((r) => r.source === "replay")?.sessions ?? 0);

  console.log(
    `\ntier_history: ${sessions.length} sessions, ${sessions[0]} -> ${sessions[sessions.length - 1]}\n` +
      `names: ${new Set(rows.map((r) => r.ticker)).size}   benchmark: ${BENCHMARK}\n` +
      `provenance: ${replayed} replayed, ${live} live (out-of-sample)\n`,
  );

  if (live === 0) {
    console.log(
      "Everything below is in-sample reconstruction. No out-of-sample evidence\n" +
        "exists yet; the nightly refresh adds one session a weekday.\n",
    );
  }

  const missing = [BENCHMARK, ...ALSO].filter((t) => !closes.has(t));
  if (missing.length) console.log(`no bars for: ${missing.join(", ")}\n`);

  for (const [label, observations] of [
    ["FINAL TIER (all overlays)", final],
    ["MOMENTUM TIER (price only)", momentum],
  ] as const) {
    const results = runBacktest({
      sessions,
      observations,
      closes,
      benchmark: BENCHMARK,
      horizons: HORIZONS,
    });

    console.log(`${"=".repeat(66)}\n${label}\n${"=".repeat(66)}`);

    for (const h of results) {
      // 252 trading sessions a year. Annualising an 11-window sample is for
      // comparability with the turnover figures, not a forecast.
      const perYear = 252 / h.horizon;
      console.log(
        `\n  ${h.horizon}-session horizon   ${h.windows} non-overlapping windows\n` +
          `  ${"".padEnd(16)}${"mean".padStart(11)}${"annualised".padStart(12)}` +
          `${"t".padStart(9)}${"hit".padStart(9)}${"n".padStart(6)}`,
      );
      for (const tier of TIERS) console.log(`  ${line(tier, h.byTier.get(tier)!, perYear)}`);
      console.log(`  ${line("whole theme", h.themeAll, perYear)}`);
      console.log(`  ${line(BENCHMARK, h.benchmark, perYear)}`);

      const spread = h.spread;
      const v = verdict(spread);
      console.log(
        `\n  ${line("SB - Hold", spread, perYear)}   <- ${v.toUpperCase()}`,
      );
      const vsBench = h.excess.get("Strong Buy")!;
      console.log(`  ${line(`SB - ${BENCHMARK}`, vsBench, perYear)}   <- ${verdict(vsBench).toUpperCase()}`);
      // The one that matters: does ranking within the theme beat owning it all?
      console.log(`  ${line("SB - theme", h.vsTheme, perYear)}   <- ${verdict(h.vsTheme).toUpperCase()}`);
    }
    console.log();
  }

  console.log(
    `${"=".repeat(66)}\n` +
      `Read these as descriptive, not as evidence. The windows are\n` +
      `non-overlapping, so each row's n is the real number of independent\n` +
      `observations -- and the names inside a window are one theme moving\n` +
      `together, so even that n is generous. The tier history is\n` +
      `reconstructed with today's theme map over a universe pruned with\n` +
      `today's knowledge of which names stayed liquid, and the fundamental\n` +
      `gate is not replayed. Every one of those biases favours the strategy.\n`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
