/**
 * Fetch balance-sheet facts from EDGAR for the whole ranked universe, then
 * report which names would fail the guardrails.
 *
 *   npm run health                  # fetch anything not yet cached, then report
 *   npm run health -- --report      # report only, no fetching
 *   npm run health -- --limit 100   # trial
 *
 * Stores FACTS and derives judgments at read time. Thresholds are a policy
 * decision that will be tuned; re-deriving from cached facts costs nothing,
 * whereas storing a pass/fail would mean re-fetching 2,300 filings every time
 * a threshold moves.
 *
 * Resumable by set difference -- "tickers with a CIK and no cached row" --
 * never by a high-water mark, so an interrupted run resumes exactly and a newly
 * added ticker is picked up without a full re-fetch.
 */

import { neon } from "@neondatabase/serverless";
import { getScreen } from "../lib/screen-service";
import {
  DEFAULT_THRESHOLDS,
  assess,
  trailingBurn,
  type FactPoint,
  type Thresholds,
} from "../lib/solvency";
import { adjustSeries, byTicker, type Split } from "../lib/splits";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const REPORT_ONLY = has("report");
/** Top-up pass: fetch revenue for cash-burning names, to scope the runway test. */
const REVENUE_ONLY = has("revenue");
const THROTTLE_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A concept, and the namespace it lives in.
 *
 * Foreign private issuers file 20-F under IFRS and tag against `ifrs-full`,
 * not `us-gaap`. Looking only in `us-gaap` returned nothing for TSM, SAP and
 * NVO -- which then read as "unknown" rather than as companies we had declined
 * to measure. ASML and ARM, despite being ADRs, file US GAAP and need none of
 * this.
 */
interface TagRef {
  readonly ns: string;
  readonly tag: string;
}

const SHARES_TAGS: TagRef[] = [
  { ns: "dei", tag: "EntityCommonStockSharesOutstanding" },
  { ns: "ifrs-full", tag: "NumberOfSharesOutstanding" },
  { ns: "ifrs-full", tag: "NumberOfSharesIssuedAndFullyPaid" },
  { ns: "us-gaap", tag: "CommonStockSharesOutstanding" },
];

