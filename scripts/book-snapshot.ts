/**
 * Print the AI book's tiers and the screen's timing as JSON.
 *
 *   npm run book:snapshot > before.json
 *
 * Used to prove a pipeline change leaves the book alone: capture before and
 * after on the same asOf and diff. Each run is a fresh process, so elapsedMs
 * is a cold-start figure.
 */

import { getScreen } from "../lib/screen-service";

async function main(): Promise<void> {
  const s = await getScreen(true);
  const payload = s as unknown as Record<string, unknown>;
  const market = (payload.market ?? payload.leaders) as unknown[];
  console.log(
    JSON.stringify(
      {
        asOf: s.asOf,
        elapsedMs: s.meta.elapsedMs,
        warnings: s.meta.warnings,
        marketRows: market.length,
        marketBytes: JSON.stringify(market).length,
        counters: {
          demoted: s.demoted,
          capped: s.capped,
          capHeld: s.capHeld,
          healthCapped: s.healthCapped,
          stageDemoted: s.stageDemoted,
          held: s.held,
        },
        book: s.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, bandTier: r.bandTier })),
        portfolio: s.portfolio.map((r) => r.ticker),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
