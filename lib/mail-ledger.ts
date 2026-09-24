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
 * The digest is keyed by the DAY IT IS SENT and the SESSION it describes.
 *
 * Keying on the day alone looks right and is not quite. The digest is a
 * heartbeat: it must arrive every weekday even when the data has not moved,
 * because "4 sessions behind" is precisely the message that tells you the
 * refresh died -- so the day is part of the key, and a stalled pipeline
 * still sends exactly once per day (the session does not change).
 *
 * The session is ALSO part of the key because the 6 AM digest can legally
 * fire before the 5 AM refresh has landed (Hobby cron precision is the whole
 * hour). Without asOf in the key that morning's "one session behind" email
 * is the only one you get; with it, the later backup scheduler sends one
 * corrected digest once the new session exists. Never more than two a day.
 *
 * `today` is the Phoenix calendar day from phoenixToday(), not UTC: a manual
 * run at 6 PM Phoenix is still "today" to the reader, but is already
 * tomorrow in UTC and would silence the next real morning.
 */
export function digestKey(today: string, asOf: string): string {
  return `digest:${today}:${asOf}`;
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
