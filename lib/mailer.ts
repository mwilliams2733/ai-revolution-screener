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
  readonly enabled: boolean;
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

  return { user, pass, to, enabled: process.env.ALERTS_ENABLED === "true" };
}

export interface SendResult {
  readonly sent: boolean;
  readonly recipients: number;
  readonly error?: string;
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
    });

    await transport.sendMail({
      from: `AI Revolution Screener <${cfg.user}>`,
      to: cfg.to.join(", "),
      subject,
      text,
      html,
    });

    return { sent: true, recipients: cfg.to.length };
  } catch (e) {
    // The nightly job's real work is storing bars. Losing an email is an
    // annoyance; losing the refresh because an email failed is a data gap.
    return {
      sent: false,
      recipients: cfg.to.length,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
