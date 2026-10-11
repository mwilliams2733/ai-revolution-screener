/**
 * Request gate. Next.js 16 calls this Proxy; it was Middleware before 16.
 *
 * Enforces that every request actually arrived through Cloudflare Access,
 * including requests to the *.vercel.app hostname that bypasses Cloudflare
 * entirely. See lib/access.ts for why the header check is load-bearing rather
 * than belt-and-braces.
 *
 * Failure modes, all closed:
 *   unconfigured in production -> 503, nobody gets in
 *   missing or bad assertion   -> 401
 *   valid assertion, wrong person -> 403
 *
 * The cron routes are exempt from Access because a scheduler calls the
 * deployment directly and has no browser identity. They authenticate with
 * CRON_SECRET instead, which each route checks itself.
 *
 * EVERY scheduled route must be listed in CRON_PATHS. Adding /api/digest and
 * its cron entry without adding it here produced a 401 from this file before
 * the route ever ran -- every morning, silently, with no email and nothing in
 * the logs naming the cause. The two 401s are distinguishable only by their
 * body: "No Cloudflare Access assertion" is this file, "Send Authorization:
 * Bearer <CRON_SECRET>" is the route.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, readAccessConfig, readToken, verifyAccess } from "@/lib/access";

/** Paths that authenticate by shared secret rather than by Access identity. */
const CRON_PATHS = ["/api/refresh", "/api/digest", "/api/signal-trader/advance"];

function deny(status: number, reason: string, detail?: string) {
  return NextResponse.json({ error: reason, detail }, { status });
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Vercel Cron cannot carry an Access identity. The route validates
  // CRON_SECRET itself; skipping here only moves the check, it does not skip it.
  if (CRON_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Local development can never satisfy this check: Cloudflare is not in front
  // of localhost, so no request will ever carry an assertion. Enforcing here
  // just locks the developer out of their own machine. Production is unaffected.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const cfg = readAccessConfig();

  if (!cfg) {

    // In production an unset config is a misconfiguration, not permission.
    // Failing closed locks you out; failing open publishes the app.
    return deny(
      503,
      "Access is not configured",
      "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD in the Vercel project, then redeploy.",
    );
  }

  const token = readToken(req.headers, req.cookies.get(ACCESS_COOKIE)?.value);
  const result = await verifyAccess(token, cfg);

  if (!result.ok) {
    return deny(result.status, "Not authorised", result.reason);
  }

  // Pass the verified identity downstream so routes never re-parse the token.
  const headers = new Headers(req.headers);
  headers.set("x-access-email", result.email);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's static output and the favicon. The screen route is
  // deliberately included: it is the endpoint that costs API budget.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
