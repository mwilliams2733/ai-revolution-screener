/**
 * Company reference detail from the Polygon ticker endpoint. Server-only.
 *
 * /v3/reference/tickers/{ticker} is confirmed working on this plan and carries
 * a real business description, market cap, employee count and homepage. That is
 * the "what does this company actually do" half of the tooltip; the earnings
 * half comes from lib/finnhub.ts.
 */

const BASE = "https://api.polygon.io";

export interface CompanyDetail {
  readonly ticker: string;
  readonly name: string;
  /** Prose description of the business. Null when Polygon has none. */
  readonly description: string | null;
  readonly sicDescription: string | null;
  readonly marketCap: number | null;
  readonly employees: number | null;
  readonly homepage: string | null;
}

interface DetailResponse {
  readonly results?: {
    readonly ticker?: string;
    readonly name?: string;
    readonly description?: string;
    readonly sic_description?: string;
    readonly market_cap?: number;
    readonly total_employees?: number;
    readonly homepage_url?: string;
  };
}

function apiKey(): string {
  if (typeof window !== "undefined") throw new Error("lib/company.ts is server-only.");
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error("POLYGON_API_KEY is not set");
  return k;
}

/**
 * Detail for one ticker, or null when Polygon has no reference entry.
 *
 * A 404 is ordinary: delisted names and some OTC share classes carry no
 * reference detail. Callers should render the row without a description rather
 * than treating it as an error.
 */
export async function companyDetail(ticker: string): Promise<CompanyDetail | null> {
  const url = new URL(`/v3/reference/tickers/${encodeURIComponent(ticker)}`, BASE);
  url.searchParams.set("apiKey", apiKey());

  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status} for ${ticker}`);

  const body = (await res.json()) as DetailResponse;
  const r = body.results;
  if (!r) return null;

  return {
    ticker: r.ticker ?? ticker,
    name: r.name ?? "",
    description: r.description ?? null,
    sicDescription: r.sic_description ?? null,
    marketCap: r.market_cap ?? null,
    employees: r.total_employees ?? null,
    homepage: r.homepage_url ?? null,
  };
}
