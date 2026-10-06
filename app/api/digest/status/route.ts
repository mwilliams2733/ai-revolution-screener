/**
 * GET /api/digest/status -> has this morning's digest already gone out?
 *
 * Read-only. The GitHub backup scheduler asks this before calling /api/digest,
 * which otherwise rebuilds the whole screen only to find the ledger key taken.
 *
 * The key is the route's own, digestKey(phoenixToday(), asOf), with asOf read
 * as the newest stored session rather than by building the screen. Where those
 * could differ (the screen falling back to the API calendar), the key does not
 * match, the answer is "not sent", and the route runs and dedupes itself --
 * the safe direction.
 */

import { NextResponse } from "next/server";
import { mailSent, storedTradingSessions } from "@/lib/db";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { digestKey } from "@/lib/mail-ledger";
import { phoenixToday } from "@/lib/dates";
import { digestStatus } from "@/lib/schedule-status";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorised(req)) {
    return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ done: false, reason: "DATABASE_URL is not set" });
  }

  const newest = (await storedTradingSessions())[0];
  const key = newest ? digestKey(phoenixToday(), newest) : null;
  return NextResponse.json(digestStatus(key, key ? await mailSent("digest", key) : false));
}
