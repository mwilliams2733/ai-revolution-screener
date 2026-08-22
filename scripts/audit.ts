/**
 * Data-integrity gate. (Phase 5)
 *
 * Asserts the Phase 1 verification values against LIVE data, so the checks that
 * caught real bugs during the review run automatically instead of being
 * repeated by hand.
 *
 *   npm run audit        typecheck + tests + this
 *   npm run audit:data   just this
 *
 * Skips rather than fails when POLYGON_API_KEY is absent, so CI on a fork or a
 * machine without secrets still runs the offline half. A skip is reported
 * loudly: a silent pass would be worse than a failure.
 */

import { neon } from "@neondatabase/serverless";
import { getScreen } from "../lib/screen-service";
import { percentileRanks } from "../lib/factors";
import { DEFAULT_PARAMS as P } from "../lib/params";

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
  /** Soft checks warn instead of failing the build. */
  readonly soft?: boolean;
}

const checks: Check[] = [];

function assert(name: string, ok: boolean, detail: string, soft = false): void {
  checks.push({ name, ok, detail, soft });
}

/**
 * The liquid universe is a SNAPSHOT, not an invariant.
 *
 * STRATEGY_DECODED.md measured 2,204 on 2026-08-19; it drifts daily as names
 * cross the $5 and $10M floors. A band catches a broken reference fetch or ETFs
 * leaking in, without failing the build every time the market moves.
 */
const UNIVERSE_MIN = 1_700;
const UNIVERSE_MAX = 2_800;

