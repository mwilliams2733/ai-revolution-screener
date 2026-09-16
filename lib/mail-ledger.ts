/**
 * Dedupe keys for the two outbound emails.
 *
 * Pure and separate from lib/db.ts so the KEY CHOICE -- the part that is easy
 * to get wrong and impossible to notice once wrong -- is testable without a
 * database.
 */

/** What kind of message a ledger row records. */
export type MailKind = "digest" | "alert";

/**
 * The digest is keyed by the DAY IT IS SENT, not by the session it describes.
 *
 * This looks wrong and is not. The digest is a heartbeat: it must arrive every
 * weekday even when the data has not moved, because "4 sessions behind" is
 * precisely the message that tells you the refresh died. Keying on asOf would
 * mean a stalled pipeline -- the one case the digest exists for -- sends ONE
 * email and then goes silent, which is the exact failure it was built to
 * prevent.
 *
 * `today` is a UTC yyyy-mm-dd string, from isoDaysAgo(0).
 */
export function digestKey(today: string): string {
  return `digest:${today}`;
}

/**
 * The alert is keyed by the SESSION it reports on.
 *
 * The opposite choice from the digest, for the opposite reason. The alert is
 * exception-driven: it fires because tier changes were computed by diffing
 * against the previous session. Re-running the refresh on the same asOf
 * recomputes an identical diff -- previousTiers selects `session < asOf`, so
 * the baseline does not move -- and re-firing would report the morning's moves
 * again in the afternoon as though they were new.
 *
 * One alert per session is therefore the correct unit. A genuinely new session
 * carries a new asOf and sends normally.
 */
export function alertKey(asOf: string): string {
  return `alert:${asOf}`;
}
