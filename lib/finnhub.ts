/**
 * Finnhub earnings calendar. Server-only, free tier.
 *
 * This closes the gap STRATEGY_DECODED.md section 6 left open: the earnings
 * surprise history lived on Benzinga endpoints that return 403 on this Polygon
 * plan. HANDOFF.md names Finnhub as option 1 for exactly this, and the key is
 * already in the environment.
 *
 * Deliberately NOT using /company-news. Probed 2026-08-20: LITE returned 162
 * items whose top headlines were index-wide roundups ("top movers within the
 * S&P500") that merely mention the ticker. Rendering that as a "catalyst"
 * produces confident-looking noise. The earnings calendar is structured,
 * per-ticker, and carries estimate against actual.
 */

const BASE = "https://finnhub.io/api/v1";

export interface EarningsEvent {
  /** Report date, ISO. */
  readonly date: string;
  /** "bmo" before open, "amc" after close, "" when unknown. */
  readonly hour: string;
  readonly quarter: number | null;
  readonly year: number | null;
  readonly epsEstimate: number | null;
  readonly epsActual: number | null;
  /** Percent surprise, or null when either side is missing. */
  readonly surprisePct: number | null;
}

export interface EarningsInfo {
  readonly ticker: string;
  /** Soonest report with no actual yet. Null when none is scheduled. */
  readonly next: EarningsEvent | null;
  /** Reported quarters, newest first. */
  readonly history: readonly EarningsEvent[];
  /** How many of the last four beat consensus. Null when fewer than four. */
  readonly beatsLastFour: number | null;
}

interface RawEvent {
  readonly date?: string;
  readonly hour?: string;
  readonly quarter?: number;
  readonly year?: number;
  readonly epsEstimate?: number | null;
  readonly epsActual?: number | null;
}

function token(): string {
  if (typeof window !== "undefined") throw new Error("lib/finnhub.ts is server-only.");
  const t = process.env.FINNHUB_API_KEY;
  if (!t) throw new Error("FINNHUB_API_KEY is not set");
  return t;
}

/**
 * Surprise as a percentage of the estimate.
 *
 * Returns null when the estimate is zero or negative: "beat a loss estimate by
 * 300%" is not a meaningful number, and a sign flip makes the ratio nonsense.
 */
export function surprisePct(estimate: number | null, actual: number | null): number | null {
  if (estimate == null || actual == null || !Number.isFinite(estimate)) return null;
  if (estimate <= 0) return null;
  return ((actual - estimate) / estimate) * 100;
}

function toEvent(r: RawEvent): EarningsEvent | null {
  if (!r.date) return null;
  const est = typeof r.epsEstimate === "number" ? r.epsEstimate : null;
  const act = typeof r.epsActual === "number" ? r.epsActual : null;
  return {
    date: r.date,
    hour: r.hour ?? "",
    quarter: r.quarter ?? null,
    year: r.year ?? null,
    epsEstimate: est,
    epsActual: act,
    surprisePct: surprisePct(est, act),
  };
}

/** Split a raw calendar into upcoming and reported. Exported for testing. */
export function shapeEarnings(ticker: string, raw: readonly RawEvent[]): EarningsInfo {
  const events = raw.map(toEvent).filter((e): e is EarningsEvent => e !== null);

  // "Reported" means an actual exists, not that the date has passed: results
  // land after the close, so a same-day event may still be pending.
  const reported = events
    .filter((e) => e.epsActual != null)
    .sort((a, b) => b.date.localeCompare(a.date));

  const upcoming = events
    .filter((e) => e.epsActual == null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const lastFour = reported.slice(0, 4);
  const beatsLastFour =
    lastFour.length === 4
      ? lastFour.filter((e) => e.surprisePct != null && e.surprisePct > 0).length
      : null;

  return { ticker, next: upcoming[0] ?? null, history: reported.slice(0, 8), beatsLastFour };
}

/** Earnings calendar for one ticker over a window around today. */
export async function earningsFor(ticker: string): Promise<EarningsInfo> {
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - 2);
  const to = new Date();
  to.setUTCMonth(to.getUTCMonth() + 4);

  const url = new URL(`${BASE}/calendar/earnings`);
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("from", from.toISOString().slice(0, 10));
  url.searchParams.set("to", to.toISOString().slice(0, 10));
  url.searchParams.set("token", token());

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status} for ${ticker}`);

  const body = (await res.json()) as { earningsCalendar?: RawEvent[] };
  return shapeEarnings(ticker, body.earningsCalendar ?? []);
}
