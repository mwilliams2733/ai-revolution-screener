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
import { groupedDaily, tickerBars, tradingCalendar } from "@/lib/polygon";
import {
  finishRun,
  insertBars,
  missingSessions,
  previousTiers,
  recordSession,
  startRun,
  upsertTierHistory,
  handledSplits,
  markSplitsHandled,
  replaceTickerBars,
  splitHistory,
  storedCalendarBounds,
  tickersWithBars,
  claimMailSend,
  releaseMailSend,
} from "@/lib/db";
import { getScreen } from "@/lib/screen-service";
import { diffTiers, formatAlert, shouldSend, suppressionReason } from "@/lib/alerts";
import { readMailConfig, sendMail } from "@/lib/mailer";
import { classifySession } from "@/lib/session-ledger";
import { isoDaysAgo } from "@/lib/dates";
import { pendingRefetches, refetchTargets } from "@/lib/splits";
import { alertKey } from "@/lib/mail-ledger";

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
 * Tickers whose split-stranded history is repaired per run.
 *
 * Bounded so a backlog drains over several nights instead of timing out the
 * function. The ledger makes that safe: progress is recorded per split, so an
 * interrupted run resumes exactly rather than restarting or skipping.
 */
const MAX_REFETCH_PER_RUN = 25;

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
  const repairedTickers: string[] = [];

  try {
    // Real session dates, newest first, over a window wide enough that a
    // backlog drains instead of falling off the end.
    const calendar = await tradingCalendar(isoDaysAgo(CATCHUP_WINDOW * 2), isoDaysAgo(0));
    const recent = calendar.slice(0, CATCHUP_WINDOW);
    const todo = (await missingSessions(recent)).slice(0, MAX_SESSIONS_PER_RUN);
    // Bounds for any split repair below: a repair must never widen the stored
    // calendar, or one ticker gets sessions no other name has and every
    // positional lookback is off by one for it.
    const calendarBounds = await storedCalendarBounds();

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

    // Repair any history a split has stranded, BEFORE the screen is built.
    // Polygon restates a ticker's whole price series when a split executes and
    // the session-level backfill above can never notice, because its work list
    // is a set difference over sessions and cannot see that a stored session's
    // VALUES changed. Left unrepaired, a 10:1 reverse split makes the
    // twelve-month lookback read about +900% and puts a collapsing micro-cap
    // at the top of the screen.
    //
    // Bounded per run so a backlog drains over several nights rather than
    // timing out the function. Progress is a per-split ledger, so an
    // interrupted run resumes exactly where it stopped.
    const [allSplits, handled, held] = await Promise.all([
      splitHistory(),
      handledSplits(),
      tickersWithBars(),
    ]);
    const pending = pendingRefetches([...allSplits.values()].flat(), handled, held);
    const targets = refetchTargets(pending).slice(0, MAX_REFETCH_PER_RUN);
    for (const t of targets) {
      try {
        const bars = await tickerBars(t.ticker, calendarBounds.lo, calendarBounds.hi);
        if (bars.length > 0) {
          await replaceTickerBars(
            t.ticker,
            bars.map((b) => ({
              session: new Date((b as unknown as { t: number }).t).toISOString().slice(0, 10),
              o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw,
            })),
          );
          repairedTickers.push(t.ticker);
        }
        await markSplitsHandled(
          pending
            .filter((s) => s.ticker === t.ticker)
            .map((s) => ({ ticker: s.ticker, executionDate: s.executionDate })),
        );
      } catch {
        // Deliberately NOT marked handled: an error must leave the work
        // outstanding rather than record a repair that never happened.
      }
    }

    // Snapshot the screen so tier changes are diffable tomorrow.
    //
    // FORCED. getScreen() memoises for 15 minutes at module level, and a warm
    // instance that served the page just before this cron fired would hand
    // back the screen computed BEFORE today's bars were stored: asOf would be
    // yesterday, yesterday's snapshot would be overwritten, today's would never
    // be written, and the response would still say ok. The recompute costs a
    // few seconds once a day; a missing session in tier_history costs a wrong
    // hysteresis baseline tomorrow.
    const screen = await getScreen(true);
    const tierRows = screen.themed.map((r) => ({
      ticker: r.ticker,
      rsPct: r.rsPct,
      vsMa: r.vsMa,
      tier: r.tier,
      // The tier after the hysteresis band and BEFORE the stage, fundamental,
      // health and cap overlays, so tomorrow's band compares like with like.
      // r.momentumTier (from the fundamental gate) is post-stage and must not
      // be used here; see db/schema.sql on momentum_tier. The replay script
      // stores the same value.
      momentumTier: r.bandTier,
      weight: r.weight,
    }));
    // Read the previous session's tiers BEFORE writing today's, or the diff
    // would compare today against itself.
    const previous = await previousTiers(screen.asOf);
    const snapshotted = await upsertTierHistory(screen.asOf, tierRows);

    const changes = diffTiers(
      previous?.tiers ?? new Map(),
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
      const ctx = {
        hasBaseline: (previous?.tiers.size ?? 0) > 0,
        baselineSource: previous?.source ?? null,
        enabled: mail.enabled,
      };
      const send = shouldSend(changes, ctx);
      if (!send) {
        alert = {
          sent: false,
          // Derived from the same context shouldSend judged, so the stated
          // reason cannot drift away from the actual decision.
          reason: suppressionReason(changes, ctx),
          changes: changes.length,
          baseline: previous ? `${previous.session} (${previous.source})` : null,
        };
      } else {
        const key = alertKey(screen.asOf);
        if (!(await claimMailSend("alert", key))) {
          alert = {
            sent: false,
            reason: "alert already sent for this session",
            changes: changes.length,
          };
        } else {
          const { subject, text, html } = formatAlert(changes, screen.asOf);
          // Deliberately still a 200 on failure, unlike /api/digest: this route
          // has already stored bars and snapshotted tiers. A failed email must
          // not mark that work as failed. The reason field says what went
          // wrong without changing the status.
          const result = await sendMail(mail, subject, text, html);
          if (!result.sent) await releaseMailSend("alert", key);
          alert = { ...result, changes: changes.length, subject };
        }
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
      splitsRepaired: repairedTickers,
      // Both backlogs, so a run that is quietly falling behind is visible in
      // the response rather than only in the data.
      remaining: Math.max(0, (await missingSessions(recent)).length),
      splitsPending: Math.max(0, pending.length - targets.length),
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
