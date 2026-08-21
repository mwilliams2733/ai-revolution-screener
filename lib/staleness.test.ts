import { describe, expect, it } from "vitest";
import { assessStaleness } from "./staleness";

// Newest first, as tradingCalendar returns it.
const cal = ["2026-08-20", "2026-08-19", "2026-08-18", "2026-08-17", "2026-08-14"];

describe("assessStaleness", () => {
  it("calls the newest stored session current", () => {
    const r = assessStaleness("2026-08-20", cal);
    expect(r.freshness).toBe("current");
    expect(r.sessionsBehind).toBe(0);
  });

  it("flags one session behind without alarm", () => {
    expect(assessStaleness("2026-08-19", cal).freshness).toBe("stale");
  });

  it("escalates when the refresh has clearly stopped", () => {
    const r = assessStaleness("2026-08-17", cal);
    expect(r.freshness).toBe("very-stale");
    expect(r.sessionsBehind).toBe(3);
    expect(r.label).toMatch(/refresh/i);
  });

  /**
   * Measured in sessions, not calendar days. Monday showing Friday's close is
   * current data; a day-count rule would call it three days stale and warn
   * every single weekend, training the user to ignore the warning.
   */
  it("does not cry wolf across a weekend", () => {
    const weekend = ["2026-08-17", "2026-08-14"]; // Mon, then previous Fri
    expect(assessStaleness("2026-08-17", weekend).freshness).toBe("current");
  });

  it("treats an unrecognised session as unvouchable", () => {
    const r = assessStaleness("2019-01-02", cal);
    expect(r.freshness).toBe("very-stale");
    expect(r.sessionsBehind).toBe(Number.POSITIVE_INFINITY);
  });
});
