/**
 * Stored EDGAR fundamentals: what to fetch, and what is usable.
 *
 * Fundamentals used to be fetched live during the screen and cached in memory,
 * which was fine for ~40 AI names and impossible for ~400 market-wide Strong Buy
 * candidates inside a 60s request. They now live in company_fundamentals, filled
 * by scripts/fundamentals.ts and topped up by the nightly refresh.
 *
 * Quarterly data, so a week-old copy loses nothing. A stale row is still USED
 * for gating -- it is only queued for a re-fetch. A missing row is unverified,
 * which the gate already treats as "do not demote".
 */

import type { Fundamentals } from "./edgar";

export const FUNDAMENTALS_MAX_AGE_DAYS = 7;

export interface StoredFundamentals {
  /** Null means "fetched, and the filer has no usable SEC data". Not re-fetched until stale. */
  readonly facts: Fundamentals | null;
  readonly fetchedAt: string;
}

/**
 * Candidates that need a fetch: missing first, in candidate order, then stale
 * oldest-first. Set difference, never a high-water mark, so a gap anywhere is found.
 */
export function wantedFundamentals(
  candidates: readonly string[],
  fetchedAt: ReadonlyMap<string, string>,
  now: Date,
  maxAgeDays: number = FUNDAMENTALS_MAX_AGE_DAYS,
): string[] {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const missing: string[] = [];
  const stale: { t: string; at: number }[] = [];
  for (const t of new Set(candidates)) {
    const at = fetchedAt.get(t);
    if (at == null) {
      missing.push(t);
      continue;
    }
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) stale.push({ t, at: -Infinity });
    else if (ms < cutoff) stale.push({ t, at: ms });
  }
  stale.sort((a, b) => a.at - b.at || a.t.localeCompare(b.t));
  return [...missing, ...stale.map((s) => s.t)];
}

/**
 * The facts the gate may judge: the Strong Buy candidates' only.
 *
 * The store holds facts for every name that was EVER a candidate. Handing the
 * gate facts for a name that has since slipped below Strong Buy marks it
 * "demote", and the book then tells you it was "held at Buy" when it never was
 * a Strong Buy. Scoping to candidates keeps the semantics the live fetch had.
 * Null rows are left out so they read as unverified.
 */
export function usableFundamentals(
  stored: ReadonlyMap<string, StoredFundamentals>,
  candidates: Iterable<string>,
): Map<string, Fundamentals> {
  const out = new Map<string, Fundamentals>();
  for (const t of candidates) {
    const facts = stored.get(t)?.facts;
    if (facts) out.set(t, facts);
  }
  return out;
}
