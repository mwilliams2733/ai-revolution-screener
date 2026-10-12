/**
 * GET /api/lookup/{ticker} -> the full ruleset applied to any ticker.
 *
 * Answers from the screen itself: a ranked name returns the screen's own row
 * (same RS and tier as the table), and an unranked one says which of the
 * screen's gates it failed rather than simply reporting "not found".
 */

import { NextResponse } from "next/server";
import { lookupTicker } from "@/lib/screen-service";

export const dynamic = "force-dynamic";
// The lookup reads the screen's payload, so a cold instance computes the whole
// screen first -- the same budget as /api/screen.
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker: raw } = await ctx.params;
  const ticker = raw.trim().toUpperCase();

  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return NextResponse.json({ error: "Invalid ticker" }, { status: 400 });
  }

  try {
    return NextResponse.json(await lookupTicker(ticker));
  } catch (e) {
    const message = e instanceof Error ? e.message : "lookup failed";
    return NextResponse.json(
      { error: message.replace(/(apiKey|token)=[^&\s]+/g, "$1=***") },
      { status: 500 },
    );
  }
}
