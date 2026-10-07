/**
 * Which group a ranked name is shown under, market-wide.
 *
 * Three kinds, in precedence order:
 *   1. ai_spenders -- the net AI CapEx spenders the strategy excludes. Ranked
 *      and shown so you can see where they stand, badged with the reason.
 *   2. ai_theme    -- the hand-maintained THEME map. First declared wins, the
 *      same rule themeUniverse uses, so a name never sits in two groups.
 *      Crowding-vetoed names stay in their theme, badged.
 *   3. sector      -- the SIC sector from lib/sic.ts, or Unclassified when the
 *      filer has no SIC code at all.
 *
 * Grouping is presentation only. It never re-ranks: rsPct is the universe-wide
 * percentile, computed once before any of this runs.
 */

import {
  CAPEX_SPENDERS,
  CROWDING_VETO,
  THEME,
  exclusionReason,
  type Sector as ThemeSector,
} from "./theme";
import type { SectorLabels } from "./sic";
import type { Tier } from "./types";

export type GroupKind = "ai_theme" | "ai_spenders" | "sector";

export interface Group {
  readonly name: string;
  readonly kind: GroupKind;
  /** Why the strategy excludes this name, or null. */
  readonly badge: string | null;
}

export const AI_SPENDERS = "AI spenders";
export const UNCLASSIFIED = "Unclassified";

export const THEME_LABELS: Readonly<Record<ThemeSector, string>> = {
  compute_gpu_cpu: "Compute (GPU/CPU)",
  memory_storage: "Memory & storage",
  semicap_equipment: "Semicap equipment",
  foundry_packaging: "Foundry & packaging",
  optics_networking: "Optics & networking",
  power_thermal_datacenter: "Power, thermal & datacenter",
  materials_specialty: "Specialty materials",
  security_identity: "Security & identity",
  data_infra_software: "Data infrastructure software",
  robotics_automation: "Robotics & automation",
  defense_space_autonomy: "Defense, space & autonomy",
  ai_appliers: "AI appliers",
};

/** ticker -> its first-declared theme. Built once; THEME is a constant. */
const THEME_OF: ReadonlyMap<string, ThemeSector> = (() => {
  const m = new Map<string, ThemeSector>();
  for (const [key, tickers] of Object.entries(THEME) as [ThemeSector, readonly string[]][]) {
    for (const t of tickers) if (!m.has(t)) m.set(t, key);
  }
  return m;
})();

export function groupOf(ticker: string, sic: SectorLabels | undefined): Group {
  if (CAPEX_SPENDERS.has(ticker)) {
    return { name: AI_SPENDERS, kind: "ai_spenders", badge: exclusionReason(ticker) };
  }
  const theme = THEME_OF.get(ticker);
  if (theme) {
    return {
      name: THEME_LABELS[theme],
      kind: "ai_theme",
      badge: CROWDING_VETO.has(ticker) ? exclusionReason(ticker) : null,
    };
  }
  if (sic) return { name: sic.sector, kind: "sector", badge: null };
  return { name: UNCLASSIFIED, kind: "sector", badge: null };
}

/** The fields grouping and summarising need. MarketRow satisfies it. */
export interface GroupedLike {
  readonly ticker: string;
  readonly name: string;
  readonly group: string;
  readonly groupKind: GroupKind;
  readonly rsPct: number | null;
  readonly tier: Tier | null;
}

export interface GroupStat {
  readonly name: string;
  readonly kind: GroupKind;
  readonly count: number;
  /** Median, not mean: one 99th-percentile name should not describe forty middling ones. */
  readonly medianRs: number | null;
  readonly strongBuy: number;
  readonly buy: number;
  readonly hold: number;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summariseGroups(rows: readonly GroupedLike[]): GroupStat[] {
  const groups = new Map<string, GroupedLike[]>();
  for (const r of rows) {
    const g = groups.get(r.group);
    if (g) g.push(r);
    else groups.set(r.group, [r]);
  }
  return [...groups.values()]
    .map((g): GroupStat => ({
      name: g[0].group,
      kind: g[0].groupKind,
      count: g.length,
      medianRs: median(
        g.map((r) => r.rsPct).filter((v): v is number => v != null && Number.isFinite(v)),
      ),
      strongBuy: g.filter((r) => r.tier === "Strong Buy").length,
      buy: g.filter((r) => r.tier === "Buy").length,
      hold: g.filter((r) => r.tier === "Hold").length,
    }))
    .sort(
      (a, b) =>
        (b.medianRs ?? -Infinity) - (a.medianRs ?? -Infinity) || a.name.localeCompare(b.name),
    );
}

export type KindFilter = "all" | "ai" | "sector";
export type TierFilter = "all" | Tier;

export interface GroupFilter {
  readonly kind: KindFilter;
  readonly tier: TierFilter;
  readonly query: string;
}

/**
 * Filter, then bucket into groups in `order`, rows ranked by RS within each.
 * Groups left empty by the filter are dropped rather than drawn as bare headers.
 */
export function filterAndGroup<T extends GroupedLike>(
  rows: readonly T[],
  f: GroupFilter,
  order: readonly GroupStat[],
): { stat: GroupStat; rows: T[] }[] {
  const q = f.query.trim().toUpperCase();
  const keep = (r: T) =>
    (f.kind === "all" || (f.kind === "ai" ? r.groupKind !== "sector" : r.groupKind === "sector")) &&
    (f.tier === "all" || r.tier === f.tier) &&
    (q === "" || r.ticker.toUpperCase().includes(q) || r.name.toUpperCase().includes(q));

  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    if (!keep(r)) continue;
    const g = byGroup.get(r.group);
    if (g) g.push(r);
    else byGroup.set(r.group, [r]);
  }
  const rank = (a: T, b: T) =>
    (b.rsPct ?? -Infinity) - (a.rsPct ?? -Infinity) || a.ticker.localeCompare(b.ticker);

  return order
    .filter((s) => byGroup.has(s.name))
    .map((s) => ({ stat: s, rows: (byGroup.get(s.name) as T[]).sort(rank) }));
}
