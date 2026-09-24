import { describe, expect, it } from "vitest";
import { classifySession, sessionsNeedingFetch, sessionsToFetch, settledSessions, settleInstant } from "./session-ledger";

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

describe("settleInstant", () => {
  it("is 22:00 UTC during daylight saving", () => {
    expect(settleInstant("2026-09-22").toISOString()).toBe("2026-09-22T22:00:00.000Z");
  });

  it("is 23:00 UTC in standard time", () => {
    expect(settleInstant("2026-12-01").toISOString()).toBe("2026-12-01T23:00:00.000Z");
  });

  /** DST ended Sunday 2026-11-01; the Monday after is standard time. */
  it("follows the DST switch rather than a fixed offset", () => {
    expect(settleInstant("2026-10-30").toISOString()).toBe("2026-10-30T22:00:00.000Z");
    expect(settleInstant("2026-11-02").toISOString()).toBe("2026-11-02T23:00:00.000Z");
  });
});

describe("settledSessions", () => {
  const cal = ["2026-09-23", "2026-09-22", "2026-09-21"];

  /**
   * The bug this guards. At 15:44 UTC on 2026-09-23 the proxy ticker already
   * had a bar for that day, and the refresh stored a mid-morning snapshot as
   * the session.
   */
  it("drops today while the market is open", () => {
    expect(settledSessions(cal, new Date("2026-09-23T15:44:00Z"))).toEqual(["2026-09-22", "2026-09-21"]);
  });

  it("drops today between the close and the settle time", () => {
    expect(settledSessions(cal, new Date("2026-09-23T21:30:00Z"))).toEqual(["2026-09-22", "2026-09-21"]);
  });

  it("includes today once it has settled", () => {
    expect(settledSessions(cal, new Date("2026-09-23T22:00:00Z"))).toEqual(cal);
  });
});

describe("sessionsNeedingFetch", () => {
  const cal = ["2026-09-22", "2026-09-21", "2026-09-18"];

  it("lists a session that was never fetched", () => {
    const fetched = new Map([
      ["2026-09-21", new Date("2026-09-22T12:00:00Z")],
      ["2026-09-18", new Date("2026-09-19T12:00:00Z")],
    ]);
    expect(sessionsNeedingFetch(cal, fetched)).toEqual(["2026-09-22"]);
  });

  /** The repair: a session stored mid-morning is not done, however present it is. */
  it("lists a session fetched before it settled", () => {
    const fetched = new Map([
      ["2026-09-22", new Date("2026-09-22T15:55:51Z")],
      ["2026-09-21", new Date("2026-09-22T12:00:00Z")],
      ["2026-09-18", new Date("2026-09-18T15:24:19Z")],
    ]);
    expect(sessionsNeedingFetch(cal, fetched)).toEqual(["2026-09-22", "2026-09-18"]);
  });

  it("leaves alone a session fetched after it settled", () => {
    const fetched = new Map(cal.map((d) => [d, new Date(`${d}T23:30:00Z`)] as const));
    expect(sessionsNeedingFetch(cal, fetched)).toEqual([]);
  });
});
