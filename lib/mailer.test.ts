import { afterEach, describe, expect, it, vi } from "vitest";
import { readMailConfig } from "./mailer";

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
