/**
 * GET /api/screen -> ranked JSON.
 *
 * The only way the browser reaches market data. POLYGON_API_KEY is read inside
 * lib/polygon.ts on the server and never leaves it; nothing here is prefixed
 * NEXT_PUBLIC_, and the key is not part of the response.
 */

import { NextResponse } from "next/server";
import { getScreen } from "@/lib/screen-service";

// Bars are delayed end-of-day data, so a short server cache costs nothing in
// freshness and spares the API a full re-fetch on every page load.
export const dynamic = "force-dynamic";
// A cold compute measured 59.2s and 59.7s locally for the market-wide
// pipeline (80.7s before it, with live EDGAR), so 60 left no margin. The
// refresh and digest routes already run at 300.
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fresh = url.searchParams.get("fresh") === "1";

  try {
    // lib/screen-service.ts memoises the payload for both this route and the
    // page, so there is nothing to cache a second time here.
    const payload = await getScreen(fresh);

    return NextResponse.json(
      { ...payload, meta: { ...payload.meta } },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "screen failed";
    // Never echo the upstream URL: it carries the API key as a query param.
    return NextResponse.json(
      { error: message.replace(/apiKey=[^&\s]+/g, "apiKey=***") },
      { status: 500 },
    );
  }
}
