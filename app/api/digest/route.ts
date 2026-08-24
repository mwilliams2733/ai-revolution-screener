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
import { getScreen } from "@/lib/screen-service";
import { previousTiers } from "@/lib/db";
import { diffTiers } from "@/lib/alerts";
import { buildDigest, tierCounts } from "@/lib/digest";
import { readMailConfig, sendMail } from "@/lib/mailer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How many of the strongest names to list. */
const LEADERS = 10;

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

  const screen = await getScreen();

  // Diff against the previous session, exactly as the alert does -- and with
  // the same refusal to compare against a replayed one, because a replay runs
  // without the fundamental gate and the difference would be between rulesets
  // rather than between days.
  const previous = await previousTiers(screen.asOf).catch(() => null);
  const changes = diffTiers(
    previous?.tiers ?? new Map(),
    screen.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, rsPct: r.rsPct, vsMa: r.vsMa })),
  );

  const counts = tierCounts(screen.themed);
  const digest = buildDigest({
    asOf: screen.asOf,
    sessionsBehind: screen.staleness.sessionsBehind,
    stalenessLabel: screen.staleness.label,
    universeSize: screen.universeSize,
    themedCount: screen.themed.length,
    ...counts,
    changes,
    changesComparable: previous?.source === "live",
    stageCapped: screen.stageDemoted,
    gateDemoted: screen.demoted,
    cappedOut: screen.capped,
    healthCapped: screen.healthCapped,
    warnings: screen.meta.warnings,
    leaders: screen.themed
      .slice()
      .sort((a, b) => (b.rsPct ?? -1) - (a.rsPct ?? -1))
      .slice(0, LEADERS)
      .map((r) => ({ ticker: r.ticker, rsPct: r.rsPct, tier: r.tier })),
  });

  const mail = readMailConfig();
  if (!mail) {
    return NextResponse.json({ ok: true, sent: false, reason: "no mail config", subject: digest.subject });
  }
  if (!mail.enabled) {
    // Reported, not silent: a digest that stops arriving because a flag is off
    // is indistinguishable from one that stops because the cron broke.
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "ALERTS_ENABLED is not true",
      subject: digest.subject,
    });
  }

  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  return NextResponse.json({ ok: true, ...result, subject: digest.subject, asOf: screen.asOf });
}

export const GET = handle;
export const POST = handle;
