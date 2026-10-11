import { describe, expect, it } from "vitest";
import { buildMarket, contextFor, replay, signalsFiring, splitFactors, startState } from "./scan";
import { advanceSession } from "./engine";
import type { Bar } from "./types";

/**
 * 40 sessions of a flat stock with constant volume and one 10x volume day at
 * index 30. Constant volume keeps every other rule quiet: vol_z is NaN while
 * the window has no variance, and flat prices give zero momentum and drift.
 */
function flatWithSpike(): Bar[] {
  const out: Bar[] = [];
  const day0 = Date.UTC(2026, 0, 5);
  for (let k = 0; k < 40; k++) {
    const session = new Date(day0 + k * 86400000).toISOString().slice(0, 10);
    const vol = k === 30 ? 10_000_000 : 1_000_000;
    out.push({ session, open: 100, high: 101, low: 99, close: 100, volume: vol });
  }
  return out;
}

const market = () =>
  buildMarket(new Map([["NVDA", flatWithSpike()], ["SPY", flatWithSpike()]]));

describe("scan", () => {
  it("fires vol_spike on the spike day only", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    const fired = days.filter((s) => signalsFiring(m, "NVDA", s).includes("vol_spike"));
    expect(fired).toEqual([days[30]]);
  });

  it("builds a context whose bars are that session's", () => {
    const m = market();
    const s = m.bars.get("NVDA")![12].session;
    const c = contextFor(m, s, new Date());
    expect(c.barOf("NVDA", s)?.session).toBe(s);
    expect(c.barOf("NVDA", "1999-01-01")).toBeUndefined();
  });

  it("catch-up never fills before the run that created the pick", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    // One late run processes the spike day and the next 3 days at once.
    const now = new Date(`${days[34]}T20:00:00Z`);
    let state = startState();
    const opened: string[] = [];
    for (const s of days.slice(30, 34)) {
      const out = advanceSession(state, contextFor(m, s, now));
      opened.push(...out.opened.map((p) => p.entrySession));
      state = out.state;
    }
    expect(opened).toEqual([]);
    expect(state.pending).toHaveLength(2); // NVDA and SPY both spiked
  });

  it("replay fills the spike pick at the next session's open", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    const { outcomes } = replay(m, days.slice(25, 40));
    const entries = outcomes.flatMap((o) => o.opened).filter((p) => p.ticker === "NVDA");
    expect(entries.map((p) => p.entrySession)).toEqual([days[31]]);
  });
});

describe("splitFactors", () => {
  const splits = new Map([
    ["NVDA", [{ ticker: "NVDA", executionDate: "2026-07-08", from: 1, to: 10 }]],
    ["TSLA", [{ ticker: "TSLA", executionDate: "2026-07-04", from: 1, to: 3 }]],
  ]);

  it("prices a split taking effect at this session's open as from/to", () => {
    expect(splitFactors(splits, "2026-07-07", "2026-07-08")).toEqual(new Map([["NVDA", 0.1]]));
  });

  it("catches a split dated on a non-session between two sessions", () => {
    // 07-04 is a holiday: the split first shows in 07-06's bar.
    expect(splitFactors(splits, "2026-07-02", "2026-07-06").get("TSLA")).toBeCloseTo(1 / 3, 12);
  });

  it("applies nothing outside (previous, session]", () => {
    expect(splitFactors(splits, "2026-07-08", "2026-07-09").size).toBe(0);
  });
});
