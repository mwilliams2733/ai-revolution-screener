/**
 * Which sessions the replay may write.
 *
 * A session with ANY live row is off limits, not just its live rows. The
 * replay's upsert already refuses to overwrite a live row, but a ticker the
 * live snapshot lacks would be INSERTED as a replay row, and a session holding
 * both kinds reads as a replay to previousTiers(). That suppresses the next
 * alert and turns the digest's baseline into "not comparable". On 2026-09-24
 * one replay run did exactly this to six live sessions.
 *
 * Pure so the rule is testable; scripts/replay-tiers.ts applies it.
 */
export function replayMayWrite(session: string, liveSessions: ReadonlySet<string>): boolean {
  return !liveSessions.has(session);
}
