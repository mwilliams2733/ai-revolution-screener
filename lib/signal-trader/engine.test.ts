import { describe, expect, it } from "vitest";
import { advanceSession, type EngineState, type PendingPick, type SessionContext } from "./engine";
import type { SignalName } from "./config";
import type { Bar } from "./types";

// Sessions in July 2026: market opens 13:30 UTC.
const S = ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13"];
const EARLY = (s: string) => new Date(`${s}T12:45:00Z`); // before that day's open
const LATE = (s: string) => new Date(`${s}T15:00:00Z`); // after it

type BarSpec = Partial<Bar> & { open: number };
function book(spec: Record<string, Record<string, BarSpec>>) {
  return (ticker: string, session: string): Bar | undefined => {
    const b = spec[ticker]?.[session];
    if (!b) return undefined;
    return { session, high: b.open, low: b.open, close: b.open, volume: 1, ...b };
  };
}

const empty: EngineState = { cash: 100000, paused: false, pending: [], open: [] };

function pick(over: Partial<PendingPick> = {}): PendingPick {
  return {
    key: `${S[0]}:NVDA:vol_spike`,
    ticker: "NVDA",
    signal: "vol_spike",
    decidedSession: S[0],
    createdAt: EARLY(S[1]).toISOString(),
    windowDays: 10,
    expectedMove: 0.0234,
    ...over,
  };
}

function ctx(
  session: string,
  now: Date,
  barOf: SessionContext["barOf"],
  fired: Record<string, SignalName[]> = {},
): SessionContext {
  return { session, now, barOf, fired: new Map(Object.entries(fired)) };
}

describe("fills", () => {
  it("fills a pick decided before the open at that open: $1,000 at $100 is 10 shares", () => {
    const out = advanceSession(
      { ...empty, pending: [pick()] },
      ctx(S[1], LATE(S[1]), book({ NVDA: { [S[1]]: { open: 100, low: 99, close: 101 } } })),
    );
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0]).toMatchObject({ qty: 10, entryPrice: 100, entrySession: S[1], stopPrice: 92 });
    expect(out.state.cash).toBe(99000);
    expect(out.fills[0]).toMatchObject({ side: "buy", qty: 10, price: 100 });
  });

  it("a pick created after the next open waits for the following session", () => {
    const late = pick({ createdAt: LATE(S[1]).toISOString() });
    const bars = book({ NVDA: { [S[1]]: { open: 100 }, [S[2]]: { open: 102 } } });
    const day1 = advanceSession({ ...empty, pending: [late] }, ctx(S[1], LATE(S[2]), bars));
    expect(day1.opened).toHaveLength(0);
    expect(day1.state.pending).toHaveLength(1);
    const day2 = advanceSession(day1.state, ctx(S[2], LATE(S[2]), bars));
    expect(day2.opened[0]).toMatchObject({ entryPrice: 102, entrySession: S[2] });
  });

  it("cancels a pick when cash is below the notional", () => {
    const out = advanceSession(
      { ...empty, cash: 500, pending: [pick()] },
      ctx(S[1], LATE(S[1]), book({ NVDA: { [S[1]]: { open: 100 } } })),
    );
    expect(out.cancelled).toHaveLength(1);
    expect(out.state.pending).toHaveLength(0);
    expect(out.state.cash).toBe(500);
  });

  it("a missing bar leaves the pick pending and the position open", () => {
    const held: EngineState = {
      ...empty,
      pending: [pick({ ticker: "AMD", key: "k-amd" })],
      open: [{ key: "k-nvda", ticker: "NVDA", signal: "vol_spike", qty: 10, entryPrice: 100, entrySession: S[0], stopPrice: 92, sessionsHeld: 1, windowDays: 10, expectedMove: 0.0234, closeRequestedAt: null }],
    };
    const out = advanceSession(held, ctx(S[1], LATE(S[1]), book({})));
    expect(out.state.pending).toHaveLength(1);
    expect(out.state.open).toHaveLength(1);
    expect(out.state.open[0].sessionsHeld).toBe(1);
    expect(out.notes.length).toBe(2);
  });
});

