/**
 * POST|GET /api/signal-trader/advance -> the Signal Trader morning job.
 * Cron target (Vercel + GitHub backup). Exempt from Cloudflare Access in
 * proxy.ts; authenticates with CRON_SECRET. Paper only.
 */
import { NextResponse } from "next/server";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { runAdvance } from "@/lib/signal-trader/advance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await runAdvance()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
