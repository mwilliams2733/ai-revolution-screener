/**
 * Quarterly re-validation. PROPOSES config changes; never applies them.
 *
 *   npm run signal-trader:revalidate -- --source lab   # reproduce the lab's headline
 *   npm run signal-trader:revalidate -- --source db    # stored bars + live grades
 *
 * Refits cutoffs on the chosen data's own train set (the lab's method), then
 * reports every long AND short rule at every horizon: n, episodes,
 * date-clustered t against the Bonferroni bar, and excess over SPY. A short
 * rule is flagged only if its CI clears zero AND its clustered t clears the
 * bar (decision 4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ST_CONFIG } from "../lib/signal-trader/config";
import { bonferroniT, buildPanel, clustered, excessMean, fitCutoffs, ruleFirings, splitPanel, stats } from "../lib/signal-trader/evaluate";
import { scoreSignals } from "../lib/signal-trader/grading";
import { LAB_DIR, readLabBars } from "../lib/signal-trader/lab-data";
import { LONG_RULES, SHORT_RULES } from "../lib/signal-trader/signals";
import { loadUniverseBars, readGrades, storedSessionsAsc } from "../lib/signal-trader/store";
import type { Bar } from "../lib/signal-trader/types";

const HORIZONS = [1, 3, 5, 10, 20];

async function main(): Promise<void> {
  const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : "db";
  let bars: Map<string, Bar[]>;
  if (source === "lab") {
    const g = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as { start: string; as_of: string };
    bars = new Map(ST_CONFIG.universe.map((t) => [t, readLabBars(t, g.start, g.as_of)]));
  } else {
    bars = await loadUniverseBars(ST_CONFIG.universe);
  }
  const panel = buildPanel(bars, HORIZONS);
  const { train, test } = splitPanel(panel);
  const cutoffs = fitCutoffs(train, panel.features);
  const calendar = [...new Set(panel.rows.map((r) => r.session))].sort();
  const spy = new Map(test.filter((r) => r.ticker === ST_CONFIG.benchmark).map((r) => [r.session, r.fwd]));
  const rules = [...LONG_RULES, ...SHORT_RULES];
  const bar = bonferroniT(rules.length * HORIZONS.length);
  console.log(`source ${source}; test from ${test.map((r) => r.session).sort()[0]}; ${rules.length * HORIZONS.length} tests; Bonferroni |t| > ${bar.toFixed(2)}`);
  console.log("rule                     H   n    ep   mean     vsSPY    hit   t(raw)  t(dates)");
  for (const rule of rules) {
    for (const H of HORIZONS) {
      const f = ruleFirings(test, panel.features, rule, cutoffs, H);
      if (f.length < 20) continue;
      const s = stats(f.map((r) => r.fwd[H]));
      const c = clustered(f, H, calendar);
      const short = rule.endsWith("__short");
      const ex = excessMean(f, spy, H);
      const flag = short && -s.mean > 0 && -c.tDates > bar ? "  <- short meets decision 4's bar" : "";
      console.log(
        `${rule.padEnd(24)} ${String(H).padStart(2)} ${String(s.n).padStart(4)} ${String(c.episodes).padStart(4)}  ${(s.mean * 100).toFixed(2).padStart(6)}%  ${ex == null ? "   --  " : (ex * 100).toFixed(2).padStart(6) + "%"}  ${(s.hit * 100).toFixed(0).padStart(3)}%  ${s.t.toFixed(2).padStart(6)}  ${c.tDates.toFixed(2).padStart(6)}${flag}`,
      );
    }
  }
  if (source === "db") {
    const sessions = await storedSessionsAsc();
    const scores = scoreSignals(await readGrades(), (s) => sessions.indexOf(s), sessions.length - 1);
    console.log("\nlive grades vs lab expectations:");
    for (const s of scores) {
      console.log(`  ${s.signal.padEnd(10)} picks ${s.picks} episodes ${s.episodes} hit ${s.hitRate == null ? "--" : Math.round(s.hitRate * 100) + "%"} (lab ${Math.round(s.labHit * 100)}%) mean ${s.meanRaw == null ? "--" : (s.meanRaw * 100).toFixed(2) + "%"} (expected ${(s.expectedMove * 100).toFixed(2)}%)`);
    }
  }
  console.log("\nProposals are for a human to apply in lib/signal-trader/config.ts; nothing was changed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
