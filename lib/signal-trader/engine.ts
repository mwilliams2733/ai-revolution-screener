/**
 * The paper engine: advance paper state by ONE settled session. Pure.
 *
 * Order inside a session matters and mirrors the clock:
 *   1. fill pending picks at this session's open, if decided before it opened
 *      and auto-trade is not paused (pause holds fills too);
 *   2. exits and marks on this session's bar (manual close, gap through the
 *      stop, intraday stop, window end), else mark at the close;
 *   3. scan this session's close for new picks, which fill at a LATER open.
 *
 * Long only, stock only, fixed notional. Everything here is paper.
 */
import { marketOpenInstant } from "../session-ledger";
import { ST_CONFIG, type SignalName, type StConfig } from "./config";
import type { Bar } from "./types";

export interface PendingPick {
  readonly key: string;
  readonly ticker: string;
  readonly signal: SignalName;
  readonly decidedSession: string;
  /** When the job created it; decides which open it may fill at. */
  readonly createdAt: string;
  readonly windowDays: number;
  readonly expectedMove: number;
}

export interface OpenPosition {
  readonly key: string;
  readonly ticker: string;
  readonly signal: SignalName;
  readonly qty: number;
  readonly entryPrice: number;
  readonly entrySession: string;
  readonly stopPrice: number;
  /** Sessions processed while open, the entry session included. */
  readonly sessionsHeld: number;
  readonly windowDays: number;
  readonly expectedMove: number;
  readonly closeRequestedAt: string | null;
}

export interface EngineState {
  readonly cash: number;
  readonly paused: boolean;
  readonly pending: readonly PendingPick[];
  readonly open: readonly OpenPosition[];
}

export type ExitReason = "window" | "stop" | "stop_gap" | "manual";

export interface Fill { readonly key: string; readonly session: string; readonly side: "buy" | "sell"; readonly qty: number; readonly price: number; readonly note: string }
export interface Exit { readonly key: string; readonly ticker: string; readonly signal: SignalName; readonly session: string; readonly price: number; readonly reason: ExitReason; readonly realizedReturn: number; readonly pnl: number; readonly qty: number; readonly entryPrice: number }
export interface Grade {
  readonly key: string; readonly signal: SignalName; readonly ticker: string;
  readonly entrySession: string; readonly exitSession: string;
  readonly realizedReturn: number; readonly spyReturn: number | null; readonly excessReturn: number | null;
  readonly hit: boolean; readonly pnl: number; readonly expectedMove: number;
}
export interface Mark { readonly key: string; readonly session: string; readonly price: number }
export interface SignalLog { readonly session: string; readonly ticker: string; readonly signal: SignalName; readonly acted: boolean; readonly note: string }
export interface Cancelled { readonly key: string; readonly note: string }

export interface SessionContext {
  readonly session: string;
  readonly now: Date;
  readonly barOf: (ticker: string, session: string) => Bar | undefined;
  /** Signals firing on this session's close, per ticker, in config order. */
  readonly fired: ReadonlyMap<string, readonly SignalName[]>;
  /**
   * Price factor (split_from / split_to) for splits that took effect at this
   * session's open, per ticker: 0.5 for a 2-for-1. Bars are split-adjusted, so
   * a position bought before the split must be restated on the new basis or
   * its first post-split open reads as a gap through the stop.
   */
  readonly splits?: ReadonlyMap<string, number>;
}

export interface SessionOutcome {
  readonly session: string;
  readonly fills: Fill[];
  readonly opened: OpenPosition[];
  readonly exits: Exit[];
  readonly grades: Grade[];
  readonly marks: Mark[];
  readonly newPicks: PendingPick[];
  readonly cancelled: Cancelled[];
  readonly signals: SignalLog[];
  readonly notes: string[];
  readonly state: EngineState;
}

export function pickKey(session: string, ticker: string, signal: SignalName): string {
  return `${session}:${ticker}:${signal}`;
}

