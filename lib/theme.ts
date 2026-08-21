/**
 * The theme gate: the CapEx-taker universe.
 *
 * This is the discretionary layer and it does most of the selection work.
 * STRATEGY_DECODED.md section 4 shows why: run the momentum ruleset against all
 * 2,204 liquid US common stocks and roughly 60% of the top 45 comes back as
 * clinical-stage biotech. Only eleven AI-relevant names surface unaided. The
 * theme gate is the strategy; momentum only ranks within it.
 *
 * Membership rule: the company should be a net beneficiary of AI infrastructure
 * spending, not a net spender. Edit freely, and keep edits in version control so
 * you can see how the universe drifts over time.
 */

export type Sector =
  | "compute_gpu_cpu"
  | "memory_storage"
  | "semicap_equipment"
  | "foundry_packaging"
  | "optics_networking"
  | "power_thermal_datacenter"
  | "materials_specialty"
  | "security_identity"
  | "data_infra_software"
  | "robotics_automation"
  | "defense_space_autonomy"
  | "ai_appliers";

export const THEME: Readonly<Record<Sector, readonly string[]>> = {
  compute_gpu_cpu: ["NVDA", "AMD", "ARM", "AVGO", "MRVL", "INTC", "QCOM", "SMCI"],
  // The crowding-vetoed cohort. These are theme members that happen to be
  // withheld, not non-members: they must exist here so the UI can render them
  // greyed out with a reason. Before this sector existed, only MU was reachable
  // and SNDK, WDC, STX, SK and MRAM were dropped silently.
  memory_storage: ["MU", "SNDK", "WDC", "STX", "SK", "MRAM"],
  semicap_equipment: [
    "AMAT", "LRCX", "KLAC", "ASML", "TER", "ONTO", "ACMR", "AEHR",
    "UCTT", "ICHR", "CAMT", "NVMI", "AXTI", "COHU", "FORM",
  ],
  foundry_packaging: ["TSM", "GFS", "AMKR", "UMC", "ASX"],
  optics_networking: [
    "LITE", "COHR", "AAOI", "FN", "CIEN", "ANET", "CRDO", "ALAB",
    "MTSI", "SITM", "POET", "INFN", "EXTR", "JNPR",
  ],
  power_thermal_datacenter: [
    "VRT", "ETN", "PWR", "AGX", "MOD", "GEV", "PH", "HUBB",
    "NVT", "AAON", "CARR", "JCI", "ATKR", "EMR", "ROK",
  ],
  materials_specialty: ["CRS", "ATI", "HAYN", "MTRN", "ENTG", "CBT", "IIVI"],
  security_identity: [
    "FTNT", "PANW", "CRWD", "ZS", "OKTA", "S", "CYBR", "TENB",
    "QLYS", "RPD", "VRNS", "EVLV", "FFIV",
  ],
  data_infra_software: [
    "PLTR", "SNOW", "MDB", "DDOG", "CFLT", "ESTC", "NTNX",
    "PSTG", "NTAP", "DELL", "HPE", "IOT", "TOST",
  ],
  robotics_automation: [
    "SYM", "FANUY", "OMRNY", "TMRAY", "ROK", "TER", "ZBRA",
    "CGNX", "NDSN", "IRBT",
  ],
  defense_space_autonomy: [
    "KTOS", "AVAV", "RDW", "LHX", "LMT", "RTX", "NOC",
    "PLTR", "RKLB", "LUNR", "BWXT", "LDOS",
  ],
  ai_appliers: [
    "LLY", "TOST", "ISRG", "VEEV", "TTD", "APP", "DUOL", "HOOD",
    "SHOP", "NOW", "CRM", "ADBE",
  ],
};

/**
 * Excluded by rule: net AI CapEx spenders.
 *
 * This is Lango's central argument. The spenders see free cash flow depleted
 * while the takers see earnings and cash flow expand, and stocks follow earnings.
 * It is the single rule that explains the absence of MSFT, GOOGL, META and AMZN
 * from an AI portfolio.
 */
export const CAPEX_SPENDERS: ReadonlySet<string> = new Set([
  "MSFT", "GOOGL", "GOOG", "META", "AMZN", "AAPL", "ORCL", "IBM", "TSLA",
]);

/**
 * Crowding veto: cohorts judged too crowded or speculative regardless of score.
 *
 * Currently memory and storage. This is not a quality judgment. As of 2026-08-19
 * these are among the strongest momentum names in the entire market (SNDK ranks
 * #1 of 2,204, MU #15, WDC #40, STX #45) and the portfolio owns none of them.
 * Navellier's stated reason: "if you had all your money in memory stocks, you
 * probably have indigestion right now... a lot of that might be Korean
 * speculation, leverage ETFs."
 *
 * Surface vetoed names in the UI greyed out with the reason attached rather than
 * dropping them silently, or in six months nobody will remember why the best
 * name in the market is missing.
 */
export const CROWDING_VETO: ReadonlySet<string> = new Set([
  "SNDK", "MU", "WDC", "STX", "SK", "MRAM",
]);

export interface ThemeOptions {
  /** Include names under the crowding veto. Default false. */
  readonly includeVetoed?: boolean;
  /** Restrict to tickers present in this set, typically the reference universe. */
  readonly restrictTo?: ReadonlySet<string>;
}

/**
 * Build the theme universe as ticker -> sector.
 * A ticker listed in several sectors resolves to the first one declared.
 */
export function themeUniverse(opts: ThemeOptions = {}): Map<string, Sector> {
  const { includeVetoed = false, restrictTo } = opts;
  const out = new Map<string, Sector>();
  for (const [sector, tickers] of Object.entries(THEME) as [Sector, readonly string[]][]) {
    for (const t of tickers) {
      if (CAPEX_SPENDERS.has(t)) continue;
      if (!includeVetoed && CROWDING_VETO.has(t)) continue;
      if (restrictTo && !restrictTo.has(t)) continue;
      if (!out.has(t)) out.set(t, sector);
    }
  }
  return out;
}

/** Why a ticker is absent from the theme universe, or null if it is present. */
export function exclusionReason(ticker: string): string | null {
  if (CAPEX_SPENDERS.has(ticker)) return "net AI CapEx spender";
  if (CROWDING_VETO.has(ticker)) return "crowding veto: memory/storage";
  return null;
}
