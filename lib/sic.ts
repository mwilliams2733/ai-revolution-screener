/**
 * SIC code -> a two-level sector taxonomy.
 *
 * The screen ranks ~2,300 liquid names but only ~104 of them carry a sector,
 * because lib/theme.ts is a hand-maintained map of the AI CapEx theme. To sort
 * and filter the FULL universe by sector, every ranked name needs a label, and
 * hand-maintaining 2,300 of them is not a plan.
 *
 * WHY SIC AND NOT GICS
 *
 * GICS is the better taxonomy and it is licensed; we cannot use it. SIC is free
 * and comes attached to every filer via SEC EDGAR's submissions endpoint, which
 * this project already authenticates against. Its weaknesses are real and worth
 * knowing before trusting a filter built on it:
 *
 *   - It is a 1930s manufacturing taxonomy retrofitted to software. "Services-
 *     Prepackaged Software" (7372) holds companies with nothing in common.
 *   - It is self-reported. A company picks its own code and rarely revisits it.
 *   - It is coarse where this project most needs resolution: 3674 covers NVDA,
 *     a memory maker and an analog parts supplier as one industry.
 *
 * So this is a navigation aid, not an analytical claim. It exists to let you
 * narrow 2,300 rows to something readable, which the alternative -- no sector at
 * all outside the theme -- does not.
 *
 * TWO LEVELS
 *
 *   sector    ~20 business-meaningful groups, defined here.
 *   subsector EDGAR's own sicDescription, e.g. "Semiconductors & Related
 *             Devices". Already human-readable, already maintained by someone
 *             else, and finer than anything worth hand-rolling.
 *
 * The sector map keys off the 2-digit major group, with 3- and 4-digit
 * overrides where the major group buries something this project cares about --
 * semiconductors inside "Electronic & Other Electrical Equipment" being the
 * obvious case.
 */

/** Every sector this module can return. Stable: the UI builds filters from it. */
export const SECTORS = [
  "Semiconductors",
  "Software",
  "IT Services",
  "Hardware",
  "Communications Equipment",
  "Electronics",
  "Biotech & Pharma",
  "Medical Devices",
  "Healthcare Services",
  "Aerospace & Defense",
  "Automotive",
  "Energy",
  "Utilities",
  "Materials & Chemicals",
  "Industrials",
  "Transportation",
  "Telecom & Media",
  "Financials",
  "Real Estate",
  "Retail & Consumer",
  "Business Services",
  "Other",
] as const;

export type Sector = (typeof SECTORS)[number];

export interface SectorLabels {
  readonly sector: Sector;
  /** EDGAR's sicDescription, or "Unclassified" when the filer has none. */
  readonly subsector: string;
}

/**
 * Four-digit codes that must not inherit their major group's sector.
 *
 * Each entry earns its place by moving a company the screen actually looks at.
 * Ranges are expressed as explicit prefixes below rather than as loops, so the
 * table stays greppable by code.
 */
const EXACT: Record<string, Sector> = {
  // 35xx Industrial & Commercial Machinery: computers hide in 357x.
  "3570": "Hardware",
  "3571": "Hardware",
  "3572": "Hardware",
  "3575": "Hardware",
  "3576": "Hardware", // computer communications equipment
  "3577": "Hardware",
  "3578": "Hardware",
  "3579": "Hardware",
  // 36xx Electronic & Other Electrical Equipment.
  "3661": "Communications Equipment",
  "3663": "Communications Equipment",
  "3669": "Communications Equipment",
  "3672": "Semiconductors", // printed circuit boards, sits with the fabs
  "3674": "Semiconductors",
  "3675": "Electronics",
  "3676": "Electronics",
  "3677": "Electronics",
  "3678": "Electronics",
  "3679": "Electronics",
  // 37xx Transportation Equipment.
  "3711": "Automotive",
  "3713": "Automotive",
  "3714": "Automotive",
  "3715": "Automotive",
  "3716": "Automotive",
  "3721": "Aerospace & Defense",
  "3724": "Aerospace & Defense",
  "3728": "Aerospace & Defense",
  "3760": "Aerospace & Defense", // guided missiles and space vehicles
  "3761": "Aerospace & Defense",
  "3764": "Aerospace & Defense",
  "3769": "Aerospace & Defense",
  "3812": "Aerospace & Defense", // search, detection, navigation
  // 38xx Instruments: medical instruments are a different business.
  "3821": "Medical Devices",
  "3826": "Medical Devices",
  "3827": "Electronics",
  "3829": "Electronics",
  "3841": "Medical Devices",
  "3842": "Medical Devices",
  "3843": "Medical Devices",
  "3844": "Medical Devices",
  "3845": "Medical Devices",
  "3851": "Medical Devices",
  // 28xx Chemicals: drugs and biologicals are not chemicals for our purposes.
  "2833": "Biotech & Pharma",
  "2834": "Biotech & Pharma",
  "2835": "Biotech & Pharma",
  "2836": "Biotech & Pharma",
  // 73xx Business Services: software and IT are the bulk of the market here.
  "7370": "IT Services",
  "7371": "IT Services",
  "7372": "Software",
  "7373": "IT Services",
  "7374": "IT Services",
  "7375": "IT Services",
  "7376": "IT Services",
  "7377": "IT Services",
  "7379": "IT Services",
  "7389": "Business Services",
  // 87xx: contract research is where most clinical-stage biotech files.
  "8731": "Biotech & Pharma",
  // 48xx Communications: cable and broadcasting sit with media.
  "4813": "Telecom & Media",
  "4822": "Telecom & Media",
  "4832": "Telecom & Media",
  "4833": "Telecom & Media",
  "4841": "Telecom & Media",
  "4899": "Telecom & Media",
  // 49xx Utilities: sanitary services is waste management, an industrial.
  "4950": "Industrials",
  "4953": "Industrials",
  "4959": "Industrials",
};

