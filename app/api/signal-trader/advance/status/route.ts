/**
 * GET /api/signal-trader/advance/status -> is there anything to process?
 * The GitHub backup asks this first and skips on "done":true. Uses the job's
 * own work list (backlog), so the two cannot disagree.
 */
import { NextResponse } from "next/server";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { backlog } from "@/lib/signal-trader/advance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  const b = await backlog();
  return NextResponse.json({ done: b.todo.length === 0, waiting: b.todo, latestStored: b.latestStored, lastProcessed: b.lastProcessed });
}
