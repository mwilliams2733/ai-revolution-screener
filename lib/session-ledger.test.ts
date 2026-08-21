import { describe, expect, it } from "vitest";
import { classifySession, sessionsToFetch } from "./session-ledger";

describe("classifySession", () => {
  it("stores a session that returned bars", () => {
    expect(classifySession(12_470, true)).toBe("store");
    expect(classifySession(12_470, false)).toBe("store");
  });

  /**
   * The bug this exists to prevent. Before the fix, a date the market had not
   * yet opened on was fetched, came back empty, and was recorded
   * is_trading = false — permanently. missingSessions then skipped it forever,
   * so a real session's 12,500 bars were never stored and nothing reported a
   * problem.
   */
  it("retries, never buries, a known trading day that came back empty", () => {
    expect(classifySession(0, true)).toBe("retry");
  });

  it("records a genuine non-session so it is not retried forever", () => {
    expect(classifySession(0, false)).toBe("non-session");
  });
});

describe("sessionsToFetch", () => {
  const calendar = ["2026-08-20", "2026-08-19", "2026-08-18", "2026-08-17", "2026-08-14"];

  it("takes the work list from real sessions, not from weekdays", () => {
    // 2026-08-21 is a Friday and a trading day, but the market has not opened,
    // so the calendar does not contain it yet. It must not enter the work list.
    expect(sessionsToFetch(calendar, [], 5)).not.toContain("2026-08-21");
  });

  it("skips sessions already stored", () => {
    const out = sessionsToFetch(calendar, ["2026-08-20", "2026-08-19"], 5);
    expect(out).toEqual(["2026-08-18", "2026-08-17", "2026-08-14"]);
  });

  it("honours the target count", () => {
    expect(sessionsToFetch(calendar, [], 2)).toEqual(["2026-08-20", "2026-08-19"]);
  });

  // Gaps are not a contiguous prefix after an interrupted run, so the work list
  // must be a set difference rather than a high-water mark.
  it("fills a hole in the middle rather than resuming from the newest", () => {
    const out = sessionsToFetch(calendar, ["2026-08-20", "2026-08-18", "2026-08-14"], 5);
    expect(out).toEqual(["2026-08-19", "2026-08-17"]);
  });

  it("returns nothing when everything is stored", () => {
    expect(sessionsToFetch(calendar, calendar, 5)).toEqual([]);
  });
});
