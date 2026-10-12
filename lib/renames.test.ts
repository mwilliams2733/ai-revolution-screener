import { describe, expect, it } from "vitest";
import { parseRename, planStitch, type TickerEvent } from "./renames";
import type { SessionBar } from "./ticker-history";

const change = (ticker: string, date: string): TickerEvent => ({
  type: "ticker_change",
  date,
  ticker_change: { ticker },
});

describe("parseRename", () => {
  it("reads the latest change into this ticker and the symbol before it", () => {
    const events = [change("MPT", "2026-02-02"), change("MPW", "2005-07-08")];
    expect(parseRename("MPT", events)).toEqual({ oldTicker: "MPW", changeDate: "2026-02-02" });
  });

  it("ignores a ticker with only its listing event", () => {
    expect(parseRename("SKHY", [change("SKHY", "2026-07-13")])).toBeNull();
  });

  it("ignores an event whose previous symbol is blank or the same", () => {
    expect(parseRename("AYA", [change("AYA", "2026-05-04"), change("", "2020-01-01")])).toBeNull();
    expect(parseRename("SUNC", [change("SUNC", "2025-11-06"), change("SUNC", "2024-01-01")])).toBeNull();
  });

  it("ignores a latest change that is into some other symbol", () => {
    expect(parseRename("X", [change("Y", "2026-01-01"), change("X", "2020-01-01")])).toBeNull();
  });
});

const bar = (session: string, c: number, o = c): SessionBar => ({ session, o, h: c, l: c, c, v: 1e6, vw: c });
const CAL = ["2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03"];

describe("planStitch", () => {
  const base = {
    changeDate: "2026-02-02",
    calendar: CAL,
    oldBars: [bar("2026-01-28", 5.1), bar("2026-01-29", 5.0), bar("2026-01-30", 5.02)],
    newBars: [bar("2026-02-02", 5.0, 4.99), bar("2026-02-03", 5.2)],
  };

  it("writes the old symbol's bars before the change date", () => {
    const plan = planStitch(base);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rows.map((r) => r.session)).toEqual(["2026-01-28", "2026-01-29", "2026-01-30"]);
    expect(plan.seam).toEqual({ oldLast: "2026-01-30", oldClose: 5.02, newFirst: "2026-02-02", newOpen: 4.99 });
  });

  it("never writes an old-symbol bar on or after the change date", () => {
    // The old symbol trading on the change date must not leak into the stitch.
    const plan = planStitch({ ...base, oldBars: [...base.oldBars, bar("2026-02-02", 9)] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rows.some((r) => r.session >= "2026-02-02")).toBe(false);
    expect(plan.seam.oldLast).toBe("2026-01-30");
  });

  it("drops old bars on sessions the store does not track", () => {
    const plan = planStitch({ ...base, oldBars: [bar("2026-01-25", 5), ...base.oldBars] });
    expect(plan.ok && plan.rows.length).toBe(3);
  });

  it("refuses a seam with a trading session missing between the two symbols", () => {
    const plan = planStitch({ ...base, oldBars: base.oldBars.slice(0, 2) });
    expect(plan).toMatchObject({ ok: false });
    expect(!plan.ok && plan.reason).toMatch(/not adjacent/);
  });

  it("refuses a price jump of more than 25% at the seam", () => {
    const plan = planStitch({ ...base, newBars: [bar("2026-02-02", 7, 6.5)] });
    expect(!plan.ok && plan.reason).toMatch(/seam/);
  });

  it("accepts a jump just inside 25%", () => {
    expect(planStitch({ ...base, newBars: [bar("2026-02-02", 6.2, 6.2)] }).ok).toBe(true);
  });

  it("refuses when either side has no bars", () => {
    expect(planStitch({ ...base, oldBars: [] }).ok).toBe(false);
    expect(planStitch({ ...base, newBars: [] }).ok).toBe(false);
  });

  it("measures the seam from the new symbol's first bar on or after the change", () => {
    // A reused symbol can carry another company's bars before the change.
    const plan = planStitch({ ...base, newBars: [bar("2026-01-29", 50), ...base.newBars] });
    expect(plan.ok && plan.seam.newFirst).toBe("2026-02-02");
  });
});
