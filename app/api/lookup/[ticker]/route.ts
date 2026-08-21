/**
 * GET /api/lookup/{ticker} -> the full ruleset applied to any ticker.
 *
 * Works for names outside the theme. When a ticker does not appear, the
 * response says which gate it failed rather than simply reporting "not found".
 */

import { NextResponse } from "next/server";
import { lookupTicker } from "@/lib/screen-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
