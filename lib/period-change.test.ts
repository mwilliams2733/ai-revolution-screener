import { describe, expect, it } from "vitest";
import { MONTH_SESSIONS, WEEK_SESSIONS, periodChanges } from "./period-change";

/** Closes oldest first, so the last element is the current session. */
const ramp = (n: number, start = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => start + i * step);

describe("periodChanges", () => {
  it("measures the day against the PREVIOUS close, not the open", () => {
    // 100 -> 110 is +10% on the day regardless of where it opened.
    const c = periodChanges([100, 110], 105);
    expect(c.day).toBeCloseTo(10, 6);
  });

  it("measures intraday separately, close against open", () => {
    const c = periodChanges([100, 110], 105);
    // Opened at 105, closed at 110: +4.76% from the open.
    expect(c.intraday).toBeCloseTo(4.7619, 3);
  });

  it("measures the week over five sessions", () => {
    // Six closes: today vs five sessions back.
    const closes = [100, 101, 102, 103, 104, 110];
    expect(periodChanges(closes, null).week).toBeCloseTo(10, 6);
    expect(WEEK_SESSIONS).toBe(5);
  });

  it("measures the month over twenty-one sessions", () => {
    const closes = [...Array(MONTH_SESSIONS).fill(100), 120];
    expect(periodChanges(closes, null).month).toBeCloseTo(20, 6);
    expect(MONTH_SESSIONS).toBe(21);
  });

  // A partial window is not the period it claims to be. Three sessions is not
  // a week, and reporting it as one would understate a move.
  it("returns null rather than a shorter window", () => {
    const c = periodChanges([100, 101, 102], null);
    expect(c.day).not.toBeNull();
    expect(c.week).toBeNull();
    expect(c.month).toBeNull();
  });

  it("returns null for everything on an empty or single-bar series", () => {
    const c = periodChanges([100], null);
    expect(c.day).toBeNull();
    expect(c.week).toBeNull();
    expect(c.month).toBeNull();
    expect(periodChanges([], null).day).toBeNull();
  });

  it("returns null intraday when no open was stored", () => {
    expect(periodChanges([100, 110], null).intraday).toBeNull();
  });

  // Prices are positive by definition; a zero or negative one is bad data, and
  // dividing by it would emit Infinity or a sign-flipped percentage.
  it("refuses to divide by a non-positive price", () => {
    expect(periodChanges([0, 110], null).day).toBeNull();
    expect(periodChanges([100, 110], 0).intraday).toBeNull();
  });

  it("handles a decline as a negative percentage", () => {
    expect(periodChanges([100, 90], null).day).toBeCloseTo(-10, 6);
  });

  it("reads the window from the END of the series, ignoring older history", () => {
    const long = [...ramp(300, 1), 100, 200];
    // Today 200 against yesterday 100 is +100%, whatever came before.
    expect(periodChanges(long, null).day).toBeCloseTo(100, 6);
  });
});
