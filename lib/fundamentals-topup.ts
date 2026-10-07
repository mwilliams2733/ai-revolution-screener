/**
 * Fetch missing or stale fundamentals within a wall-clock budget.
 *
 * Shared by scripts/fundamentals.ts (no budget) and the nightly refresh
 * (bounded, so the route stays under its 300s limit). The budget is checked
 * before each batch starts, so a run can overshoot by at most one batch.
 *
 * A failed fetch is NOT stored: storing it would mark the name fresh and hide
 * the failure for a week. It stays wanted and is retried next run.
 */

import { fundamentalsFor, type Fundamentals } from "./edgar";
import { ciksFor, upsertFundamentals } from "./db";

export interface TopUpDeps {
  ciks(tickers: readonly string[]): Promise<ReadonlyMap<string, string>>;
  fetch(cik: string): Promise<Fundamentals | null>;
  save(rows: readonly { ticker: string; facts: Fundamentals | null }[]): Promise<unknown>;
  now(): number;
}

export interface TopUpResult {
  readonly fetched: number;
  readonly failed: string[];
  readonly remaining: number;
  readonly elapsedMs: number;
}

/** Matches lib/edgar.ts MAX_IN_FLIGHT, so a batch never queues behind itself. */
export const TOPUP_BATCH = 5;

export async function topUpFundamentals(
  tickers: readonly string[],
  budgetMs: number,
  deps: TopUpDeps,
): Promise<TopUpResult> {
  const started = deps.now();
  const failed: string[] = [];
  let fetched = 0;
  let i = 0;
  if (tickers.length === 0 || budgetMs <= 0) {
    return { fetched, failed, remaining: tickers.length, elapsedMs: 0 };
  }

  const ciks = await deps.ciks(tickers);
  while (i < tickers.length && deps.now() - started < budgetMs) {
    const batch = tickers.slice(i, i + TOPUP_BATCH);
    i += batch.length;
    const results = await Promise.all(
      batch.map(async (ticker) => {
        const cik = ciks.get(ticker);
        if (!cik) return { ticker, facts: null as Fundamentals | null, ok: true };
        try {
          return { ticker, facts: await deps.fetch(cik), ok: true };
        } catch {
          return { ticker, facts: null as Fundamentals | null, ok: false };
        }
      }),
    );
    const good = results.filter((r) => r.ok).map(({ ticker, facts }) => ({ ticker, facts }));
    if (good.length > 0) await deps.save(good);
    fetched += good.length;
    failed.push(...results.filter((r) => !r.ok).map((r) => r.ticker));
  }
  return { fetched, failed, remaining: tickers.length - i, elapsedMs: deps.now() - started };
}

export function defaultTopUpDeps(): TopUpDeps {
  return { ciks: ciksFor, fetch: fundamentalsFor, save: upsertFundamentals, now: Date.now };
}
