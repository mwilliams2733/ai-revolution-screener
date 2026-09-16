import { afterEach, describe, expect, it, vi } from "vitest";
import { readMailConfig, SEND_FAILED, sendFailure } from "./mailer";

/**
 * Credentials here are obvious fakes and exist only to get past the
 * null-guard. Never put a real value in a test file.
 */
function withCreds() {
  vi.stubEnv("GMAIL_USER", "screener@example.com");
  vi.stubEnv("GMAIL_APP_PW", "not-a-real-password");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readMailConfig", () => {
  it("returns null without credentials", () => {
    vi.stubEnv("GMAIL_USER", "");
    vi.stubEnv("GMAIL_APP_PW", "");
    expect(readMailConfig()).toBeNull();
  });

  it("falls back to the sender when ALERT_TO is unset", () => {
    withCreds();
    vi.stubEnv("ALERT_TO", undefined);
    expect(readMailConfig()?.to).toEqual(["screener@example.com"]);
  });

  it("splits a comma-separated ALERT_TO", () => {
    withCreds();
    vi.stubEnv("ALERT_TO", "a@example.com, b@example.com");
    expect(readMailConfig()?.to).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("the two send flags default in opposite directions", () => {
  /**
   * The bug this guards: one flag gated both emails, so muting the alerts
   * also removed the digest -- the only message that proves the pipeline is
   * alive. These two cases must never collapse back into one.
   */
  it("alerts are off unless ALERTS_ENABLED is exactly true", () => {
    withCreds();
    vi.stubEnv("ALERTS_ENABLED", undefined);
    expect(readMailConfig()?.enabled).toBe(false);
    vi.stubEnv("ALERTS_ENABLED", "TRUE");
    expect(readMailConfig()?.enabled).toBe(false);
    vi.stubEnv("ALERTS_ENABLED", "true");
    expect(readMailConfig()?.enabled).toBe(true);
  });

  it("the digest is on unless DIGEST_ENABLED is exactly false", () => {
    withCreds();
    vi.stubEnv("DIGEST_ENABLED", undefined);
    expect(readMailConfig()?.digestEnabled).toBe(true);
    vi.stubEnv("DIGEST_ENABLED", "false");
    expect(readMailConfig()?.digestEnabled).toBe(false);
  });

  it("muting alerts leaves the digest sending", () => {
    withCreds();
    vi.stubEnv("ALERTS_ENABLED", "false");
    vi.stubEnv("DIGEST_ENABLED", undefined);
    const cfg = readMailConfig();
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.digestEnabled).toBe(true);
  });
});

describe("sendFailure", () => {
  /**
   * The bug this guards: a genuine SMTP rejection returned {sent,recipients,
   * error} with NO reason, while every deliberate suppression reported one. The
   * workflow greps for "reason", so the real failure was the only one that
   * degraded to "unstated".
   */
  it("always carries a machine-readable reason", () => {
    const r = sendFailure(new Error("535 auth failed"), 3);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(SEND_FAILED);
    expect(typeof r.reason).toBe("string");
  });

  it("preserves the underlying error text alongside the reason", () => {
    const r = sendFailure(new Error("535 auth failed"), 3);
    expect(r.error).toContain("535");
    expect(r.recipients).toBe(3);
  });

  it("handles a non-Error throw without losing the reason", () => {
    const r = sendFailure("socket hang up", 1);
    expect(r.reason).toBe(SEND_FAILED);
    expect(r.error).toBe("socket hang up");
  });
});
