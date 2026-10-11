/**
 * From stored bars to the engine's per-session context, and an in-memory
 * replay over history (dry runs, parity checks, tests). Pure.
 *
 * Features are computed once per ticker over its whole history; the value at a
 * session's index uses only bars up to that session.
 */
import { settleInstant } from "../session-ledger";
import { ST_CONFIG, SIGNAL_NAMES, type SignalName, type StConfig } from "./config";
import { advanceSession, type EngineState, type SessionContext, type SessionOutcome } from "./engine";
import { addFeatures, type Features } from "./indicators";
import { fires } from "./signals";
import type { Bar } from "./types";

export interface Market {
  readonly bars: Map<string, Bar[]>;
  readonly features: Map<string, Features>;
  readonly index: Map<string, Map<string, number>>;
}

export function buildMarket(bars: Map<string, Bar[]>): Market {
  const features = new Map<string, Features>();
  const index = new Map<string, Map<string, number>>();
  for (const [ticker, list] of bars) {
    features.set(ticker, addFeatures(list));
    index.set(ticker, new Map(list.map((b, i) => [b.session, i])));
  }
  return { bars, features, index };
}

export function signalsFiring(
  m: Market,
  ticker: string,
  session: string,
  cfg: StConfig = ST_CONFIG,
): SignalName[] {
  const i = m.index.get(ticker)?.get(session);
  const f = m.features.get(ticker);
  if (i === undefined || !f) return [];
  return SIGNAL_NAMES.filter((name) => fires(cfg.signals[name].rule, f, i, cfg.cutoffs));
}

export function contextFor(
  m: Market,
  session: string,
  now: Date,
  cfg: StConfig = ST_CONFIG,
): SessionContext {
  const fired = new Map<string, SignalName[]>();
  for (const ticker of cfg.universe) {
    const names = signalsFiring(m, ticker, session, cfg);
    if (names.length) fired.set(ticker, names);
  }
  return {
    session,
    now,
    fired,
    barOf: (ticker, s) => {
      const i = m.index.get(ticker)?.get(s);
      return i === undefined ? undefined : m.bars.get(ticker)?.[i];
    },
  };
}

export function startState(cfg: StConfig = ST_CONFIG): EngineState {
  return { cash: cfg.sizing.starting_cash, paused: false, pending: [], open: [] };
}

export function replay(
  m: Market,
  sessions: readonly string[],
  cfg: StConfig = ST_CONFIG,
  nowFor: (session: string) => Date = (s) => settleInstant(s),
): { outcomes: SessionOutcome[]; state: EngineState } {
  let state = startState(cfg);
  const outcomes: SessionOutcome[] = [];
  for (const s of sessions) {
    const out = advanceSession(state, contextFor(m, s, nowFor(s), cfg), cfg);
    outcomes.push(out);
    state = out.state;
  }
  return { outcomes, state };
}
