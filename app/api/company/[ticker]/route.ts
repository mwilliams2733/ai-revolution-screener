/**
 * GET /api/company/{ticker} -> business summary + earnings catalysts.
 *
 * Fetched lazily when a tooltip opens, not prefetched for the whole table:
 * 104 names would be 208 upstream calls to populate something most of which is
 * never read.
 */

import { NextResponse } from "next/server";
import { companyDetail } from "@/lib/company";
import { earningsFor } from "@/lib/finnhub";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Descriptions barely change; earnings move a few times a year. */
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(_req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker: raw } = await ctx.params;
  const ticker = raw.trim().toUpperCase();

  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return NextResponse.json({ error: "Invalid ticker" }, { status: 400 });
  }

  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json(hit.body, { headers: { "Cache-Control": "private, max-age=3600" } });
  }

  try {
    // One slow source must not blank the whole tooltip, so settle both and
    // render whichever half arrived.
    const [detail, earnings] = await Promise.allSettled([
      companyDetail(ticker),
      earningsFor(ticker),
    ]);

    const body = {
      ticker,
      detail: detail.status === "fulfilled" ? detail.value : null,
      earnings: earnings.status === "fulfilled" ? earnings.value : null,
      partial: detail.status === "rejected" || earnings.status === "rejected",
    };

    cache.set(ticker, { at: Date.now(), body });
    return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "lookup failed";
    return NextResponse.json(
      { error: message.replace(/(apiKey|token)=[^&\s]+/g, "$1=***") },
      { status: 500 },
    );
  }
}