/** Two-digit major group -> sector, applied when no exact code matches. */
const MAJOR: Record<string, Sector> = {
  "01": "Other", "02": "Other", "07": "Other", "08": "Other", "09": "Other",
  "10": "Materials & Chemicals",
  "12": "Energy",
  "13": "Energy",
  "14": "Materials & Chemicals",
  "15": "Industrials", "16": "Industrials", "17": "Industrials",
  "20": "Retail & Consumer", "21": "Retail & Consumer",
  "22": "Retail & Consumer", "23": "Retail & Consumer",
  "24": "Materials & Chemicals", "25": "Retail & Consumer",
  "26": "Materials & Chemicals", "27": "Telecom & Media",
  "28": "Materials & Chemicals",
  "29": "Energy",
  "30": "Materials & Chemicals", "31": "Retail & Consumer",
  "32": "Materials & Chemicals", "33": "Materials & Chemicals",
  "34": "Industrials",
  "35": "Industrials",
  "36": "Electronics",
  "37": "Industrials",
  "38": "Electronics",
  "39": "Retail & Consumer",
  "40": "Transportation", "41": "Transportation", "42": "Transportation",
  "44": "Transportation", "45": "Transportation", "46": "Energy",
  "47": "Transportation",
  "48": "Telecom & Media",
  "49": "Utilities",
  "50": "Industrials", "51": "Industrials",
  "52": "Retail & Consumer", "53": "Retail & Consumer", "54": "Retail & Consumer",
  "55": "Retail & Consumer", "56": "Retail & Consumer", "57": "Retail & Consumer",
  "58": "Retail & Consumer", "59": "Retail & Consumer",
  "60": "Financials", "61": "Financials", "62": "Financials",
  "63": "Financials", "64": "Financials",
  "65": "Real Estate",
  "67": "Financials",
  "70": "Retail & Consumer", "72": "Business Services",
  "73": "Business Services",
  "75": "Business Services", "76": "Business Services",
  "78": "Telecom & Media", "79": "Telecom & Media",
  "80": "Healthcare Services",
  "81": "Business Services", "82": "Business Services", "83": "Business Services",
  "84": "Telecom & Media",
  "86": "Business Services",
  "87": "Business Services",
  "89": "Business Services",
  "91": "Other", "92": "Other", "94": "Other", "95": "Other", "99": "Other",
};

/**
 * Classify a filer.
 *
 * Unknown and missing codes both land in "Other" rather than being dropped. A
 * name the screen ranked must remain visible in a sector view; silently hiding
 * rows that failed classification would make the leaders list quietly
 * incomplete, which is worse than an honest "Other" bucket.
 */
export function classify(
  sic: string | number | null | undefined,
  description?: string | null,
): SectorLabels {
  const subsector = description?.trim() || "Unclassified";
  if (sic == null) return { sector: "Other", subsector };

  // EDGAR reports SIC as a 3- or 4-digit number; pad so "731" and "0731" agree.
  const code = String(sic).trim().padStart(4, "0");
  if (!/^\d{4}$/.test(code)) return { sector: "Other", subsector };

  const exact = EXACT[code];
  if (exact) return { sector: exact, subsector };

  return { sector: MAJOR[code.slice(0, 2)] ?? "Other", subsector };
}

/** Distinct sectors present in a set of rows, in SECTORS order. */
export function sectorsPresent(rows: readonly { sector: string }[]): Sector[] {
  const seen = new Set(rows.map((r) => r.sector));
  return SECTORS.filter((s) => seen.has(s));
}

/**
 * Subsectors present within a sector selection, alphabetical.
 *
 * Scoped to the selection on purpose: offering all ~200 subsectors when the
 * user has narrowed to Semiconductors would make the second filter useless.
 */
export function subsectorsPresent(
  rows: readonly { sector: string; subsector: string }[],
  sectors: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (sectors.size === 0 || sectors.has(r.sector)) seen.add(r.subsector);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
