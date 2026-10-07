import { describe, expect, it } from "vitest";
import { TOPUP_BATCH, topUpFundamentals, type TopUpDeps } from "./fundamentals-topup";
import type { Fundamentals } from "./edgar";

const F = { cik: "x" } as unknown as Fundamentals;

/** Fake deps with a clock each fetch advances by `msPerFetch`. */
function fake(opts: { msPerFetch?: number; throwFor?: string[]; noCik?: string[] } = {}) {
  let clock = 0;
  const saved: { ticker: string; facts: Fundamentals | null }[] = [];
  const fetched: string[] = [];
  const deps: TopUpDeps = {
    ciks: async (ts) =>
      new Map(ts.filter((t) => !(opts.noCik ?? []).includes(t)).map((t) => [t, `cik-${t}`])),
    fetch: async (cik) => {
      clock += opts.msPerFetch ?? 0;
      const t = cik.replace("cik-", "");
      fetched.push(t);
      if ((opts.throwFor ?? []).includes(t)) throw new Error("EDGAR 503");
      return F;
    },
    save: async (rows) => {
      saved.push(...rows);
    },
    now: () => clock,
  };
  return { deps, saved, fetched };
}

const tickers = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`);

describe("topUpFundamentals", () => {
  it("fetches and saves everything when the budget allows", async () => {
    const { deps, saved } = fake();
    const r = await topUpFundamentals(tickers(12), 60_000, deps);
    expect(r).toMatchObject({ fetched: 12, failed: [], remaining: 0 });
    expect(saved).toHaveLength(12);
  });

  it("stops starting new batches once the budget is spent", async () => {
    // Each batch of 5 costs 5s; a 7s budget allows the first two batches to start.
    const { deps, saved } = fake({ msPerFetch: 1000 });
    const r = await topUpFundamentals(tickers(20), 7_000, deps);
    expect(r.fetched).toBe(2 * TOPUP_BATCH);
    expect(r.remaining).toBe(20 - 2 * TOPUP_BATCH);
    expect(saved).toHaveLength(2 * TOPUP_BATCH);
  });

  it("does nothing with a zero budget", async () => {
    const { deps, fetched } = fake();
    const r = await topUpFundamentals(tickers(3), 0, deps);
    expect(r).toMatchObject({ fetched: 0, remaining: 3 });
    expect(fetched).toEqual([]);
  });

  it("does not store a failed fetch, and keeps going", async () => {
    const { deps, saved } = fake({ throwFor: ["T1"] });
    const r = await topUpFundamentals(tickers(3), 60_000, deps);
    expect(r.failed).toEqual(["T1"]);
    expect(r.fetched).toBe(2);
    expect(saved.map((s) => s.ticker)).toEqual(["T0", "T2"]);
  });

  it("records a name with no CIK as null facts without calling EDGAR", async () => {
    const { deps, saved, fetched } = fake({ noCik: ["T0"] });
    await topUpFundamentals(["T0"], 60_000, deps);
    expect(fetched).toEqual([]);
    expect(saved).toEqual([{ ticker: "T0", facts: null }]);
  });

  it("handles an empty list", async () => {
    const { deps } = fake();
    expect(await topUpFundamentals([], 60_000, deps)).toMatchObject({
      fetched: 0,
      failed: [],
      remaining: 0,
    });
  });
});