const OCF_TAGS: TagRef[] = [
  { ns: "us-gaap", tag: "NetCashProvidedByUsedInOperatingActivities" },
  { ns: "us-gaap", tag: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations" },
  { ns: "ifrs-full", tag: "CashFlowsFromUsedInOperatingActivities" },
];

/** Cash the company can actually spend, not just the line called "cash". */
const CASH_TAGS: TagRef[] = [
  { ns: "us-gaap", tag: "CashAndCashEquivalentsAtCarryingValue" },
  { ns: "us-gaap", tag: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents" },
  { ns: "ifrs-full", tag: "CashAndCashEquivalents" },
];

/**
 * Short-term investments, added to cash.
 *
 * A funded biotech keeps most of its money here, not in the cash line. Omitting
 * these understates runway several-fold and would condemn well-capitalised
 * companies -- the exact opposite of what this guardrail is for.
 */
const INVESTMENT_TAGS: TagRef[] = [
  { ns: "us-gaap", tag: "ShortTermInvestments" },
  { ns: "us-gaap", tag: "AvailableForSaleSecuritiesDebtSecuritiesCurrent" },
  { ns: "us-gaap", tag: "MarketableSecuritiesCurrent" },
  { ns: "us-gaap", tag: "OtherShortTermInvestments" },
  { ns: "ifrs-full", tag: "OtherCurrentFinancialAssets" },
];

/** Filers migrate revenue concepts; ASC 606 moved it off `Revenues`. */
const REVENUE_TAGS: TagRef[] = [
  { ns: "us-gaap", tag: "RevenueFromContractWithCustomerExcludingAssessedTax" },
  { ns: "us-gaap", tag: "RevenueFromContractWithCustomerIncludingAssessedTax" },
  { ns: "us-gaap", tag: "Revenues" },
  { ns: "us-gaap", tag: "SalesRevenueNet" },
  { ns: "ifrs-full", tag: "Revenue" },
  { ns: "ifrs-full", tag: "RevenueFromContractsWithCustomers" },
];

type Facts = { facts?: Record<string, Record<string, { units?: Record<string, FactPoint[]> }>> };

/**
 * Points for the first tag that has any, together with the unit they are in.
 *
 * A US filer reports USD. TSM reports TWD, SAP EUR, NVO DKK. The unit is
 * returned rather than assumed so the caller can keep one company's figures in
 * ONE currency -- runway is cash over burn, which is currency-free only if both
 * sides are the same currency, and silently mixing TWD cash with USD burn would
 * produce a number wrong by a factor of thirty.
 */
function factsIn(
  f: Facts,
  refs: readonly TagRef[],
  preferUnit?: string,
): { points: FactPoint[]; unit: string } | null {
  for (const ref of refs) {
    const units = f.facts?.[ref.ns]?.[ref.tag]?.units;
    if (!units) continue;
    if (preferUnit && units[preferUnit]?.length) {
      return { points: units[preferUnit], unit: preferUnit };
    }
    if (preferUnit) continue;
    // No preference yet: take USD when offered, else whichever unit carries
    // the most history.
    if (units.USD?.length) return { points: units.USD, unit: "USD" };
    const best = Object.entries(units).sort((a, b) => b[1].length - a[1].length)[0];
    if (best && best[1].length) return { points: best[1], unit: best[0] };
  }
  return null;
}

/** Latest balance-sheet value across `refs`, all in one currency and one date. */
function latestIn(f: Facts, refs: readonly TagRef[], unit: string, on: string | null): number {
  for (const ref of refs) {
    const pts = f.facts?.[ref.ns]?.[ref.tag]?.units?.[unit];
    if (!pts?.length) continue;
    const sorted = [...pts].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
    const last = sorted[sorted.length - 1];
    // Only combine figures from the same balance-sheet date; adding cash from
    // one quarter to investments from another is not a balance sheet.
    if (on == null || last.end === on) return last.val;
  }
  return 0;
}

interface Row {
  ticker: string;
  shares: FactPoint[];
  cash: number | null;
  ocf: FactPoint[];
}

async function main(): Promise<void> {
  const ua = process.env.SEC_EDGAR_USER_AGENT;
  const sql = neon(process.env.DATABASE_URL!);

  await sql`
    CREATE TABLE IF NOT EXISTS company_health (
      ticker      TEXT PRIMARY KEY,
      shares      JSONB,
      cash        DOUBLE PRECISION,
      ocf         JSONB,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE company_health ADD COLUMN IF NOT EXISTS revenue DOUBLE PRECISION`;

  // --- revenue top-up -------------------------------------------------------
  // Only cash-burning names need it: revenue exists here solely to decide
  // whether the runway test applies, and a company that is not burning is
  // never asked.
  if (REVENUE_ONLY) {
    if (!ua) { console.error("SEC_EDGAR_USER_AGENT is not set."); process.exitCode = 1; return; }
    const cached = (await sql`
      SELECT ticker, ocf FROM company_health WHERE revenue IS NULL
    `) as { ticker: string; ocf: FactPoint[] | null }[];
    const burners = cached.filter((c) => {
      const b = trailingBurn(c.ocf ?? []);
      return b != null && b.annual < 0;
    });
    const ciks = new Map(
      ((await sql`SELECT ticker, cik FROM tickers WHERE cik IS NOT NULL`) as
        { ticker: string; cik: string }[]).map((r) => [r.ticker, r.cik]),
    );
    const todo = burners.filter((b) => ciks.has(b.ticker))
      .slice(0, LIMIT === Infinity ? undefined : LIMIT);
    console.log(`${todo.length} cash-burning companies need revenue
`);

    let n = 0;
    const batch: { ticker: string; revenue: number }[] = [];
    const flushRev = async () => {
      if (!batch.length) return;
      await sql`
        UPDATE company_health AS h SET revenue = v.revenue
        FROM (SELECT * FROM UNNEST(
          ${batch.map((b) => b.ticker)}::text[],
          ${batch.map((b) => b.revenue)}::float8[]
        ) AS t(ticker, revenue)) AS v
        WHERE h.ticker = v.ticker
      `;
      batch.length = 0;
    };

    for (const b of todo) {
      try {
        const res = await fetch(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${ciks.get(b.ticker)}.json`,
          { headers: { "User-Agent": ua, Accept: "application/json" } },
        );
        if (res.ok) {
          const f = (await res.json()) as Facts;
          // Revenue must be in the SAME currency as the burn it will be
          // compared against, so the reporting currency is fixed by the cash
          // flow statement first and revenue is read in that unit.
          const ocfUnit = factsIn(f, OCF_TAGS)?.unit ?? "USD";
          const rev = factsIn(f, REVENUE_TAGS, ocfUnit) ?? factsIn(f, REVENUE_TAGS);
          // Same trailing-twelve-month machinery as the burn; revenue is
          // reported cumulatively in exactly the same way.
          const ttm = rev ? trailingBurn(rev.points) : null;
          batch.push({ ticker: b.ticker, revenue: ttm?.annual ?? 0 });
        } else {
          batch.push({ ticker: b.ticker, revenue: 0 });
        }
      } catch {
        batch.push({ ticker: b.ticker, revenue: 0 });
      }
      n += 1;
      if (batch.length >= 100) await flushRev();
      if (n % 200 === 0) console.log(`  ${n}/${todo.length}`);
      await sleep(THROTTLE_MS);
    }
    await flushRev();
    console.log(`
revenue fetched for ${n} companies
`);
  }

  if (!REPORT_ONLY && !REVENUE_ONLY) {
    if (!ua) {
      console.error("SEC_EDGAR_USER_AGENT is not set. EDGAR rejects anonymous clients.");
      process.exitCode = 1;
      return;
    }
    const todo = (
      (await sql`
        SELECT k.ticker, k.cik FROM tickers k
        WHERE k.cik IS NOT NULL
          AND EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = k.ticker)
          AND NOT EXISTS (SELECT 1 FROM company_health h WHERE h.ticker = k.ticker)
        ORDER BY k.ticker
      `) as { ticker: string; cik: string }[]
    ).slice(0, LIMIT === Infinity ? undefined : LIMIT);

    console.log(`${todo.length.toLocaleString()} companies to fetch\n`);
    const started = Date.now();
    let done = 0;
    let failed = 0;
    const batch: Row[] = [];

    const flush = async () => {
      if (!batch.length) return;
      await sql`
        INSERT INTO company_health (ticker, shares, cash, ocf)
        SELECT * FROM UNNEST(
          ${batch.map((b) => b.ticker)}::text[],
          ${batch.map((b) => JSON.stringify(b.shares))}::jsonb[],
          ${batch.map((b) => b.cash)}::float8[],
          ${batch.map((b) => JSON.stringify(b.ocf))}::jsonb[]
        ) AS t(ticker, shares, cash, ocf)
        ON CONFLICT (ticker) DO UPDATE SET
          shares = EXCLUDED.shares, cash = EXCLUDED.cash,
          ocf = EXCLUDED.ocf, fetched_at = now()
      `;
      batch.length = 0;
    };

    for (const t of todo) {
      try {
        const res = await fetch(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${t.cik}.json`,
          { headers: { "User-Agent": ua, Accept: "application/json" } },
        );
        if (res.status === 404) {
          // A real answer: nothing filed. Cache it empty so it is not retried
          // on every run.
          batch.push({ ticker: t.ticker, shares: [], cash: null, ocf: [] });
        } else if (!res.ok) {
          failed += 1;
        } else {
          const f = (await res.json()) as Facts;
          const shares = factsIn(f, SHARES_TAGS, "shares")?.points ?? [];
          const ocfFacts = factsIn(f, OCF_TAGS);
          const ocf = ocfFacts?.points ?? [];
          // One company, one currency. The cash flow statement sets it and the
          // balance sheet follows; a TWD cash figure over a USD burn would be
          // wrong by a factor of thirty and look entirely plausible.
          const unit = ocfFacts?.unit ?? "USD";
          const cashFacts = factsIn(f, CASH_TAGS, unit);
          const on = cashFacts?.points.length
            ? [...cashFacts.points].sort((a, b) => Date.parse(a.end) - Date.parse(b.end)).slice(-1)[0].end
            : null;
          const cash = on == null
            ? null
            : latestIn(f, CASH_TAGS, unit, on) + latestIn(f, INVESTMENT_TAGS, unit, on);
          // Keep only what the maths needs: the last three years of points.
          const cut = Date.now() - 3 * 365 * 86_400_000;
          const recent = (ps: FactPoint[]) => ps.filter((p) => Date.parse(p.end) >= cut);
          batch.push({ ticker: t.ticker, shares: recent(shares), cash, ocf: recent(ocf) });
        }
      } catch {
        failed += 1;
      }
      done += 1;
      if (batch.length >= 100) await flush();
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(
          `  ${done}/${todo.length}  ${rate.toFixed(1)}/s  ${failed} failed  ` +
            `~${(((todo.length - done) / rate) / 60).toFixed(1)} min left`,
        );
      }
      await sleep(THROTTLE_MS);
    }
    await flush();
    console.log(`\nfetched ${done}, ${failed} failed, ${((Date.now() - started) / 60_000).toFixed(1)} min\n`);
  }

  // --- report ---------------------------------------------------------------
  const screen = await getScreen();
  const cached = new Map(
    ((await sql`SELECT ticker, shares, cash, ocf, revenue FROM company_health`) as {
      ticker: string; shares: FactPoint[] | null; cash: number | null;
      ocf: FactPoint[] | null; revenue: number | null;
    }[]).map((r) => [r.ticker, r]),
  );

  // Cover-page share counts are never restated for splits, so they must be
  // adjusted before any year-on-year comparison. See lib/splits.ts.
  const splits = byTicker(
    ((await sql`
      SELECT ticker, execution_date::text AS execution_date, split_from, split_to FROM splits
    `) as { ticker: string; execution_date: string; split_from: number; split_to: number }[])
      .map((r): Split => ({
        ticker: r.ticker,
        executionDate: r.execution_date,
        from: Number(r.split_from),
        to: Number(r.split_to),
      })),
  );

  const t: Thresholds = DEFAULT_THRESHOLDS;
  console.log(
    `thresholds: market cap >= $${(t.minMarketCap / 1e6).toFixed(0)}M, ` +
      `dilution <= ${(t.maxDilution * 100).toFixed(0)}%/yr, runway >= ${t.minRunwayMonths} months\n`,
  );

  const judged = screen.leaders.map((r) => {
    const c = cached.get(r.ticker);
    const h = assess(
      {
        price: r.price,
        shares: adjustSeries(c?.shares ?? [], splits.get(r.ticker) ?? []),
        cash: c?.cash ?? null,
        operatingCashFlow: c?.ocf ?? [],
        revenue: c?.revenue ?? null,
      },
      t,
    );
    return { row: r, health: h };
  });

  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const j of judged) counts[j.health.verdict] += 1;
  console.log(
    `ranked universe ${screen.leaders.length}: ` +
      `${counts.pass} pass, ${counts.fail} FAIL, ${counts.unknown} unknown\n`,
  );

  const byReason = new Map<string, number>();
  for (const j of judged) for (const f of j.health.failures) byReason.set(f, (byReason.get(f) ?? 0) + 1);
  console.log("failures by reason:");
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(14)}${String(n).padStart(5)}`);
  }

  // What matters most: names currently ON the screen that would be dropped.
  const inTheme = judged.filter((j) => j.row.inTheme && j.health.verdict === "fail");
  console.log(`\nTHEME NAMES THAT WOULD FAIL (${inTheme.length} of ${screen.themed.length}):`);
  if (!inTheme.length) console.log("  none");
  for (const j of inTheme.sort((a, b) => (b.row.rsPct ?? 0) - (a.row.rsPct ?? 0))) {
    const h = j.health;
    const bits = [
      h.marketCap == null ? "cap --" : `cap $${(h.marketCap / 1e6).toFixed(0)}M`,
      h.dilution == null ? "dil --" : `dil ${(h.dilution.growth * 100).toFixed(0)}%`,
      h.runway == null ? "runway n/a" : `runway ${h.runway.toFixed(0)}mo`,
    ].join("  ");
    console.log(
      `  ${j.row.ticker.padEnd(6)} RS ${String(Math.round(j.row.rsPct ?? 0)).padStart(3)}  ` +
        `${(j.row.tier ?? "--").padEnd(11)} ${bits}   [${h.failures.join(", ")}]`,
    );
  }

  // And the reverse: strong names currently EXCLUDED by the $5 floor that the
  // guardrails would admit.
  const admitted = judged.filter(
    (j) => j.row.price < 5 && j.health.verdict !== "fail",
  );
  console.log(`\nSUB-$5 NAMES THE GUARDRAILS WOULD ADMIT (${admitted.length}):`);
  for (const j of admitted.sort((a, b) => (b.row.rsPct ?? 0) - (a.row.rsPct ?? 0)).slice(0, 20)) {
    const h = j.health;
    console.log(
      `  ${j.row.ticker.padEnd(6)} $${j.row.price.toFixed(2).padStart(5)}  ` +
        `RS ${String(Math.round(j.row.rsPct ?? 0)).padStart(3)}  ${j.row.sector.padEnd(22)}` +
        `${h.marketCap == null ? "cap --" : `cap $${(h.marketCap / 1e6).toFixed(0)}M`}  ${h.verdict}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