describe("exits, priced to the cent", () => {
  const open = (over = {}) => ({
    key: "k", ticker: "NVDA", signal: "vol_spike" as const, qty: 10, entryPrice: 100,
    entrySession: S[1], stopPrice: 92, sessionsHeld: 1, windowDays: 3, expectedMove: 0.0234,
    closeRequestedAt: null, ...over,
  });

  it("held to the window: exits at the close of the window's last session", () => {
    // sessionsHeld 2 after S[2]; S[3] is the 3rd session -> exit at its close 108.
    const out = advanceSession(
      { ...empty, open: [open({ sessionsHeld: 2 })] },
      ctx(S[3], LATE(S[3]), book({ NVDA: { [S[3]]: { open: 105, low: 104, close: 108 } }, SPY: { [S[1]]: { open: 500 }, [S[3]]: { open: 505, close: 505 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "window", price: 108 });
    expect(out.exits[0].pnl).toBeCloseTo(80.0, 10);
    expect(out.grades[0].realizedReturn).toBeCloseTo(0.08, 12);
    expect(out.grades[0].spyReturn).toBeCloseTo(0.01, 12);
    expect(out.grades[0].excessReturn).toBeCloseTo(0.07, 12);
    expect(out.grades[0].hit).toBe(true);
    expect(out.state.cash).toBeCloseTo(100000 + 1080, 10);
  });

  it("stopped intraday: fills at the stop, -$80.00", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 97, low: 91, close: 95 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "stop", price: 92 });
    expect(out.exits[0].pnl).toBeCloseTo(-80.0, 10);
  });

  it("gapped through the stop: fills at the open, -$100.00", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 90, low: 88, close: 93 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "stop_gap", price: 90 });
    expect(out.exits[0].pnl).toBeCloseTo(-100.0, 10);
    expect(out.grades[0].hit).toBe(false);
  });

  it("manual close requested before the open: exits at that open", () => {
    const out = advanceSession(
      { ...empty, open: [open({ closeRequestedAt: EARLY(S[2]).toISOString() })] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 103, low: 101, close: 104 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "manual", price: 103 });
  });

  it("otherwise marks at the close and counts the session", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 101, low: 100, close: 102 } } })),
    );
    expect(out.exits).toHaveLength(0);
    expect(out.marks[0]).toMatchObject({ key: "k", price: 102 });
    expect(out.state.open[0].sessionsHeld).toBe(2);
  });
});

describe("scan", () => {
  const bars = book({ NVDA: { [S[1]]: { open: 100 } } });

  it("creates one long pick per ticker, the first signal in config order", () => {
    const out = advanceSession(empty, ctx(S[1], LATE(S[1]), bars, { NVDA: ["vol_spike", "vol_z"] }));
    expect(out.newPicks).toHaveLength(1);
    expect(out.newPicks[0]).toMatchObject({ ticker: "NVDA", signal: "vol_spike", decidedSession: S[1], windowDays: 10 });
    expect(out.signals.map((s) => [s.signal, s.acted, s.note])).toEqual([
      ["vol_spike", true, "PAPER pick created"],
      ["vol_z", false, "another signal acted for this ticker"],
    ]);
  });

  it("logs but does not pick a ticker that already has an open pick", () => {
    const out = advanceSession({ ...empty, pending: [pick()] }, ctx(S[0], LATE(S[0]), bars, { NVDA: ["mom_20"] }));
    expect(out.newPicks).toHaveLength(0);
    expect(out.signals[0]).toMatchObject({ acted: false, note: "ticker already has an open pick" });
  });

  it("logs but does not pick while paused", () => {
    const out = advanceSession({ ...empty, paused: true }, ctx(S[1], LATE(S[1]), bars, { NVDA: ["vol_spike"] }));
    expect(out.newPicks).toHaveLength(0);
    expect(out.signals[0]).toMatchObject({ acted: false, note: "auto-trade paused" });
  });
});
