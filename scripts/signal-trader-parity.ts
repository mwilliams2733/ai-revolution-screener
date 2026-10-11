/**
 * Spec WS2 parity + WS3 acceptance, as a report (it never fails the build).
 *
 *  1. vol_spike firings on daily_bars vs the lab CSVs over their overlap. Every
 *     disagreement is listed with both volume z-scores so it can be explained
 *     (dividend adjustment, vendor volume).
 *  2. An in-memory replay over the overlap on daily_bars: every pick it makes
 *     must be decided on a session where its signal fired.
 *
 *   npm run signal-trader:parity
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ST_CONFIG } from "../lib/signal-trader/config";
import { LAB_DIR, readLabBars } from "../lib/signal-trader/lab-data";
import { buildMarket, replay, signalsFiring } from "../lib/signal-trader/scan";
import { loadUniverseBars } from "../lib/signal-trader/store";

const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as { start: string; as_of: string };

async function main(): Promise<void> {
  const db = buildMarket(await loadUniverseBars(ST_CONFIG.universe));
  const lab = buildMarket(new Map(ST_CONFIG.universe.map((t) => [t, readLabBars(t, golden.start, golden.as_of)])));

  const dbDays = new Set([...db.index.get("SPY")!.keys()]);
  const overlap = [...lab.index.get("SPY")!.keys()].filter((d) => dbDays.has(d) && d >= "2024-11-19");
  console.log(`overlap ${overlap[0]} .. ${overlap.at(-1)} (${overlap.length} sessions)`);

  let agree = 0;
  const disagree: string[] = [];
  for (const t of ST_CONFIG.universe) {
    for (const d of overlap) {
      const a = signalsFiring(db, t, d).includes("vol_spike");
      const b = signalsFiring(lab, t, d).includes("vol_spike");
      if (a === b) { if (a) agree++; continue; }
      const z = (m: typeof db) => m.features.get(t)!.continuous.vol_z[m.index.get(t)!.get(d)!];
      disagree.push(`${t} ${d}: db ${a ? "fires" : "quiet"} (z ${z(db).toFixed(3)}), lab ${b ? "fires" : "quiet"} (z ${z(lab).toFixed(3)})`);
    }
  }
  console.log(`vol_spike firings agreeing: ${agree}; disagreements: ${disagree.length}`);
  for (const line of disagree) console.log("  " + line);

  const { outcomes } = replay(db, overlap);
  const picks = outcomes.flatMap((o) => o.newPicks);
  const bad = picks.filter((p) => !signalsFiring(db, p.ticker, p.decidedSession).includes(p.signal));
  console.log(`replay: ${picks.length} picks, ${outcomes.flatMap((o) => o.exits).length} exits; picks without a firing signal: ${bad.length}`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
