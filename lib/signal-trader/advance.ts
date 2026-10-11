/**
 * The morning job: process every settled, unprocessed session on or after
 * live_start, in order, one transaction per session.
 *
 * Completeness is per unit -- "is session s in st_sessions?" -- never "how far
 * did we get". Runs after the 12:00 UTC refresh has stored yesterday's settled
 * bar; a run that finds nothing new does nothing and says so.
 */
import { ST_CONFIG } from "./config";
import { advanceSession } from "./engine";
import { splitHistory } from "../db";
import { buildMarket, contextFor, splitFactors } from "./scan";
import {
  finishRun, loadState, loadUniverseBars, persistSession, processedSessions, startRun, storedSessionsAsc,
} from "./store";

export interface AdvanceReport {
  readonly dryRun: boolean;
  readonly processed: { session: string; picks: number; fills: number; exits: number; notes: string[] }[];
  readonly remaining: number;
  readonly note: string;
}

export async function backlog(): Promise<{ todo: string[]; stored: string[]; latestStored: string | null; lastProcessed: string | null }> {
  const [stored, done] = await Promise.all([storedSessionsAsc(), processedSessions()]);
  const todo = stored.filter((s) => s >= ST_CONFIG.job.live_start && !done.has(s));
  const processed = [...done].sort();
  return { todo, stored, latestStored: stored.at(-1) ?? null, lastProcessed: processed.at(-1) ?? null };
}

export async function runAdvance(opts: { now?: Date; dryRun?: boolean } = {}): Promise<AdvanceReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const runId = dryRun ? null : await startRun("advance");
  try {
    const { todo, stored } = await backlog();
    const batch = todo.slice(0, ST_CONFIG.job.max_sessions_per_run);
    if (batch.length === 0) {
      const report = { dryRun, processed: [], remaining: 0, note: "nothing to do: no settled session is waiting" };
      if (runId !== null) await finishRun(runId, "ok", report.note);
      return report;
    }
    const market = buildMarket(await loadUniverseBars(ST_CONFIG.universe));
    // Bars are split-adjusted; positions are not. A failed read here must stop
    // the run: trading through a split without it books a fake stop-out.
    const splits = await splitHistory();
    let state = await loadState();
    const processed: AdvanceReport["processed"] = [];
    for (const s of batch) {
      const previous = stored[stored.indexOf(s) - 1] ?? null;
      const factors = splitFactors(splits, previous, s);
      const out = advanceSession(state, contextFor(market, s, now, ST_CONFIG, factors));
      if (!dryRun) await persistSession(out, out.notes.join(" | "));
      processed.push({ session: s, picks: out.newPicks.length, fills: out.fills.length, exits: out.exits.length, notes: out.notes });
      state = out.state;
    }
    const report = {
      dryRun, processed, remaining: todo.length - batch.length,
      note: `processed ${processed.map((p) => p.session).join(", ")}`,
    };
    if (runId !== null) await finishRun(runId, "ok", report.note);
    return report;
  } catch (e) {
    if (runId !== null) await finishRun(runId, "error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
