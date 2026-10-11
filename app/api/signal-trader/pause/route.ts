/** POST { paused: boolean } -> set the global auto-trade pause. Paper only. */
import { NextResponse } from "next/server";
import { setPaused } from "@/lib/signal-trader/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") {
    return NextResponse.json({ error: "Send { paused: true | false }." }, { status: 400 });
  }
  await setPaused(body.paused);
  return NextResponse.json({ paused: body.paused });
}
