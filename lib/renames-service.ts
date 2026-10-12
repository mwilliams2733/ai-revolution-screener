/**
 * Fetch, plan and apply one rename stitch. Server-only.
 *
 * Used by scripts/stitch-renames.ts for a first stitch, and by the split repair
 * (refresh route and scripts/refetch-splits.ts) to re-stitch a joined ticker
 * after its new symbol's history is restated. A re-stitch whose seam no longer
 * holds drops the joined bars: an unranked name is better than one ranked on
 * a series with a split's worth of discontinuity in it.
 */

import { tickerBars, tickerEvents } from "./polygon";
import {
  applyStitch,
  dropStitch,
  recentFirstSeen,
  recordRenameCheck,
  renameChecks,
  storedTradingSessions,
  tickerRenames,
} from "./db";
import {
  parseRename,
  planStitch,
  renameCandidates,
  type StitchPlan,
  type TickerEvent,
} from "./renames";
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

/** Sessions back the nightly check looks for new symbols; covers missed nights. */
export const RENAME_WINDOW_SESSIONS = 10;

export interface NightlyDeps {
  readonly candidates: () => Promise<string[]>;
  readonly events: (ticker: string) => Promise<TickerEvent[]>;
  readonly stitchDeps: () => Promise<StitchDeps>;
  readonly record: typeof recordRenameCheck;
  /** Milliseconds; injectable for the budget test. */
  readonly now: () => number;
}

export function defaultNightlyDeps(): NightlyDeps {
  let deps: Promise<StitchDeps> | null = null;
  return {
    candidates: async () => {
      const [{ recent, firstSeen }, renames, checks] = await Promise.all([
        recentFirstSeen(RENAME_WINDOW_SESSIONS),
        tickerRenames(),
        renameChecks(),
      ]);
      return renameCandidates({
        firstSeen,
        recent,
        stitched: new Set(renames.keys()),
        checks,
        now: new Date(),
      });
    },
    events: (t) => tickerEvents(t),
    stitchDeps: () => (deps ??= defaultStitchDeps()),
    record: recordRenameCheck,
    now: () => Date.now(),
  };
}

export interface NightlyResult {
  readonly checked: number;
  readonly stitched: string[];
  readonly refused: string[];
  readonly errors: number;
  /** Candidates left for the next run by the budget or the cap. */
  readonly remaining: number;
}

/**
 * Check tonight's new symbols for renames and stitch the confirmed ones.
 *
 * Every outcome is recorded except an error, which leaves the symbol to be
 * asked again. A refusal writes no bars and is final.
 */
export async function nightlyStitch(
  deps: NightlyDeps,
  opts: { readonly budgetMs: number; readonly max: number },
): Promise<NightlyResult> {
  const started = deps.now();
  const todo = await deps.candidates();
  const stitched: string[] = [];
  const refused: string[] = [];
  let checked = 0;
  let errors = 0;
  for (const ticker of todo) {
    if (checked >= opts.max || deps.now() - started >= opts.budgetMs) break;
    checked += 1;
    try {
      // A 404 is Polygon having no event record for the symbol: no rename.
      const events = await deps.events(ticker).catch((e: unknown) => {
        if (e instanceof Error && /HTTP 404/.test(e.message)) return [];
        throw e;
      });
      const rename = parseRename(ticker, events);
      if (!rename) {
        await deps.record(ticker, "none", null);
        continue;
      }
      const plan = await stitch({ newTicker: ticker, ...rename }, await deps.stitchDeps(), {
        dropOnFailure: false,
      });
      if (plan.ok) {
        stitched.push(ticker);
        await deps.record(ticker, "stitched", `from ${rename.oldTicker}`);
      } else {
        refused.push(ticker);
        await deps.record(ticker, "refused", plan.reason);
      }
    } catch {
      errors += 1;
    }
  }
  return { checked, stitched, refused, errors, remaining: todo.length - checked };
}
