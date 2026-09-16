/**
 * Gmail SMTP delivery. Server-only.
 *
 * Uses the app password already in the environment rather than adding another
 * service. Gmail's limits (a few hundred messages a day) are far beyond what a
 * once-nightly alert to three people needs.
 *
 * Deliberately its own module so lib/alerts.ts stays pure and testable without
 * a mail server.
 */

import nodemailer from "nodemailer";

export interface MailConfig {
  readonly user: string;
  readonly pass: string;
  readonly to: readonly string[];
  /** Exception-driven tier-change alerts. Opt-IN: off unless explicitly "true". */
  readonly enabled: boolean;
  /**
   * The unconditional morning digest. Opt-OUT: on unless explicitly "false".
   *
   * The two flags default in opposite directions on purpose. An alert that is
   * off is quiet; a digest that is off is indistinguishable from a pipeline
   * that died, which is the one failure this email exists to make visible. So
   * silencing it has to be a deliberate act, not a side effect of muting alerts.
   */
  readonly digestEnabled: boolean;
}

/**
 * Read mail settings from the environment.
 *
 * ALERT_TO and ALERTS_ENABLED are deliberately screener-specific. EMAIL_TO and
 * EMAIL_ENABLED already exist in the shared secrets for a DIFFERENT project,
 * and inheriting another app's on/off switch would make this one mysteriously
 * silent. Returns null when it cannot send, so callers skip rather than throw.
 */
export function readMailConfig(): MailConfig | null {
  if (typeof window !== "undefined") throw new Error("lib/mailer.ts is server-only.");

  const user = process.env.GMAIL_USER?.trim();
  // Two spellings exist in the shared secrets; accept either.
  const pass = (process.env.GMAIL_APP_PW ?? process.env.GMAIL_APP_PASSWORD)?.trim();
  if (!user || !pass) return null;

  const to = (process.env.ALERT_TO ?? user)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (to.length === 0) return null;

  return {
    user,
    pass,
    to,
    enabled: process.env.ALERTS_ENABLED === "true",
    digestEnabled: process.env.DIGEST_ENABLED !== "false",
  };
}

/** The reason string a genuine delivery failure reports. */
export const SEND_FAILED = "smtp send failed";

export interface SendResult {
  readonly sent: boolean;
  readonly recipients: number;
  /**
   * Machine-readable cause, present on every non-send.
   *
   * The GitHub workflow greps for this field; without it a real SMTP rejection
   * degraded to `"reason":"unstated"` while every DELIBERATE suppression
   * reported itself properly. The failure path must be at least as informative
   * as the success-but-skipped path.
   */
  readonly reason?: string;
  readonly error?: string;
}

/** Shape a thrown send into a reportable result. Pure, so it can be tested. */
export function sendFailure(e: unknown, recipients: number): SendResult {
  return {
    sent: false,
    recipients,
    reason: SEND_FAILED,
    error: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Address the envelope so recipients cannot see each other.
 *
 * Everyone except the sender goes in Bcc and the To line carries only the
 * sender's own address. These emails name positions and tier moves; who else
 * reads them is nobody's business but the sender's, and a plain To line leaks
 * the whole distribution list to every reader forever.
 *
 * The sender is filtered out of Bcc rather than trusted to be absent, so an
 * ALERT_TO that lists the sender does not deliver twice.
 *
 * Pure, so the addressing can be tested without a mail server.
 */
export function envelope(cfg: MailConfig): {
  to: string;
  bcc: readonly string[];
  recipients: number;
} {
  const self = cfg.user.trim().toLowerCase();
  const bcc = cfg.to.filter((a) => a.trim().toLowerCase() !== self);
  // The To line is always exactly one address, so deliveries are bcc + 1.
  return { to: cfg.user, bcc, recipients: bcc.length + 1 };
}

/** Send one message. Never throws: a failed alert must not fail the refresh. */
export async function sendMail(
  cfg: MailConfig,
  subject: string,
  text: string,
  html: string,
): Promise<SendResult> {
  try {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
      // Nodemailer defaults to a 10-minute socket timeout, which outlives this
      // route's maxDuration of 300s. A hung socket would therefore kill the
      // function before the catch above could return anything at all -- no
      // JSON, no reason, nothing for the workflow to read. Fail in seconds so
      // the failure is reportable.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });

    const { to, bcc, recipients } = envelope(cfg);

    await transport.sendMail({
      from: `AI Revolution Screener <${cfg.user}>`,
      to,
      bcc: bcc.join(", "),
      subject,
      text,
      html,
    });

    return { sent: true, recipients };
  } catch (e) {
    // The nightly job's real work is storing bars. Losing an email is an
    // annoyance; losing the refresh because an email failed is a data gap.
    return sendFailure(e, envelope(cfg).recipients);
  }
}
