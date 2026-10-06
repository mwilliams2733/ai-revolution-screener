/**
 * GET /api/refresh/status -> has today's refresh already been done?
 *
 * Read-only. The GitHub backup scheduler asks this before calling
 * /api/refresh, so a run that arrives after the Vercel cron has finished skips
 * instead of rebuilding the screen for nothing. The work list is the one the
 * refresh itself uses (lib/refresh-backlog.ts), so the two cannot disagree
 * about what is outstanding.
 *
 * Covered by the /api/refresh exemption in proxy.ts (prefix match) and guarded
 * by CRON_SECRET like the route it reports on.
 */

import { NextResponse } from "next/server";
import { hasLiveSnapshot, storedTradingSessions } from "@/lib/db";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { sessionBacklog, splitBacklog } from "@/lib/refresh-backlog";
import { refreshStatus } from "@/lib/schedule-status";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorised(req)) {
    return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ done: false, reason: "DATABASE_URL is not set" });
  }

  const [needing, pending, stored] = await Promise.all([
    sessionBacklog(),
    splitBacklog(),
    storedTradingSessions(),
  ]);
  const newestStored = stored[0] ?? null;
  const status = refreshStatus({
    sessionsNeedingFetch: needing,
    splitsPending: pending.length,
    newestStored,
    snapshotted: newestStored ? await hasLiveSnapshot(newestStored) : false,
  });
  return NextResponse.json(status);
}
