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
  recordSession,
  startRun,
  upsertTierHistory,
} from "@/lib/db";
import { getScreen } from "@/lib/screen-service";
import { classifySession } from "@/lib/session-ledger";

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

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

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
    // Real session dates, newest first. Ten days back is ample for a nightly
    // run and still covers a holiday week.
    const calendar = await tradingCalendar(isoDaysAgo(20), isoDaysAgo(0));
    const recent = calendar.slice(0, 10);
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
      weight: r.weight,
    }));
    const snapshotted = await upsertTierHistory(screen.asOf, tierRows);

    await finishRun(runId, sessionsAdded, barsAdded, true);

    return NextResponse.json({
      ok: true,
      asOf: screen.asOf,
      sessionsStored: stored,
      emptyRetried: retried,
      barsAdded,
      tiersSnapshotted: snapshotted,
      remaining: Math.max(0, (await missingSessions(calendar.slice(0, 10))).length),
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
