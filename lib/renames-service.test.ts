import { describe, expect, it } from "vitest";
import { nightlyStitch, restitchAfterRepair, stitch, type NightlyDeps, type StitchDeps } from "./renames-service";
import type { TickerEvent } from "./renames";
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

describe("nightlyStitch", () => {
  function nightly(events: Record<string, TickerEvent[] | Error>, newOpen = 5.05, clockStep = 0) {
    const recorded: string[] = [];
    const { d, calls } = deps(newOpen);
    let clock = 0;
    const n: NightlyDeps = {
      candidates: async () => Object.keys(events),
      events: async (t) => {
        const e = events[t];
        if (e instanceof Error) throw e;
        return e;
      },
      stitchDeps: async () => d,
      record: async (t, outcome, note) => {
        recorded.push(`${t} ${outcome}${note ? ` ${note.split(" ")[0]}` : ""}`);
      },
      now: () => (clock += clockStep),
    };
    return { n, recorded, calls };
  }
  const ev = (t: string, date: string): TickerEvent => ({ type: "ticker_change", date, ticker_change: { ticker: t } });
  const renamed = [ev("MPT", "2026-02-02"), ev("MPW", "2005-07-08")];

  it("stitches a confirmed rename and records every outcome", async () => {
    const { n, recorded, calls } = nightly({ MPT: renamed, NEWCO: [ev("NEWCO", "2026-10-01")] });
    const r = await nightlyStitch(n, { budgetMs: 30_000, max: 10 });
    expect(r).toMatchObject({ checked: 2, stitched: ["MPT"], refused: [], errors: 0 });
    expect(calls).toEqual(["apply MPT<-MPW 2026-02-02 2"]);
    expect(recorded).toEqual(["MPT stitched from", "NEWCO none"]);
  });

  it("records a refusal, and writes no bars for it", async () => {
    const { n, recorded, calls } = nightly({ MPT: renamed }, 0.5);
    const r = await nightlyStitch(n, { budgetMs: 30_000, max: 10 });
    expect(r.refused).toEqual(["MPT"]);
    expect(calls).toEqual([]);
    expect(recorded).toEqual(["MPT refused seam"]);
  });

  it("leaves an errored check unrecorded so it is retried", async () => {
    const { n, recorded } = nightly({ BAD: new Error("HTTP 500"), NEWCO: [] });
    const r = await nightlyStitch(n, { budgetMs: 30_000, max: 10 });
    expect(r.errors).toBe(1);
    expect(recorded).toEqual(["NEWCO none"]);
  });

  it("treats a 404 from the events endpoint as no rename", async () => {
    const { n, recorded } = nightly({ X: new Error("HTTP 404 from /vX/reference/tickers/X/events") });
    expect((await nightlyStitch(n, { budgetMs: 30_000, max: 10 })).errors).toBe(0);
    expect(recorded).toEqual(["X none"]);
  });

  it("stops at the time budget and the per-run cap", async () => {
    const many = Object.fromEntries(["A", "B", "C", "D"].map((t) => [t, [] as TickerEvent[]]));
    expect((await nightlyStitch(nightly(many, 5.05, 10_000).n, { budgetMs: 25_000, max: 10 })).checked).toBe(2);
    expect((await nightlyStitch(nightly(many).n, { budgetMs: 30_000, max: 3 })).checked).toBe(3);
  });
});
