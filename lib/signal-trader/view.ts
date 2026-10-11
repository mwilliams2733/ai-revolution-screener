/**
 * Everything the Signal Trader page shows, read once on the server.
 * The Lab section re-runs the ported engine on stored bars with the SHIPPED
 * cutoffs (not refit): do the configured signals still hold up?
 */
import { ST_CONFIG, SIGNAL_NAMES, type SignalName } from "./config";
import { buildPanel, clustered, excessMean, ruleFirings, stats } from "./evaluate";
import { scoreSignals, type SignalScore } from "./grading";
import { buildMarket } from "./scan";
import {
  loadUniverseBars, readAccount, readGrades, readLastProcessed, readLastRun, readOpenPositions, readPicks,
  readRecentSignals, storedSessionsAsc, type PickRow,
} from "./store";

export interface LabRow { signal: SignalName; label: string; window: number; n: number; episodes: number; mean: number; hit: number; tDates: number; excess: number | null; expected: number }

export interface SignalTraderView {
  cash: number; equity: number; paused: boolean;
  latestStored: string | null; lastProcessed: string | null; behind: number;
  lastRun: Awaited<ReturnType<typeof readLastRun>>;
  picks: PickRow[];
  positions: Awaited<ReturnType<typeof readOpenPositions>>;
  sessionsLeft: Record<string, number>;
  scores: SignalScore[];
  lab: LabRow[];
  recentSignals: Awaited<ReturnType<typeof readRecentSignals>>;
}

export async function getSignalTraderView(): Promise<SignalTraderView> {
  const [sessions, account, positions, grades, lastProcessed, lastRun] = await Promise.all([
    storedSessionsAsc(), readAccount(), readOpenPositions(), readGrades(), readLastProcessed(), readLastRun("advance"),
  ]);
  const indexOf = (s: string) => {
    const k = sessions.indexOf(s);
    return k >= 0 ? k : sessions.length;
  };
  const since = sessions[Math.max(0, sessions.length - 30)] ?? ST_CONFIG.job.live_start;
  const [picks, recentSignals] = await Promise.all([readPicks(since), readRecentSignals(since)]);
  const latestStored = sessions.at(-1) ?? null;
  const behind = sessions.filter((s) => s >= ST_CONFIG.job.live_start && (!lastProcessed || s > lastProcessed)).length;

  const equity = account.cash + positions.reduce((a, p) => a + p.qty * (p.lastMark ?? p.entryPrice), 0);
  const sessionsLeft = Object.fromEntries(positions.map((p) => [p.key, Math.max(0, p.windowDays - p.sessionsHeld)]));

  // Lab: shipped cutoffs on every stored session.
  const bars = await loadUniverseBars(ST_CONFIG.universe);
  const market = buildMarket(bars);
  const windows = [...new Set(SIGNAL_NAMES.map((n) => ST_CONFIG.signals[n].window_days))];
  const panel = buildPanel(bars, windows);
  const spy = new Map(panel.rows.filter((r) => r.ticker === ST_CONFIG.benchmark).map((r) => [r.session, r.fwd]));
  const lab: LabRow[] = SIGNAL_NAMES.map((signal) => {
    const spec = ST_CONFIG.signals[signal];
    const H = spec.window_days;
    const f = ruleFirings(panel.rows, market.features, spec.rule, ST_CONFIG.cutoffs, H);
    const s = stats(f.map((r) => r.fwd[H]));
    const c = clustered(f, H, sessions);
    return { signal, label: spec.label, window: H, n: s.n, episodes: c.episodes, mean: s.mean, hit: s.hit, tDates: c.tDates, excess: excessMean(f, spy, H), expected: spec.expected_move };
  });

  return {
    cash: account.cash, equity, paused: account.paused, latestStored, lastProcessed, behind, lastRun,
    picks, positions, sessionsLeft,
    scores: scoreSignals(grades, indexOf, sessions.length - 1),
    lab, recentSignals,
  };
}
