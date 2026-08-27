import { describe, expect, it } from "vitest";
import {
  absoluteLabel,
  buildRefreshStamp,
  relativeTime,
  runState,
  dayLabel,
  type RefreshRun,
} from "./refresh-stamp";

const NOW = new Date("2026-08-27T12:00:00Z");

const run = (over: Partial<RefreshRun> = {}): RefreshRun => ({
  startedAt: "2026-08-26T22:16:43Z",
  finishedAt: "2026-08-26T22:17:38Z",
  ok: true,
  sessionsAdded: 1,
  barsAdded: 12463,
  ...over,
});

describe("runState", () => {
  it("is ok for a finished successful run", () => {
    expect(runState(run())).toBe("ok");
  });

  it("is failed when the run reported failure", () => {
    expect(runState(run({ ok: false }))).toBe("failed");
  });

  /**
   * finishRun() is the only writer of finished_at, so a null means the process
   * died mid-run. Reporting that as a clean check is the exact failure this
   * widget exists to prevent.
   */
  it("does not report a run that never finished as a success", () => {
    expect(runState(run({ finishedAt: null, ok: null }))).toBe("running");
    expect(runState(run({ finishedAt: null, ok: true }))).toBe("running");
  });
});

describe("relativeTime", () => {
  it("collapses the last couple of minutes to 'just now'", () => {
    expect(relativeTime("2026-08-27T11:59:00Z", NOW)).toBe("just now");
  });

  it("counts minutes below an hour", () => {
    expect(relativeTime("2026-08-27T11:30:00Z", NOW)).toBe("30 minutes ago");
    expect(relativeTime("2026-08-27T11:57:00Z", NOW)).toBe("3 minutes ago");
  });

  it("counts hours below a day", () => {
    expect(relativeTime("2026-08-27T06:00:00Z", NOW)).toBe("6 hours ago");
  });

  it("singularises one", () => {
    expect(relativeTime("2026-08-27T11:00:00Z", NOW)).toBe("1 hour ago");
    expect(relativeTime("2026-08-26T12:00:00Z", NOW)).toBe("1 day ago");
  });

  it("counts days beyond that", () => {
    expect(relativeTime("2026-08-24T12:00:00Z", NOW)).toBe("3 days ago");
  });

  /**
   * Database and browser clocks drift. "in 3 hours" is never information the
   * reader wants, and a negative duration formatted naively reads as a bug.
   */
  it("does not render a future timestamp as negative", () => {
    const s = relativeTime("2026-08-27T15:00:00Z", NOW);
    expect(s).toBe("just now");
    expect(s).not.toMatch(/-|in /);
  });

  it("says unknown rather than NaN for an unparseable date", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("unknown");
  });
});

describe("absoluteLabel", () => {
  /**
   * Phoenix is UTC-7 year round. 22:16 UTC is the same evening, 3:16 PM local
   * -- if this ever renders as 10:16 PM the timezone has been dropped.
   */
  it("renders in Phoenix time, not UTC", () => {
    const s = absoluteLabel("2026-08-26T22:16:43Z");
    expect(s).toMatch(/Aug 26/);
    expect(s).toMatch(/3:16/);
    expect(s).toMatch(/MST/);
  });

  it("does not drift with DST, because Phoenix has none", () => {
    const winter = absoluteLabel("2026-01-15T22:16:00Z");
    const summer = absoluteLabel("2026-07-15T22:16:00Z");
    expect(winter).toMatch(/3:16/);
    expect(summer).toMatch(/3:16/);
  });

  it("says unknown rather than 'Invalid Date'", () => {
    expect(absoluteLabel("not-a-date")).toBe("unknown");
  });
});

describe("buildRefreshStamp", () => {
  it("reports a successful run with what it did", () => {
    const s = buildRefreshStamp(run(), NOW);
    expect(s.state).toBe("ok");
    expect(s.relative).toBe("13 hours ago");
    expect(s.detail).toMatch(/added 1 session and 12,463 bars/);
  });

  /**
   * Most runs add nothing -- the evening run does the work and the morning one
   * finds it already done. That must read as normal, not as a problem.
   */
  it("describes an empty run as normal rather than as a failure", () => {
    const s = buildRefreshStamp(run({ sessionsAdded: 0, barsAdded: 0 }), NOW);
    expect(s.state).toBe("ok");
    expect(s.detail).toMatch(/no new sessions/i);
    expect(s.detail).not.toMatch(/fail/i);
  });

  it("says a failed check failed", () => {
    const s = buildRefreshStamp(run({ ok: false }), NOW);
    expect(s.state).toBe("failed");
    expect(s.detail).toMatch(/failed/i);
  });

  /** An unfinished run is timed from its START; it has no end yet to time from. */
  it("times an in-flight run from when it started", () => {
    const s = buildRefreshStamp(
      run({ startedAt: "2026-08-27T11:00:00Z", finishedAt: null, ok: null }),
      NOW,
    );
    expect(s.state).toBe("running");
    expect(s.relative).toBe("1 hour ago");
    expect(s.detail).toMatch(/has not finished/i);
  });

  /**
   * A completed run is timed from when it FINISHED. Timing from the start
   * would overstate the age of every long backfill.
   */
  it("times a completed run from when it finished", () => {
    const s = buildRefreshStamp(
      run({ startedAt: "2026-08-27T06:00:00Z", finishedAt: "2026-08-27T11:00:00Z" }),
      NOW,
    );
    expect(s.relative).toBe("1 hour ago");
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-08-27T15:00:00Z"); // 8am Phoenix, Aug 27

  it("says Today for a run earlier the same Phoenix day", () => {
    expect(dayLabel("2026-08-27T13:00:00Z", now)).toBe("Today");
  });

  it("says Yesterday for the previous Phoenix day", () => {
    expect(dayLabel("2026-08-26T22:17:38Z", now)).toBe("Yesterday");
  });

  it("counts days beyond that", () => {
    expect(dayLabel("2026-08-24T22:17:38Z", now)).toBe("3 days ago");
  });

  /**
   * The whole point of day granularity: page.tsx caches for an hour, so the
   * rendered string must not change when it is read an hour late.
   */
  it("is unchanged by an hour of cache staleness", () => {
    const then = "2026-08-26T22:17:38Z";
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    expect(dayLabel(then, later)).toBe(dayLabel(then, now));
  });

  /**
   * A run at 11pm Phoenix and a read at 1am are two hours apart but belong to
   * different calendar days. Elapsed-hours arithmetic would call that "Today".
   */
  it("compares calendar days, not elapsed hours", () => {
    // 2026-08-26 23:30 Phoenix == 2026-08-27T06:30Z
    // 2026-08-27 01:00 Phoenix == 2026-08-27T08:00Z
    expect(dayLabel("2026-08-27T06:30:00Z", new Date("2026-08-27T08:00:00Z"))).toBe("Yesterday");
  });

  it("never renders a future day", () => {
    expect(dayLabel("2026-08-29T15:00:00Z", now)).toBe("Today");
  });

  it("says unknown for an unparseable date", () => {
    expect(dayLabel("nope", now)).toBe("unknown");
  });
});

describe("the masthead label", () => {
  it("pairs the day word with the clock time", () => {
    const s = buildRefreshStamp(run(), new Date("2026-08-27T15:00:00Z"));
    expect(s.label).toBe("Yesterday 3:17 PM MST");
  });
});
