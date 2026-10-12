/**
 * Ticker renames: joining a company's history across a change of symbol.
 *
 * Bars are keyed by symbol, so when MPW became MPT on 2026-02-02 every bar
 * before that day stayed under MPW and MPT looked like a new listing, unranked
 * for a year. A stitch copies the old symbol's bars under the new one for the
 * sessions before the change. It is refused unless the two series meet on
 * adjacent sessions at a believable price, because a gap or a jump means a
 * split, a reused symbol or a different security -- not a rename.
 *
 * Pure: the stitch script and the split repair both plan with planStitch, so
 * a first stitch and a re-stitch after a split apply the same rules.
 */

import type { SessionBar } from "./ticker-history";

/** One entry from Polygon's /vX/reference/tickers/{t}/events. */
export interface TickerEvent {
  readonly type: string;
  readonly date: string;
  readonly ticker_change?: { readonly ticker?: string };
}

export interface Rename {
  readonly oldTicker: string;
  readonly changeDate: string;
}

/** Largest open/close move across the seam a stitch accepts. */
export const SEAM_TOLERANCE = 0.25;

/**
 * The rename INTO `ticker`, if its latest ticker_change event is one. Each
 * event names the symbol in force from its date, so the symbol before the
 * latest change is the one the previous event names.
 */
export function parseRename(ticker: string, events: readonly TickerEvent[]): Rename | null {
  const changes = events
    .filter((e) => e.type === "ticker_change")
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (changes.length < 2) return null;
  const [latest, previous] = changes;
  const oldTicker = previous.ticker_change?.ticker ?? "";
  if (latest.ticker_change?.ticker !== ticker) return null;
  if (!oldTicker || oldTicker === ticker) return null;
  return { oldTicker, changeDate: latest.date };
}

export interface Seam {
  readonly oldLast: string;
  readonly oldClose: number;
  readonly newFirst: string;
  readonly newOpen: number;
}

export type StitchPlan =
  | { readonly ok: true; readonly rows: SessionBar[]; readonly seam: Seam }
  | { readonly ok: false; readonly reason: string };

export function planStitch(input: {
  readonly oldBars: readonly SessionBar[];
  readonly newBars: readonly SessionBar[];
  readonly changeDate: string;
  /** Stored trading sessions, any order. */
  readonly calendar: readonly string[];
  readonly tolerance?: number;
}): StitchPlan {
  const { changeDate } = input;
  const tolerance = input.tolerance ?? SEAM_TOLERANCE;
  const tracked = new Set(input.calendar);
  const sessions = [...tracked].sort();

  const rows = input.oldBars
    .filter((b) => b.session < changeDate && tracked.has(b.session))
    .slice()
    .sort((a, b) => (a.session < b.session ? -1 : 1));
  // Only the new symbol's own bars count: before the change, a reused symbol
  // may carry another company's history.
  const after = input.newBars
    .filter((b) => b.session >= changeDate)
    .slice()
    .sort((a, b) => (a.session < b.session ? -1 : 1));
  if (rows.length === 0) return { ok: false, reason: "old symbol has no bars before the change" };
  if (after.length === 0) return { ok: false, reason: "new symbol has no bars from the change" };

  const last = rows[rows.length - 1];
  const first = after[0];
  const seam: Seam = {
    oldLast: last.session,
    oldClose: last.c,
    newFirst: first.session,
    newOpen: first.o ?? first.c,
  };

  const i = sessions.indexOf(seam.oldLast);
  if (i < 0 || sessions[i + 1] !== seam.newFirst) {
    return { ok: false, reason: `not adjacent: old ends ${seam.oldLast}, new starts ${seam.newFirst}` };
  }
  const move = Math.abs(seam.newOpen / seam.oldClose - 1);
  if (!Number.isFinite(move) || move > tolerance) {
    return {
      ok: false,
      reason: `seam moves ${(move * 100).toFixed(1)}% (${seam.oldClose} -> ${seam.newOpen})`,
    };
  }
  return { ok: true, rows, seam };
}
