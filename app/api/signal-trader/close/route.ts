/**
 * POST { key } -> cancel a pick that has not filled, or close an open paper
 * position at the next open (the decision is made with today's information).
 */
import { NextResponse } from "next/server";
import { requestClose } from "@/lib/signal-trader/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  if (typeof body?.key !== "string" || !body.key) {
    return NextResponse.json({ error: "Send { key: <pick key> }." }, { status: 400 });
  }
  const result = await requestClose(body.key, new Date());
  return NextResponse.json({ result }, { status: result === "not_found" ? 404 : 200 });
}
