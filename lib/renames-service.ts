/**
 * Fetch, plan and apply one rename stitch. Server-only.
 *
 * Used by scripts/stitch-renames.ts for a first stitch, and by the split repair
 * (refresh route and scripts/refetch-splits.ts) to re-stitch a joined ticker
 * after its new symbol's history is restated. A re-stitch whose seam no longer
 * holds drops the joined bars: an unranked name is better than one ranked on
 * a series with a split's worth of discontinuity in it.
 */

import { tickerBars } from "./polygon";
import { applyStitch, dropStitch, storedTradingSessions } from "./db";
import { planStitch, type StitchPlan } from "./renames";
import { toSessionBars, type RawAggregate, type SessionBar } from "./ticker-history";

export interface StitchDeps {
  /** Stored trading sessions. */
  readonly calendar: readonly string[];
  readonly bounds: { readonly lo: string; readonly hi: string };
  readonly fetchBars: (ticker: string, from: string, to: string) => Promise<SessionBar[]>;
  readonly apply: typeof applyStitch;
  readonly drop: typeof dropStitch;
}

export async function defaultStitchDeps(): Promise<StitchDeps> {
  const calendar = await storedTradingSessions();
  const sorted = [...calendar].sort();
  return {
    calendar,
    bounds: { lo: sorted[0], hi: sorted[sorted.length - 1] },
    fetchBars: async (t, from, to) =>
      toSessionBars((await tickerBars(t, from, to)) as unknown as RawAggregate[]),
    apply: applyStitch,
    drop: dropStitch,
  };
}

export async function stitch(
  r: { readonly newTicker: string; readonly oldTicker: string; readonly changeDate: string },
  deps: StitchDeps,
  opts: { readonly dropOnFailure: boolean; readonly dry?: boolean },
): Promise<StitchPlan> {
  const [oldBars, newBars] = await Promise.all([
    deps.fetchBars(r.oldTicker, deps.bounds.lo, deps.bounds.hi),
    deps.fetchBars(r.newTicker, r.changeDate, deps.bounds.hi),
  ]);
  const plan = planStitch({ oldBars, newBars, changeDate: r.changeDate, calendar: deps.calendar });
  if (opts.dry) return plan;
  if (plan.ok) {
    await deps.apply(r.newTicker, r.oldTicker, r.changeDate, plan.rows, plan.seam);
  } else if (opts.dropOnFailure) {
    await deps.drop(r.newTicker, r.changeDate, plan.reason);
  }
  return plan;
}

/**
 * After a split repair rewrote `ticker`'s own bars: if it is a joined rename,
 * re-stitch so the old symbol's bars are on the same basis, or drop them.
 * Throws on a fetch or write error, so the caller leaves the split outstanding.
 */
export async function restitchAfterRepair(
  ticker: string,
  renames: ReadonlyMap<string, { newTicker: string; oldTicker: string; changeDate: string; status: string }>,
  getDeps: () => Promise<StitchDeps>,
): Promise<StitchPlan | null> {
  const joined = renames.get(ticker);
  if (!joined || joined.status !== "stitched") return null;
  return stitch(joined, await getDeps(), { dropOnFailure: true });
}
