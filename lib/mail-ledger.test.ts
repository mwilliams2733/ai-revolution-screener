import { describe, expect, it } from "vitest";
import { alertKey, digestKey } from "./mail-ledger";

describe("digestKey", () => {
  /**
   * The bug this guards: keying the digest on the SESSION alone would mean a
   * stalled pipeline sends one email and then goes silent -- the exact
   * failure the digest exists to make visible. The day must be in the key.
   */
  it("changes every day even when the session does not", () => {
    expect(digestKey("2026-09-14", "2026-09-11")).not.toBe(digestKey("2026-09-15", "2026-09-11"));
  });

  it("is stable within a day for the same session, so a second caller is suppressed", () => {
    expect(digestKey("2026-09-15", "2026-09-14")).toBe(digestKey("2026-09-15", "2026-09-14"));
  });

  /**
   * The other bug: the digest fired before the refresh landed, reported one
   * session behind, and the corrected data never got an email that day.
   */
  it("changes within a day when the session advances", () => {
    expect(digestKey("2026-09-15", "2026-09-12")).not.toBe(digestKey("2026-09-15", "2026-09-14"));
  });

  it("is namespaced so it cannot collide with an alert key", () => {
    expect(digestKey("2026-09-15", "2026-09-15")).not.toBe(alertKey("2026-09-15"));
  });
});

describe("alertKey", () => {
  /**
   * The opposite rule. previousTiers selects `session < asOf`, so a second
   * refresh on the same asOf recomputes an IDENTICAL diff. Re-sending would
   * report the morning's moves again in the afternoon.
   */
  it("is stable for one session, so a repeat refresh is suppressed", () => {
    expect(alertKey("2026-09-15")).toBe(alertKey("2026-09-15"));
  });

  it("changes when a genuinely new session arrives", () => {
    expect(alertKey("2026-09-15")).not.toBe(alertKey("2026-09-16"));
  });
});
