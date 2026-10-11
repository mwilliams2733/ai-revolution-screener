/**
 * Signal Trader configuration. Quarterly re-validation edits this file, not
 * code (spec section 4, rule 5). Long only and stock only (owner decisions,
 * 2026-10-10): options are deferred because qualifying calls cost $16-$51 a
 * share against a $1.50 cap, and the plan's snapshot carries no ask.
 *
 * Signal order is priority: when several fire on one ticker the same day, the
 * first listed is traded and the rest are logged.
 */
import cutoffsFile from "./cutoffs.json";
import type { Cutoffs, LongRule } from "./signals";

export type SignalName = "vol_spike" | "vol_z" | "intraday" | "mom_20" | "bb_pctb";

export interface SignalSpec {
  readonly rule: LongRule;
  readonly window_days: number;
  /** The lab's raw test-set mean forward return over window_days. */
  readonly expected_move: number;
  /** The lab's test-set hit rate. */
  readonly lab_hit: number;
  readonly label: string;
}

export const ST_CONFIG = {
  universe: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMD", "META", "AMZN", "GOOGL", "JPM", "XOM"],
  benchmark: "SPY",
  signals: {
    vol_spike: { rule: "vol_spike", window_days: 10, expected_move: 0.0234, lab_hit: 0.623, label: "Volume spike" },
    vol_z: { rule: "vol_z__long", window_days: 20, expected_move: 0.0304, lab_hit: 0.663, label: "High volume z" },
    intraday: { rule: "intraday__long", window_days: 10, expected_move: 0.0202, lab_hit: 0.592, label: "Strong intraday drift" },
    mom_20: { rule: "mom_20__long", window_days: 10, expected_move: 0.0316, lab_hit: 0.644, label: "20-day momentum" },
    bb_pctb: { rule: "bb_pctb__long", window_days: 3, expected_move: 0.0078, lab_hit: 0.609, label: "Bollinger %B high" },
  } satisfies Record<SignalName, SignalSpec>,
  sizing: { stock_notional: 1000, starting_cash: 100000 },
  exits: { stock_stop: 0.08 },
  grading: { min_episodes: 30 },
  job: {
    max_sessions_per_run: 5,
    /** First session the live system trades; set when the tab shipped. */
    live_start: "2026-10-08",
  },
  cutoffs: cutoffsFile.cutoffs as Cutoffs,
} as const;

export type StConfig = typeof ST_CONFIG;
export const SIGNAL_NAMES = Object.keys(ST_CONFIG.signals) as SignalName[];
