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

describe("assessStaleness wiring contract", () => {
  /**
   * The bug this guards: production passed the STORED calendar, whose head is
   * the as-of date itself, so indexOf was always 0. Any calendar that starts
   * with asOf reports current by construction -- which is why the reference
   * calendar must come from a source independent of what we stored.
   */
  it("is vacuously current whenever asOf heads the calendar", () => {
    const anyCal = ["2026-08-20", "2026-08-19", "2026-08-18"];
    expect(assessStaleness(anyCal[0], anyCal).freshness).toBe("current");
  });

  it("reports the gap when the stored head trails the real calendar", () => {
    // Refresh stalled after 2026-08-17; the market kept trading.
    const reference = ["2026-08-20", "2026-08-19", "2026-08-18", "2026-08-17"];
    const r = assessStaleness("2026-08-17", reference);
    expect(r.freshness).toBe("very-stale");
    expect(r.sessionsBehind).toBe(3);
  });

  it("calls a weekend one session behind, not stale-alarming", () => {
    // Saturday: newest completed session is Friday, we hold Thursday's close.
    const reference = ["2026-08-21", "2026-08-20", "2026-08-19"];
    const r = assessStaleness("2026-08-20", reference);
    expect(r.sessionsBehind).toBe(1);
    expect(r.freshness).toBe("stale");
  });
});
