import { describe, expect, it } from "vitest";
import { digestStatus, refreshStatus, type RefreshFacts } from "./schedule-status";

const complete: RefreshFacts = {
  sessionsNeedingFetch: [],
  splitsPending: 0,
  newestStored: "2026-10-02",
  snapshotted: true,
};

describe("refreshStatus", () => {
  it("is done when every output of the refresh is in place", () => {
    expect(refreshStatus(complete).done).toBe(true);
  });

  /**
   * The case the backup scheduler exists for: the Vercel cron did not run, so
   * Friday's session is missing. Skipping here would leave the screen a day
   * stale with nothing else coming to fix it.
   */
  it("is not done while a session needs fetching", () => {
    expect(refreshStatus({ ...complete, sessionsNeedingFetch: ["2026-10-05"] }).done).toBe(false);
  });

  /**
   * A run that stored the bars and then died building the screen leaves the
   * session ledger complete but no tier snapshot, so tomorrow's diff has no
   * baseline. Presence of bars alone must not count as done.
   */
  it("is not done when the newest session has no tier snapshot", () => {
    expect(refreshStatus({ ...complete, snapshotted: false }).done).toBe(false);
  });

  it("is not done while split repairs are outstanding", () => {
    expect(refreshStatus({ ...complete, splitsPending: 3 }).done).toBe(false);
  });

  it("is not done with nothing stored at all", () => {
    expect(refreshStatus({ ...complete, newestStored: null, snapshotted: false }).done).toBe(false);
  });
});

describe("digestStatus", () => {
  it("is done when this morning's key is in the ledger", () => {
    expect(digestStatus("digest:2026-10-05:2026-10-02", true).done).toBe(true);
  });

  /**
   * After a late refresh lands a new session the key changes, so the corrected
   * digest must still go out even though an earlier one was sent today.
   */
  it("is not done when the key for the current session is unsent", () => {
    expect(digestStatus("digest:2026-10-05:2026-10-05", false).done).toBe(false);
  });

  it("is not done when there is no session to key on", () => {
    expect(digestStatus(null, true).done).toBe(false);
  });
});