async function main(): Promise<void> {
  // --- offline checks, always runnable ---
  const ties = percentileRanks([1, 2, 2, 3]);
  assert(
    "percentile ties are averaged",
    JSON.stringify(ties) === "[0,50,50,100]",
    `percentileRanks([1,2,2,3]) = ${JSON.stringify(ties)}, expected [0,50,50,100]`,
  );

  const book = P.nStrong * P.wStrong + P.nBuy * P.wBuy + P.nHold * P.wHold;
  assert(
    "7/7/5 book sums to 100.01%",
    Math.abs(book * 100 - 100.01) < 0.005,
    `${(book * 100).toFixed(2)}% (their published weights are rounded)`,
  );

  if (!process.env.POLYGON_API_KEY) {
    report(true, "POLYGON_API_KEY absent - live data checks SKIPPED");
    return;
  }

  // --- live checks ---
  const screen = await getScreen();

  assert(
    "liquid universe within band",
    screen.universeSize >= UNIVERSE_MIN && screen.universeSize <= UNIVERSE_MAX,
    `${screen.universeSize} names (band ${UNIVERSE_MIN}-${UNIVERSE_MAX}; doc snapshot was 2,204). ` +
      `Materially fewer means the reference fetch or liquidity gate broke; materially more means ETFs are leaking in.`,
  );

  /**
   * Rank-then-filter, asserted structurally.
   *
   * If percentiles were computed inside the theme, universeSize would EQUAL
   * the themed count, because the ranked population would be the themed one.
   *
   * This check exists because LITE's percentile does NOT catch that break:
   * verified by deliberately reordering the pipeline, LITE stayed at 99, since
   * a name at the top of the universe is also at the top of any subset holding
   * it. LITE's rank proves the pipeline runs on sane data; only this proves
   * WHICH population it ranked against.
   */
  assert(
    "percentiles rank the full universe, not the theme",
    screen.universeSize > screen.themed.length * 3,
    `universe ${screen.universeSize} vs themed ${screen.themed.length}. ` +
      `If these are equal or close, ranking moved inside the theme filter and the 80/55 tier cutoffs are meaningless.`,
  );

  // A good smoke test that the pipeline runs on sane data, though NOT a test of
  // the ordering above.
  const lite = screen.themed.find((r) => r.ticker === "LITE");
  const litePct = lite?.rsPct ?? null;
  assert(
    "LITE ranks at the 99th percentile",
    litePct != null && Math.round(litePct) >= 97,
    litePct == null
      ? "LITE absent from the themed set"
      : `${Math.round(litePct)} (expected 99; a drop here means the data or the factor maths moved)`,
  );

  assert(
    "theme filter did not collapse",
    screen.themed.length >= 50,
    `${screen.themed.length} themed names`,
  );

  assert(
    "vetoed names surface rather than vanish",
    screen.vetoed.length >= 1,
    `${screen.vetoed.length} held-out names carry a reason`,
  );

  assert(
    "as-of session is recognised",
    screen.staleness.freshness !== "very-stale" || screen.staleness.sessionsBehind < 5,
    `${screen.asOf}: ${screen.staleness.label}`,
    true,
  );

  // A data-loading failure must fail the build. Previously a swallowed error
  // made every row fall back to the proxy while the audit reported "needs the
  // backfill" -- which was false. A broken query must never look like absent
  // data.
  assert(
    "history loaded without errors",
    screen.meta.warnings.length === 0,
    screen.meta.warnings.length === 0
      ? "no loader warnings"
      : screen.meta.warnings.join(" | "),
  );

  // Soft: these depend on the backfill and are expected to be zero until Neon
  // exists. Reported so the transition is visible rather than assumed.
  assert(
    "moving averages are true rolling means",
    screen.meta.trueMaRows > 0,
    `${screen.meta.trueMaRows}/${screen.themed.length} rows; 0 means the five-point proxy is still in use (needs the backfill)`,
    true,
  );
  assert(
    "volume metrics are measured",
    screen.meta.volumeMeasured > 0,
    `${screen.meta.volumeMeasured}/${screen.themed.length} rows have a 50-session history`,
    true,
  );
  assert(
    "trend template is scored",
    screen.meta.trendScored > 0,
    `${screen.meta.trendScored}/${screen.themed.length} rows have ${screen.meta.trendMinHistory} sessions`,
    true,
  );

  // Soft: the out-of-sample record. Zero is correct until the next refresh
  // runs, and it should only ever grow -- if it shrinks, a replay overwrote
  // live rows and the guarded ON CONFLICT in scripts/replay-tiers.ts is broken.
  if (process.env.DATABASE_URL) {
    const sql = neon(process.env.DATABASE_URL);
    const split = (await sql`
      SELECT source, count(DISTINCT session) AS sessions
      FROM tier_history GROUP BY source
    `) as { source: string; sessions: string }[];
    const live = Number(split.find((r) => r.source === "live")?.sessions ?? 0);
    const replay = Number(split.find((r) => r.source === "replay")?.sessions ?? 0);
    assert(
      "out-of-sample sessions are accumulating",
      live > 0,
      `${live} live, ${replay} replayed. Only live sessions are evidence; ` +
        `a 21-session horizon needs about 20 of them to leave UNDERPOWERED`,
      true,
    );

    // Split repairs. A backlog is expected -- the nightly refresh drains 25 a
    // run -- but a backlog that stops shrinking means the repair is failing
    // silently, and every stranded ticker carries a fake lookback return.
    const backlog = (await sql`
      SELECT count(*) AS n FROM splits s
      WHERE EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = s.ticker)
        AND NOT EXISTS (
          SELECT 1 FROM split_refetch r
          WHERE r.ticker = s.ticker AND r.execution_date = s.execution_date
        )
    `) as { n: string }[];
    assert(
      "split-stranded history is repaired",
      Number(backlog[0].n) === 0,
      Number(backlog[0].n) === 0
        ? "every known split has had its price history re-fetched"
        : `${backlog[0].n} splits pending; the refresh drains ${25} a night, ` +
          `and until then those tickers carry a lookback return the size of the split ratio`,
      true,
    );

    // A session that is part live and part replayed means something wrote over
    // half of it. Neither figure can be trusted after that.
    const mixed = (await sql`
      SELECT count(*) AS n FROM (
        SELECT session FROM tier_history
        GROUP BY session HAVING count(DISTINCT source) > 1
      ) t
    `) as { n: string }[];
    assert(
      "no session mixes live and replayed rows",
      Number(mixed[0].n) === 0,
      Number(mixed[0].n) === 0 ? "every session has one provenance" : `${mixed[0].n} mixed sessions`,
    );
  }

  report(false, null);
}

function report(skipped: boolean, note: string | null): void {
  const hard = checks.filter((c) => !c.soft);
  const soft = checks.filter((c) => c.soft);
  const failed = hard.filter((c) => !c.ok);

  console.log("\nData integrity\n");
  for (const c of hard) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`        ${c.detail}`);
  }
  if (soft.length > 0) {
    console.log("\nPending the backfill (warnings, not failures)\n");
    for (const c of soft) {
      console.log(`  ${c.ok ? "ok  " : "warn"}  ${c.name}`);
      console.log(`        ${c.detail}`);
    }
  }
  if (note) console.log(`\n  ${note}`);

  console.log(
    `\n${failed.length === 0 ? "Data integrity OK" : `${failed.length} check(s) FAILED`}` +
      `${skipped ? " (live checks skipped)" : ""}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error("\nAudit could not run:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
