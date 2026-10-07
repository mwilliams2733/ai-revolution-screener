import { describe, expect, it } from "vitest";
import { bookFetchList, usableFundamentals, wantedFundamentals, type StoredFundamentals } from "./fundamentals-store";
import type { Fundamentals } from "./edgar";

const NOW = new Date("2026-10-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("wantedFundamentals", () => {
  it("wants missing names, in candidate order, before stale ones", () => {
    const stored = new Map([["OLD", daysAgo(30)]]);
    expect(wantedFundamentals(["OLD", "B", "A"], stored, NOW)).toEqual(["B", "A", "OLD"]);
  });

  it("skips names fetched within the window", () => {
    const stored = new Map([["FRESH", daysAgo(2)]]);
    expect(wantedFundamentals(["FRESH"], stored, NOW)).toEqual([]);
  });

  it("orders stale names oldest first", () => {
    const stored = new Map([
      ["X", daysAgo(8)],
      ["Y", daysAgo(40)],
    ]);
    expect(wantedFundamentals(["X", "Y"], stored, NOW)).toEqual(["Y", "X"]);
  });

  it("finds a gap in the middle, not just the tail", () => {
    // Resume by set difference: an interrupted backfill must not be read as
    // "done up to C".
    const stored = new Map([
      ["A", daysAgo(1)],
      ["C", daysAgo(1)],
    ]);
    expect(wantedFundamentals(["A", "B", "C"], stored, NOW)).toEqual(["B"]);
  });

  it("treats an unparseable timestamp as stale and ignores duplicate candidates", () => {
    const stored = new Map([["BAD", "not a date"]]);
    expect(wantedFundamentals(["BAD", "BAD"], stored, NOW)).toEqual(["BAD"]);
  });
});

describe("usableFundamentals", () => {
  it("drops rows stored as 'no SEC filings', so the gate reads them as unverified", () => {
    const f = { cik: "1", revAccel: 1, opMarginDelta: 1 } as unknown as Fundamentals;
    const stored = new Map<string, StoredFundamentals>([
      ["HAS", { facts: f, fetchedAt: daysAgo(1) }],
      ["NONE", { facts: null, fetchedAt: daysAgo(1) }],
    ]);
    const out = usableFundamentals(stored, ["HAS", "NONE"]);
    expect([...out.keys()]).toEqual(["HAS"]);
  });
});

describe("usableFundamentals, scoped to candidates", () => {
  it("passes the gate facts for the Strong Buy candidates only", () => {
    // A stored name that has slipped below Strong Buy must read unverified,
    // exactly as it did when only candidates were fetched. Handing the gate its
    // facts marks it "demote", and the book then claims it was held at Buy.
    const f = { cik: "1", revAccel: -5, opMarginDelta: -1 } as unknown as Fundamentals;
    const stored = new Map<string, StoredFundamentals>([
      ["CAND", { facts: f, fetchedAt: daysAgo(1) }],
      ["SLIPPED", { facts: f, fetchedAt: daysAgo(1) }],
    ]);
    expect([...usableFundamentals(stored, ["CAND"]).keys()]).toEqual(["CAND"]);
  });
});

describe("bookFetchList", () => {
  it("lists the book's candidates that are missing or stale, and nothing else", () => {
    const book = new Set(["MISSING", "STALE", "FRESH"]);
    const stored = new Map([
      ["STALE", daysAgo(30)],
      ["FRESH", daysAgo(1)],
      ["MARKET", daysAgo(30)],
    ]);
    expect(bookFetchList(["MISSING", "STALE", "FRESH", "MARKET", "NEWMKT"], book, stored, NOW)).toEqual([
      "MISSING",
      "STALE",
    ]);
  });
});
