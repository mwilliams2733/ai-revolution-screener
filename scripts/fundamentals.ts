/**
 * Fill company_fundamentals for every market-wide Strong Buy candidate whose
 * stored facts are missing or older than 7 days.
 *
 *   npm run fundamentals                 # everything wanted, no time budget
 *   npm run fundamentals -- --limit 50   # trial
 *
 * Resumable by set difference: re-running fetches only what is still wanted.
 * Run it BEFORE deploying the market-wide screen, or the AI book's Strong Buys
 * read as unverified and the gate demotes nothing.
 */

import { getScreen } from "../lib/screen-service";
import { defaultTopUpDeps, topUpFundamentals } from "../lib/fundamentals-topup";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

async function main(): Promise<void> {
  const screen = await getScreen(true);
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const all = screen.fundamentalsWanted;
  const wanted = Number.isFinite(limit) ? all.slice(0, limit) : [...all];
  console.log(`${all.length} candidates missing or stale; fetching ${wanted.length}`);

  const r = await topUpFundamentals(wanted, Number.POSITIVE_INFINITY, defaultTopUpDeps());
  const perFetch = r.fetched > 0 ? Math.round(r.elapsedMs / r.fetched) : null;
  console.log(
    `fetched ${r.fetched}, failed ${r.failed.length}, remaining ${r.remaining}, ` +
      `${(r.elapsedMs / 1000).toFixed(1)}s (${perFetch ?? "--"} ms per fetch)`,
  );
  if (r.failed.length) console.log(`failed: ${r.failed.join(" ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