export function advanceSession(
  state: EngineState,
  ctx: SessionContext,
  cfg: StConfig = ST_CONFIG,
): SessionOutcome {
  const { session, now } = ctx;
  const openAt = marketOpenInstant(session).getTime();
  const fills: Fill[] = [];
  const opened: OpenPosition[] = [];
  const exits: Exit[] = [];
  const grades: Grade[] = [];
  const marks: Mark[] = [];
  const newPicks: PendingPick[] = [];
  const cancelled: Cancelled[] = [];
  const signals: SignalLog[] = [];
  const notes: string[] = [];
  let cash = state.cash;

  // 1. Fills.
  const pending: PendingPick[] = [];
  const open: OpenPosition[] = [...state.open];
  for (const p of state.pending) {
    if (p.decidedSession >= session || Date.parse(p.createdAt) >= openAt) {
      pending.push(p);
      continue;
    }
    // Pause holds fills as well as new picks (owner, 2026-10-10). Open
    // positions are still managed: stops and window exits keep running.
    if (state.paused) {
      pending.push(p);
      notes.push(`${p.key}: held, auto-trade paused`);
      continue;
    }
    const bar = ctx.barOf(p.ticker, session);
    if (!bar) {
      pending.push(p);
      notes.push(`${p.ticker}: no bar for ${session}; ${p.key} stays pending`);
      continue;
    }
    const notional = cfg.sizing.stock_notional;
    if (cash < notional) {
      cancelled.push({ key: p.key, note: `cash ${cash.toFixed(2)} is below the $${notional} notional` });
      continue;
    }
    const qty = notional / bar.open;
    cash -= notional;
    const pos: OpenPosition = {
      key: p.key, ticker: p.ticker, signal: p.signal, qty, entryPrice: bar.open,
      entrySession: session, stopPrice: bar.open * (1 - cfg.exits.stock_stop),
      sessionsHeld: 0, windowDays: p.windowDays, expectedMove: p.expectedMove, closeRequestedAt: null,
    };
    open.push(pos);
    opened.push(pos);
    fills.push({ key: p.key, session, side: "buy", qty, price: bar.open, note: "PAPER buy at the open" });
  }

  // 2. Exits and marks.
  const still: OpenPosition[] = [];
  for (const pos of open) {
    const factor = ctx.splits?.get(pos.ticker);
    const p =
      factor && pos.entrySession < session
        ? { ...pos, qty: pos.qty / factor, entryPrice: pos.entryPrice * factor, stopPrice: pos.stopPrice * factor }
        : pos;
    if (p !== pos) notes.push(`${p.ticker}: split at ${session} open (price x${factor}); ${p.key} restated`);
    const bar = ctx.barOf(p.ticker, session);
    if (!bar) {
      still.push(p);
      notes.push(`${p.ticker}: no bar for ${session}; ${p.key} not marked`);
      continue;
    }
    const held = p.sessionsHeld + 1;
    const enteredBefore = p.entrySession < session;
    let exit: { price: number; reason: ExitReason } | null = null;
    if (enteredBefore && p.closeRequestedAt && Date.parse(p.closeRequestedAt) < openAt) {
      exit = { price: bar.open, reason: "manual" };
    } else if (enteredBefore && bar.open <= p.stopPrice) {
      exit = { price: bar.open, reason: "stop_gap" };
    } else if (bar.low <= p.stopPrice) {
      exit = { price: p.stopPrice, reason: "stop" };
    } else if (held >= p.windowDays) {
      exit = { price: bar.close, reason: "window" };
    }
    if (!exit) {
      still.push({ ...p, sessionsHeld: held });
      marks.push({ key: p.key, session, price: bar.close });
      continue;
    }
    const proceeds = p.qty * exit.price;
    cash += proceeds;
    const pnl = proceeds - p.qty * p.entryPrice;
    const realizedReturn = exit.price / p.entryPrice - 1;
    fills.push({ key: p.key, session, side: "sell", qty: p.qty, price: exit.price, note: `PAPER sell (${exit.reason})` });
    exits.push({ key: p.key, ticker: p.ticker, signal: p.signal, session, price: exit.price, reason: exit.reason, realizedReturn, pnl, qty: p.qty, entryPrice: p.entryPrice });
    const spyIn = ctx.barOf(cfg.benchmark, p.entrySession)?.open;
    const spyOut = ctx.barOf(cfg.benchmark, session)?.close;
    const spyReturn = spyIn && spyOut ? spyOut / spyIn - 1 : null;
    grades.push({
      key: p.key, signal: p.signal, ticker: p.ticker, entrySession: p.entrySession, exitSession: session,
      realizedReturn, spyReturn, excessReturn: spyReturn === null ? null : realizedReturn - spyReturn,
      hit: realizedReturn > 0, pnl, expectedMove: p.expectedMove,
    });
  }

  // 3. Scan this close.
  const busy = new Set([...pending.map((p) => p.ticker), ...still.map((p) => p.ticker)]);
  for (const ticker of cfg.universe) {
    let acted = false;
    for (const signal of ctx.fired.get(ticker) ?? []) {
      const note = state.paused
        ? "auto-trade paused"
        : acted
          ? "another signal acted for this ticker"
          : busy.has(ticker)
            ? "ticker already has an open pick"
            : "";
      if (note) {
        signals.push({ session, ticker, signal, acted: false, note });
        continue;
      }
      const spec = cfg.signals[signal];
      const p: PendingPick = {
        key: pickKey(session, ticker, signal), ticker, signal, decidedSession: session,
        createdAt: now.toISOString(), windowDays: spec.window_days, expectedMove: spec.expected_move,
      };
      pending.push(p);
      newPicks.push(p);
      busy.add(ticker);
      acted = true;
      signals.push({ session, ticker, signal, acted: true, note: "PAPER pick created" });
    }
  }

  return {
    session, fills, opened, exits, grades, marks, newPicks, cancelled, signals, notes,
    state: { cash, paused: state.paused, pending, open: still },
  };
}
