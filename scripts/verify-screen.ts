/**
 * End-to-end pipeline check, no database required.
 *
 * HANDOFF.md build step 3: "Verify against the numbers in STRATEGY_DECODED.md
 * section 2, LITE should come out at the 99th percentile." That single number
 * is the cheapest available proof that ranking happens against the full liquid
 * universe BEFORE the theme filter. Reverse those two steps and the pipeline
 * still returns well-formed rows with plausible percentiles; nothing throws.
 * LITE's rank is what actually moves.
 *
 *   npm run verify:screen
 */

import {
  groupedDaily,
  referenceTickers,
  tradingCalendar,
  anchorDates,
} from "../lib/polygon";
import { barsByTicker } from "../lib/factors";
import { runScreen, DEFAULT_PARAMS } from "../lib/index";
import type { Snapshots } from "../lib/types";

/** Expected RS percentiles from STRATEGY_DECODED.md section 2. */
const EXPECTED: Record<string, number> = {
  LITE: 99, MRVL: 98, FTNT: 89, CRS: 87, AGX: 84, LLY: 82,
  VRT: 69, PLTR: 68, RDW: 68, TOST: 67, FFIV: 59, NVDA: 47,
  KTOS: 15, EVLV: 12, SYM: 8,
};

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log("resolving trading calendar...");
  const calendar = await tradingCalendar(isoDaysAgo(430), isoDaysAgo(0));
  const anchors = anchorDates(calendar, DEFAULT_PARAMS.lookbacks);
  console.log("  anchors:", JSON.stringify(anchors));

  const missing = Object.entries(anchors).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`calendar too short for anchors: ${missing.join(", ")}`);

  console.log("fetching 5 grouped sessions...");
  const snaps: Record<string, Awaited<ReturnType<typeof barsByTicker>>> = {};
  for (const [label, date] of Object.entries(anchors)) {
    const bars = await groupedDaily(date as string);
    snaps[label] = barsByTicker(bars);
    console.log(`  ${label.padEnd(4)} ${date}  ${bars.length} bars`);
  }

  console.log("fetching reference names...");
  const refs = await referenceTickers(true);
  const names = new Map(refs.map((r) => [r.ticker, r.name]));
  console.log(`  ${names.size} active common stocks`);

  const { ranked, themed, portfolio, universeSize } = runScreen({
    snapshots: snaps as unknown as Snapshots,
    names,
  });

  console.log(`\nliquid universe (price>=$${DEFAULT_PARAMS.minPrice}, ` +
    `$vol>=$${(DEFAULT_PARAMS.minDollarVolume / 1e6).toFixed(0)}M): ${universeSize} names`);
  console.log(`themed: ${themed.length}   portfolio: ${portfolio.length}`);

  const byTicker = new Map(ranked.map((r) => [r.ticker, r]));
  console.log("\nticker  RS%ile  expected  delta   vsMA     tier");
  console.log("-".repeat(56));
  let checked = 0;
  let within10 = 0;
  for (const [t, exp] of Object.entries(EXPECTED)) {
    const row = byTicker.get(t);
    if (!row || row.rsPct == null) {
      console.log(`${t.padEnd(7)} ${"--".padStart(6)}  ${String(exp).padStart(8)}   (not in liquid universe)`);
      continue;
    }
    const got = Math.round(row.rsPct);
    const d = got - exp;
    checked += 1;
    if (Math.abs(d) <= 10) within10 += 1;
    console.log(
      `${t.padEnd(7)} ${String(got).padStart(6)}  ${String(exp).padStart(8)}  ${
        (d >= 0 ? "+" : "") + d
      }`.padEnd(38) + `${row.vsMa.toFixed(1).padStart(6)}%  ${row.tier ?? "-"}`,
    );
  }

  const lite = byTicker.get("LITE");
  console.log("\n" + "=".repeat(56));
  if (!lite || lite.rsPct == null) {
    console.log("FAIL: LITE absent from the ranked universe");
    process.exitCode = 1;
  } else {
    const p = Math.round(lite.rsPct);
    console.log(`LITE RS percentile: ${p}   (expected 99)`);
    console.log(p >= 97 ? "PASS: rank-then-filter ordering confirmed" : "FAIL: check rank/filter order");
    if (p < 97) process.exitCode = 1;
  }
  console.log(`anchors matched within 10 points: ${within10}/${checked}`);

  console.log("\ntop 15 of the themed set:");
  for (const r of themed.slice(0, 15)) {
    console.log(
      `  ${r.ticker.padEnd(6)} ${String(Math.round(r.rsPct ?? 0)).padStart(3)}  ` +
      `${(r.tier ?? "-").padEnd(11)} ${r.sector}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
