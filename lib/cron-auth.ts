/**
 * Shared-secret check for the scheduled routes and their status probes.
 *
 * These paths are exempt from Cloudflare Access in proxy.ts because a scheduler
 * carries no browser identity, so this is the only lock on them. One copy, so
 * a status probe cannot end up guarded differently from the route it reports on.
 */

/** Constant-time-ish compare, to avoid leaking the secret through timing. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function cronAuthorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // an unset secret is a locked door, not an open one
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && secretMatches(token, expected);
}

/** The 401 every scheduled route answers, naming which half is missing. */
export function cronUnauthorisedBody() {
  return {
    error: "Not authorised",
    detail: process.env.CRON_SECRET
      ? "Send Authorization: Bearer <CRON_SECRET>."
      : "CRON_SECRET is not set on this deployment.",
  };
}
