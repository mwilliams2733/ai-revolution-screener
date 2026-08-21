/**
 * Polygon-compatible REST client. Server-only.
 *
 * Only two endpoints are available on the current plan, confirmed by probe:
 *   /v3/reference/tickers                              -> 200
 *   /v2/aggs/grouped/locale/us/market/stocks/{date}     -> 200
 *   /stocks/financials/v1/*                             -> 403
 *   /benzinga/v1/*                                      -> 403
 * Do not add calls to the 403 families. Fundamentals come from SEC EDGAR
 * instead; see HANDOFF.md section "Data plan".
 *
 * The grouped endpoint is the whole reason this is cheap: one call returns
 * ~12,500 bars for the entire US market. Backfilling a year is ~250 calls.
 * Never fetch per-ticker histories.
 */

import type { PolygonBar } from "./factors";

const BASE = "https://api.polygon.io";

/** Fail loudly if this module is ever pulled into a client bundle. */
function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "lib/polygon.ts is server-only. Call it from a route handler, never from a component.",
    );
  }
}

function apiKey(): string {
  assertServer();
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error("POLYGON_API_KEY is not set");
  return k;
}

export interface FetchOptions {
  /** Attempts per URL, including the first. Default 4. */
  readonly retries?: number;
  /** Base backoff in ms, doubled per attempt. Default 800. */
  readonly backoffMs?: number;
  readonly signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a Polygon path and parse JSON.
 *
 * Retries 429 and 5xx with exponential backoff. A 403 is terminal and throws
 * immediately: it means the endpoint is not on the plan, and retrying it just
 * burns the rate budget.
 */
async function get<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { retries = 4, backoffMs = 800, signal } = opts;
  const url = new URL(path, BASE);
  url.searchParams.set("apiKey", apiKey());

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { signal, cache: "no-store" });
      if (res.status === 403) {
        throw new Error(`403 from ${path.split("?")[0]} - not available on this plan`);
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${path.split("?")[0]}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${path.split("?")[0]}`);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof Error && e.message.includes("not available on this plan")) throw e;
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`failed: ${path}`);
}

// ---------------------------------------------------------------------------
// Grouped daily bars
// ---------------------------------------------------------------------------

/**
 * Grouped rows carry the open price too. lib/factors.ts PolygonBar omits `o`
 * because the screen never needed it; this extends rather than edits the core
 * type, so barsByTicker still accepts these rows unchanged.
 */
export interface GroupedBar extends PolygonBar {
  readonly o?: number;
}

interface GroupedResponse {
  readonly status?: string;
  readonly resultsCount?: number;
  readonly results?: readonly GroupedBar[];
}

/**
 * Whole-market daily bars for one session.
 *
 * Returns [] for weekends and market holidays: the API answers 200 with no
 * results rather than an error, so an empty array means "not a session", not
 * "call failed". Callers backfilling a range should treat [] as skip.
 */
export async function groupedDaily(date: string, opts: FetchOptions = {}): Promise<GroupedBar[]> {
  const res = await get<GroupedResponse>(
    `/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`,
    opts,
  );
  return [...(res.results ?? [])];
}

// ---------------------------------------------------------------------------
// Reference universe
// ---------------------------------------------------------------------------

export interface TickerRef {
  readonly ticker: string;
  readonly name: string;
  readonly primaryExchange: string | null;
  /** Zero-padded to 10 digits for SEC EDGAR companyfacts. Null if absent. */
  readonly cik: string | null;
  readonly active: boolean;
  readonly delistedUtc: string | null;
}

interface RefRow {
  readonly ticker?: string;
  readonly name?: string;
  readonly primary_exchange?: string;
  readonly cik?: string;
  readonly active?: boolean;
  readonly delisted_utc?: string;
}

interface RefResponse {
  readonly results?: readonly RefRow[];
  readonly next_url?: string;
}

function toRef(r: RefRow, active: boolean): TickerRef | null {
  if (!r.ticker) return null;
  return {
    ticker: r.ticker,
    name: r.name ?? "",
    primaryExchange: r.primary_exchange ?? null,
    cik: r.cik ? r.cik.padStart(10, "0") : null,
    active: r.active ?? active,
    delistedUtc: r.delisted_utc ?? null,
  };
}

/**
 * Every US common stock, following pagination to exhaustion.
 *
 * `active` must be fetched BOTH ways and both stored. active=true alone omits
 * delisted names, and that hole cannot be reconstructed after the fact: any
 * backtest built on a live-only universe inherits survivorship bias. See
 * HANDOFF.md, "Survivorship bias will bite any backtest".
 */
export async function referenceTickers(
  active: boolean,
  opts: FetchOptions = {},
): Promise<TickerRef[]> {
  const out: TickerRef[] = [];
  let path: string | null =
    `/v3/reference/tickers?market=stocks&type=CS&active=${active}&limit=1000`;

  while (path) {
    const res: RefResponse = await get<RefResponse>(path, opts);
    for (const row of res.results ?? []) {
      const ref = toRef(row, active);
      if (ref) out.push(ref);
    }
    path = res.next_url ? new URL(res.next_url).pathname + new URL(res.next_url).search : null;
  }
  return out;
}

/** Both halves of the universe, delisted names included. */
export async function fullUniverse(opts: FetchOptions = {}): Promise<TickerRef[]> {
  const [live, dead] = await Promise.all([
    referenceTickers(true, opts),
    referenceTickers(false, opts),
  ]);
  const m = new Map<string, TickerRef>();
  for (const r of dead) m.set(r.ticker, r);
  for (const r of live) m.set(r.ticker, r); // live wins on collision
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// Session calendar
// ---------------------------------------------------------------------------

/** Calendar days walking backwards from `end`, weekends removed. */
export function candidateSessions(end: Date, count: number): string[] {
  const out: string[] = [];
  const d = new Date(end.getTime());
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trading calendar
// ---------------------------------------------------------------------------

interface AggResponse {
  readonly results?: readonly { readonly t: number }[];
}

/**
 * Real trading-session dates, newest first.
 *
 * This is the one legitimate per-ticker aggregates call. HANDOFF.md rules out
 * per-ticker histories for BULK DATA, and rightly so: the grouped endpoint
 * already returns every name. Here every price is discarded and only the
 * timestamps are kept, because a liquid mega-cap trades on exactly the days the
 * market is open. That turns "which candidate dates are real sessions?" into a
 * single call instead of one probe per candidate weekday.
 */
export async function tradingCalendar(
  from: string,
  to: string,
  proxyTicker = "NVDA",
  opts: FetchOptions = {},
): Promise<string[]> {
  const res = await get<AggResponse>(
    `/v2/aggs/ticker/${proxyTicker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=50000`,
    opts,
  );
  return (res.results ?? []).map((r) => new Date(r.t).toISOString().slice(0, 10));
}

/** Anchor dates for the five snapshots the screen reads. */
export function anchorDates(
  calendar: readonly string[],
  lookbacks: Readonly<Record<string, number>>,
): Record<string, string | undefined> {
  return {
    now: calendar[0],
    r1m: calendar[lookbacks.r1m],
    r3m: calendar[lookbacks.r3m],
    r6m: calendar[lookbacks.r6m],
    r12m: calendar[lookbacks.r12m],
  };
}
