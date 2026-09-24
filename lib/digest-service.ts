/**
 * Build the morning digest from live data. Server-only.
 *
 * One function for both callers -- the /api/digest route and
 * scripts/preview-digest.ts -- so the preview shows exactly what the route
 * would send. Two copies of this logic would drift the first time someone
 * changed one of them.
 *
 * Composition only: no mail, no ledger. Those stay in the route.
 */

import { getScreen, type ScreenPayload } from "./screen-service";
import { previousTiers } from "./db";
import { diffTiers } from "./alerts";
import { buildDigest, tierCounts, type BaselineState, type Digest } from "./digest";
import { buildRefreshStamp } from "./refresh-stamp";

export interface ComposedDigest {
  readonly digest: Digest;
  readonly screen: ScreenPayload;
  readonly baseline: BaselineState;
}

/**
 * @param force recompute the screen instead of using the 15-minute memo. The
 *              route leaves this false; the preview script passes true so it
 *              always shows current data.
 */
export async function composeDigest(force = false): Promise<ComposedDigest> {
  const screen = await getScreen(force);

  // Diff against the previous session, exactly as the alert does. Three
  // non-live outcomes are kept apart on purpose: "no earlier session",
  // "earlier session is a replay" and "the lookup failed" are different
  // facts, and the last one is the kind of failure this email exists to
  // surface, so it must not be reported as one of the other two.
  let baseline: BaselineState;
  let previousTierMap: ReadonlyMap<string, string> = new Map();
  try {
    const previous = await previousTiers(screen.asOf);
    if (!previous) baseline = "none";
    else {
      baseline = previous.source;
      previousTierMap = previous.tiers;
    }
  } catch {
    baseline = "unavailable";
  }
  const changes =
    baseline === "live"
      ? diffTiers(
          previousTierMap,
          screen.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, rsPct: r.rsPct, vsMa: r.vsMa })),
        )
      : [];

  const counts = tierCounts(screen.themed);
  const digest = buildDigest({
    asOf: screen.asOf,
    sessionsBehind: screen.staleness.sessionsBehind,
    stalenessLabel: screen.staleness.label,
    universeSize: screen.universeSize,
    themedCount: screen.themed.length,
    ...counts,
    changes,
    baseline,
    stageCapped: screen.stageDemoted,
    gateDemoted: screen.demoted,
    cappedOut: screen.capped,
    healthCapped: screen.healthCapped,
    warnings: screen.meta.warnings,
    // The book is the Strong Buys after every overlay, already in rank order.
    book: screen.themed
      .filter((r) => r.tier === "Strong Buy")
      .map((r) => ({ ticker: r.ticker, rsPct: r.rsPct, vsMa: r.vsMa })),
    refreshLine: screen.lastRefresh
      ? buildRefreshStamp(screen.lastRefresh, new Date()).detail
      : null,
  });

  return { digest, screen, baseline };
}
