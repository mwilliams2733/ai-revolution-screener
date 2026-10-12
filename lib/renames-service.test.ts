import { describe, expect, it } from "vitest";
import { restitchAfterRepair, stitch, type StitchDeps } from "./renames-service";
import type { SessionBar } from "./ticker-history";

const bar = (session: string, c: number): SessionBar => ({ session, o: c, c });
const CAL = ["2026-01-29", "2026-01-30", "2026-02-02"];

function deps(newOpen: number) {
  const calls: string[] = [];
  const d: StitchDeps = {
    calendar: CAL,
    bounds: { lo: "2026-01-29", hi: "2026-02-02" },
    fetchBars: async (t) =>
      t === "MPW" ? [bar("2026-01-29", 5), bar("2026-01-30", 5)] : [bar("2026-02-02", newOpen)],
    apply: async (n, o, date, rows) => {
      calls.push(`apply ${n}<-${o} ${date} ${rows.length}`);
    },
    drop: async (n, date, reason) => {
      calls.push(`drop ${n} ${date} ${reason.split(":")[0]}`);
    },
  };
  return { d, calls };
}

const RENAME = { newTicker: "MPT", oldTicker: "MPW", changeDate: "2026-02-02" };

describe("stitch", () => {
  it("applies a stitch whose seam holds", async () => {
    const { d, calls } = deps(5.05);
    const plan = await stitch(RENAME, d, { dropOnFailure: true });
    expect(plan.ok).toBe(true);
    expect(calls).toEqual(["apply MPT<-MPW 2026-02-02 2"]);
  });

  it("drops an existing stitch when a re-stitch finds the seam broken", async () => {
    // e.g. a split restated the new symbol but not the old one.
    const { d, calls } = deps(0.5);
    const plan = await stitch(RENAME, d, { dropOnFailure: true });
    expect(plan.ok).toBe(false);
    expect(calls).toEqual(["drop MPT 2026-02-02 seam moves 90.0% (5 -> 0.5)"]);
  });

  it("writes nothing for a refused first stitch", async () => {
    const { d, calls } = deps(0.5);
    await stitch(RENAME, d, { dropOnFailure: false });
    expect(calls).toEqual([]);
  });

  it("writes nothing in a dry run", async () => {
    const { d, calls } = deps(5.05);
    expect((await stitch(RENAME, d, { dropOnFailure: true, dry: true })).ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("restitchAfterRepair", () => {
  const joined = new Map([
    ["MPT", { ...RENAME, status: "stitched" }],
    ["OLDX", { newTicker: "OLDX", oldTicker: "X", changeDate: "2026-02-02", status: "dropped" }],
  ]);

  it("re-stitches a joined ticker after its repair", async () => {
    const { d, calls } = deps(0.5);
    const plan = await restitchAfterRepair("MPT", joined, async () => d);
    expect(plan?.ok).toBe(false);
    expect(calls[0]).toMatch(/^drop MPT/);
  });

  it("leaves unjoined and already-dropped tickers alone", async () => {
    let asked = 0;
    const get = async () => {
      asked++;
      return deps(5).d;
    };
    expect(await restitchAfterRepair("NVDA", joined, get)).toBeNull();
    expect(await restitchAfterRepair("OLDX", joined, get)).toBeNull();
    expect(asked).toBe(0);
  });
});
