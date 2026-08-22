/**
 * POST|GET /api/refresh -> nightly cron target.
 *
 * Pulls any trading sessions that are missing, stores their bars, then runs the
 * screen once and snapshots the result into tier_history so tier changes can be
 * diffed for alerts.
 *
 * This path is exempt from Cloudflare Access in proxy.ts because Vercel Cron
 * calls the deployment directly and carries no browser identity. It
 * authenticates with CRON_SECRET instead. Vercel sends that automatically as
 * `Authorization: Bearer $CRON_SECRET` when the variable is set on the project.
 */

import { NextResponse } from "next/server";
import { groupedDaily, tradingCalendar } from "@/lib/polygon";
import {
  finishRun,
  insertBars,
  missingSessions,
  previousTiers,
  recordSession,
  startRun,
  upsertTierHistory,
} from "@/lib/db";
import { getScreen } from "@/lib/screen-service";
import { diffTiers, formatAlert, shouldSend } from "@/lib/alerts";
import { readMailConfig, sendMail } from "@/lib/mailer";
import { classifySession } from "@/lib/session-ledger";
import { isoDaysAgo } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Sessions to catch up per invocation.
 *
 * A nightly run normally has exactly one to do. The cap exists so a run after a
 * long outage does its share and exits cleanly rather than hitting the function
 * timeout mid-write; the next run picks up whatever is still missing, because
 * the work list is computed from the ledger, not from a cursor.
 */
const MAX_SESSIONS_PER_RUN = 3;

/**
 * How far back to look for gaps. (Finding M4)
 *
 * Must be comfortably wider than MAX_SESSIONS_PER_RUN or a backlog can never
 * drain: with a 10-session window and 3 fetched per night, an outage longer
 * than about two weeks left the oldest gaps permanently outside the window,
 * and `remaining` reported a number that never fell.
 */
const CATCHUP_WINDOW = 60;


/** Constant-time-ish compare, to avoid leaking the secret through timing. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // unset secret is a locked door, not an open one
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

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "No database", detail: "DATABASE_URL is not set, so there is nothing to refresh." },
      { status: 503 },
    );
  }

  const runId = await startRun("nightly");
  let sessionsAdded = 0;
  let barsAdded = 0;
  const stored: string[] = [];
  const retried: string[] = [];

  try {
    // Real session dates, newest first, over a window wide enough that a
    // backlog drains instead of falling off the end.
    const calendar = await tradingCalendar(isoDaysAgo(CATCHUP_WINDOW * 2), isoDaysAgo(0));
    const recent = calendar.slice(0, CATCHUP_WINDOW);
    const todo = (await missingSessions(recent)).slice(0, MAX_SESSIONS_PER_RUN);

    for (const date of todo) {
      const bars = await groupedDaily(date);

      // `todo` is derived from tradingCalendar, so every date here is a REAL
      // session. An empty response is therefore an upstream hiccup, not a
      // holiday, and must not be written to the ledger as one — doing so would
      // bury the session permanently. See H1 in lib/session-ledger.ts.
      if (classifySession(bars.length, true) === "retry") {
        retried.push(date);
        continue;
      }
      const n = await insertBars(date, bars);
      await recordSession(date, n, true);
      stored.push(date);
      sessionsAdded += 1;
      barsAdded += n;
    }

    // Snapshot the screen so tier changes are diffable tomorrow.
    const screen = await getScreen();
    const tierRows = screen.themed.map((r) => ({
      ticker: r.ticker,
      rsPct: r.rsPct,
      vsMa: r.vsMa,
      tier: r.tier,
      // The pre-overlay tier, so tomorrow's hysteresis compares like with like.
      momentumTier: r.momentumTier,
      weight: r.weight,
    }));
    // Read the previous session's tiers BEFORE writing today's, or the diff
    // would compare today against itself.
    const previous = await previousTiers(screen.asOf);
    const snapshotted = await upsertTierHistory(screen.asOf, tierRows);

    const changes = diffTiers(
      previous,
      screen.themed.map((r) => ({
        ticker: r.ticker,
        tier: r.tier,
        rsPct: r.rsPct,
        vsMa: r.vsMa,
      })),
    );

    const mail = readMailConfig();
    let alert: Record<string, unknown> = { sent: false, reason: "no mail config" };
    if (mail) {
      const send = shouldSend(changes, {
        hasBaseline: previous.size > 0,
        enabled: mail.enabled,
      });
      if (!send) {
        alert = {
          sent: false,
          reason: !mail.enabled
            ? "ALERTS_ENABLED is not true"
            : previous.size === 0
              ? "no baseline yet - first run records it silently"
              : "no tier changes",
          changes: changes.length,
        };
      } else {
        const { subject, text, html } = formatAlert(changes, screen.asOf);
        const result = await sendMail(mail, subject, text, html);
        alert = { ...result, changes: changes.length, subject };
      }
    }

    await finishRun(runId, sessionsAdded, barsAdded, true);

    return NextResponse.json({
      ok: true,
      asOf: screen.asOf,
      sessionsStored: stored,
      emptyRetried: retried,
      barsAdded,
      tiersSnapshotted: snapshotted,
      tierChanges: changes.length,
      alert,
      remaining: Math.max(0, (await missingSessions(recent)).length),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "refresh failed";
    await finishRun(runId, sessionsAdded, barsAdded, false, message);
    return NextResponse.json(
      { ok: false, error: message.replace(/apiKey=[^&\s]+/g, "apiKey=***"), sessionsStored: stored },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
