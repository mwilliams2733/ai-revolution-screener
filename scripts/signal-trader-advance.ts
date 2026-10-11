/**
 * Run the Signal Trader morning job by hand.
 *   npm run signal-trader:advance -- --dry-run   # compute, write nothing
 *   npm run signal-trader:advance                # the real thing (same as the cron)
 */
import { runAdvance } from "../lib/signal-trader/advance";

runAdvance({ dryRun: process.argv.includes("--dry-run") })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
