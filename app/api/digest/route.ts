/**
 * The morning digest: one email per weekday with the state of the screen.
 *
 * Separate route from /api/refresh on purpose. The refresh WRITES -- it fetches
 * sessions, snapshots tier history, repairs split-stranded bars. This one only
 * READS and mails. Keeping them apart means the 6am email cannot corrupt
 * anything if it fails halfway, and a failed 5am refresh still produces a
 * digest that says the data is stale rather than producing no email at all.
 *
 * That last property is the point. An alert that goes quiet looks exactly like
 * a screener that died three weeks ago; a digest that arrives every morning
 * saying "4 sessions behind" tells you which one you are looking at.
 */

import { NextResponse } from "next/server";
import { claimMailSend, releaseMailSend } from "@/lib/db";
import { composeDigest } from "@/lib/digest-service";
import { readMailConfig, sendMail } from "@/lib/mailer";
import { digestKey } from "@/lib/mail-ledger";
import { phoenixToday } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * Five minutes, not the default 60 seconds.
 *
 * MEASURED: on 2026-08-27 the scheduled run died at ~61s with
 * FUNCTION_INVOCATION_TIMEOUT while a warm manual run the same morning
 * succeeded. The route rebuilds the whole screen before composing the email,
 * and that work does not reliably fit in a minute from cold -- so the digest
 * was not broken so much as racing a deadline it sometimes lost, which is the
 * worst kind of intermittent: green on the days you happen to look.
 *
 * Headroom is close to free here. The route only READS and mails, so a long
 * run costs wall-clock and nothing else, and an email that arrives late is
 * strictly better than one that never arrives.
 *
 * The real fix is not rebuilding the entire screen just to send a summary of
 * it. This buys room until that is worth doing.
 */
export const maxDuration = 300;

/** Constant-time-ish compare, to avoid leaking the secret through timing. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // an unset secret is a locked door, not an open one
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && secretMatches(token, expected);
}

async function handle(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json(
      {
        error: "Not authorised",
        detail: process.env.CRON_SECRET
          ? "Send Authorization: Bearer <CRON_SECRET>."
          : "CRON_SECRET is not set on this deployment.",
      },
      { status: 401 },
    );
  }

  const { digest, screen } = await composeDigest();

  const mail = readMailConfig();
  if (!mail) {
    return NextResponse.json({ ok: true, sent: false, reason: "no mail config", subject: digest.subject });
  }
  if (!mail.digestEnabled) {
    // Reported, not silent: a digest that stops arriving because a flag is off
    // is indistinguishable from one that stops because the cron broke. Note
    // this is DIGEST_ENABLED, not ALERTS_ENABLED -- muting the alerts must not
    // mute the heartbeat.
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "DIGEST_ENABLED is false",
      subject: digest.subject,
    });
  }

  // Both vercel.json and the GitHub workflow call this route on the same
  // schedule, deliberately -- either scheduler alone can silently stop. The
  // routes are idempotent in what they WRITE, but delivery is not, so the
  // second caller must skip rather than send a second identical email.
  const key = digestKey(phoenixToday(), screen.asOf);
  if (!(await claimMailSend("digest", key))) {
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "digest already sent today for this session",
      subject: digest.subject,
    });
  }

  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  // A failed send hands the key back, so the other scheduler can still
  // deliver this morning instead of finding the day already marked done.
  if (!result.sent) await releaseMailSend("digest", key);

  // A failed send is a failed job, not a 200 with a sad field. This route
  // writes nothing, so answering non-2xx costs no data and is the only way the
  // failure reaches Vercel's own cron log -- the GitHub workflow's grep is not
  // running on that path. The workflow fails on a non-200 before it greps, so
  // this upgrades a silent warning into a red run in both schedulers.
  return NextResponse.json(
    { ok: result.sent, ...result, subject: digest.subject, asOf: screen.asOf },
    { status: result.sent ? 200 : 500 },
  );
}

export const GET = handle;
export const POST = handle;
