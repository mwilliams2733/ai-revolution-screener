/**
 * Cloudflare Access JWT verification.
 *
 * Why this exists when Access already gates the front door: putting Access in
 * front of Vercel protects the custom domain routed through Cloudflare, but the
 * deployment stays reachable at its *.vercel.app URL, which resolves directly to
 * Vercel and never crosses Cloudflare's network. Without verifying the assertion
 * here, that URL is an unauthenticated back door into the whole app.
 *
 * Access signs a JWT and sends it on every proxied request, as the
 * Cf-Access-Jwt-Assertion header and the CF_Authorization cookie. Verifying it
 * against the team's public keys proves the request actually came through
 * Access, and the `aud` claim proves it came through THIS application rather
 * than some other app in the same Cloudflare account.
 *
 * Runs on the edge runtime, so jose (WebCrypto) rather than node:crypto.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

export const ACCESS_HEADER = "cf-access-jwt-assertion";
export const ACCESS_COOKIE = "CF_Authorization";

export interface AccessConfig {
  /** e.g. "yourteam.cloudflareaccess.com" */
  readonly teamDomain: string;
  /** Application Audience (AUD) tag from the Access application. */
  readonly aud: string;
  /** Lowercased emails permitted through. Empty means "trust Access's policy". */
  readonly allowedEmails: ReadonlySet<string>;
}

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

/** Read config from the environment. Returns null when Access is unconfigured. */
export function readAccessConfig(): AccessConfig | null {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = process.env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return null;

  const allowedEmails = new Set(
    (process.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  return { teamDomain: teamDomain.replace(/^https?:\/\//, ""), aud, allowedEmails };
}

/**
 * JWKS clients cache their key fetches, so build one per team domain and reuse
 * it. Rebuilding per request would refetch the key set on every page load.
 */
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(teamDomain: string) {
  let k = jwks.get(teamDomain);
  if (!k) {
    k = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwks.set(teamDomain, k);
  }
  return k;
}

/** Pull the assertion from either transport Access uses. */
export function readToken(headers: Headers, cookie: string | undefined): string | null {
  const h = headers.get(ACCESS_HEADER);
  if (h) return h;
  return cookie ?? null;
}

/**
 * Verify an Access assertion and resolve the identity behind it.
 *
 * Every failure path denies. There is deliberately no "allow on error" branch:
 * an unreachable JWKS endpoint or a malformed token must not become a way in.
 */
export async function verifyAccess(
  token: string | null,
  cfg: AccessConfig,
): Promise<AccessResult> {
  if (!token) {
    return { ok: false, status: 401, reason: "No Cloudflare Access assertion on this request" };
  }

  try {
    const { payload } = await jwtVerify(token, keySet(cfg.teamDomain), {
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
    });

    const email = String(payload.email ?? "").toLowerCase();
    if (!email) {
      return { ok: false, status: 403, reason: "Assertion carries no email claim" };
    }

    // Access's own policy is the primary gate; this is a second, in-repo copy
    // so the allowlist is reviewable in version control and survives someone
    // loosening the dashboard policy by accident.
    if (cfg.allowedEmails.size > 0 && !cfg.allowedEmails.has(email)) {
      return { ok: false, status: 403, reason: `${email} is not on the allowlist` };
    }

    return { ok: true, email };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "verification failed";
    return { ok: false, status: 401, reason: `Invalid Access assertion: ${detail}` };
  }
}
