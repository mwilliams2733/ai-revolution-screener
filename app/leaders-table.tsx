"use client";

import { useMemo } from "react";
import { SECTORS, sectorsPresent, subsectorsPresent } from "@/lib/sic";
import { DEFAULT_PARAMS } from "@/lib/params";
import { MISSING, money, num, pct, railWidth, signClass } from "@/lib/format";
import { usePersistedState } from "./use-persisted-state";
import type { LeaderRow, ScreenPayload } from "@/lib/screen-service";

/**
 * The whole ranked universe, filterable by sector and subsector.
 *
 * The themed table answers "how do the AI CapEx names rank"; this one answers
 * "how does anything rank, and how do the groups compare". They share one
 * ranking: percentiles are computed once across every liquid name before any
 * filter runs, so an RS of 90 means the same thing in both tables and in every
 * sector selection. Filtering NEVER re-ranks -- that is the entire point of
 * doing it after the analysis rather than before.
 */

const BUY_CUT = DEFAULT_PARAMS.buyRs;
const STRONG_CUT = DEFAULT_PARAMS.strongRs;

type SortKey = "rsPct" | "r3m" | "r12m" | "vsMa" | "dollarVolume" | "ticker";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "rsPct", label: "RS rank" },
  { key: "r3m", label: "3-month" },
  { key: "r12m", label: "12-month" },
  { key: "vsMa", label: "vs MA" },
  { key: "dollarVolume", label: "Liquidity" },
  { key: "ticker", label: "Ticker" },
];

/** How many rows to draw before the "show more" control. */
const PAGE = 100;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isSortKey = (v: unknown): v is SortKey =>
  typeof v === "string" && SORTS.some((s) => s.key === v);
const isDir = (v: unknown): v is "asc" | "desc" => v === "asc" || v === "desc";
const isCount = (v: unknown): v is number => typeof v === "number" && v > 0;

function value(r: LeaderRow, key: SortKey): number | string {
  if (key === "ticker") return r.ticker;
  if (key === "rsPct") return r.rsPct ?? -Infinity;
  return r[key];
}

/**
 * Per-sector aggregates, so the groups can be compared rather than just listed.
 *
 * Median rather than mean: a sector with one 99th-percentile name and forty
 * middling ones has a mean that describes neither. The median says where the
 * typical name in the group sits, which is the question a sector view is
 * being asked.
 */
interface SectorStat {
  readonly sector: string;
  readonly count: number;
  readonly medianRs: number | null;
  readonly aboveMa: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarise(rows: readonly LeaderRow[]): SectorStat[] {
  const groups = new Map<string, LeaderRow[]>();
  for (const r of rows) {
    const g = groups.get(r.sector);
    if (g) g.push(r);
    else groups.set(r.sector, [r]);
  }
  return [...groups.entries()]
    .map(([sector, g]) => ({
      sector,
      count: g.length,
      medianRs: median(
        g.map((r) => r.rsPct).filter((v): v is number => v != null && Number.isFinite(v)),
      ),
      aboveMa: g.filter((r) => r.vsMa > 0).length,
    }))
    .sort((a, b) => (b.medianRs ?? -1) - (a.medianRs ?? -1));
}

export default function LeadersTable({ data }: { data: ScreenPayload }) {
  const [sectors, setSectors] = usePersistedState<string[]>(
    "leaders.sectors",
    [],
    isStringArray,
  );
  const [subsectors, setSubsectors] = usePersistedState<string[]>(
    "leaders.subsectors",
    [],
    isStringArray,
  );
  const [sort, setSort] = usePersistedState<SortKey>("leaders.sort", "rsPct", isSortKey);
  const [dir, setDir] = usePersistedState<"asc" | "desc">("leaders.dir", "desc", isDir);
  const [shown, setShown] = usePersistedState<number>("leaders.shown", PAGE, isCount);

  const all = data.leaders;
  const selected = useMemo(() => new Set(sectors), [sectors]);

  const availableSectors = useMemo(() => sectorsPresent(all), [all]);
  // Scoped to the sector selection: offering 200 subsectors when the user has
  // narrowed to Semiconductors would make the second filter unusable.
  const availableSubsectors = useMemo(
    () => subsectorsPresent(all, selected),
    [all, selected],
  );

  const rows = useMemo(() => {
    const subs = new Set(subsectors);
    const out = all.filter(
      (r) =>
        (selected.size === 0 || selected.has(r.sector)) &&
        (subs.size === 0 || subs.has(r.subsector)),
    );
    const sign = dir === "asc" ? 1 : -1;
    return out.sort((a, b) => {
      const x = value(a, sort);
      const y = value(b, sort);
      if (typeof x === "string" || typeof y === "string") {
        return String(x).localeCompare(String(y)) * sign;
      }
      return (x - y) * sign;
    });
  }, [all, selected, subsectors, sort, dir]);

  const stats = useMemo(() => summarise(all), [all]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const unclassified = all.length - data.leadersClassified;
  // With one sector selected the Sector column repeats the filter on every
  // row. Dropping it buys back the width the company names need.
  const showSector = sectors.length !== 1;

  return (
    <section className="leaders">
      <header className="leaders-head">
        <h2>Market leaders</h2>
        <p className="subtitle">
          Every liquid US name, ranked together. The percentiles are the same ones the
          theme table uses — ranking happens once, across all{" "}
          {all.length.toLocaleString()} names, before any filter. Narrowing to a sector
          shows you where that sector sits in the whole market, not a fresh ranking
          inside it.
        </p>
        {unclassified > 0 && (
          <p className="note">
            {unclassified.toLocaleString()} of {all.length.toLocaleString()} names have no
            SEC classification yet and appear under <strong>Other</strong>. Run{" "}
            <code>npm run sectors</code> to fill them in.
          </p>
        )}
      </header>

      {/* Group comparison first: the reason to have a sector view at all is to
          see how the groups rate against each other, which a filtered row list
          cannot show you. */}
      <div className="sector-stats" role="table" aria-label="Sectors ranked by median relative strength">
        <div className="ss-head" role="row">
          <span role="columnheader">Sector</span>
          <span role="columnheader">Names</span>
          <span role="columnheader">Median RS</span>
          <span role="columnheader">Above MA</span>
        </div>
        {stats.map((s) => (
          <button
            key={s.sector}
            className="ss-row"
            role="row"
            aria-pressed={selected.has(s.sector)}
            onClick={() => toggle(sectors, setSectors, s.sector)}
          >
            <span role="cell" className="ss-name">{s.sector}</span>
            <span role="cell" className="num">{s.count}</span>
            <span role="cell" className="num">
              {s.medianRs == null ? MISSING : Math.round(s.medianRs)}
            </span>
            <span role="cell" className="num">
              {s.count === 0 ? MISSING : `${Math.round((s.aboveMa / s.count) * 100)}%`}
            </span>
            <span className="ss-bar" aria-hidden="true">
              <span
                className="ss-fill"
                style={{
                  width: `${s.medianRs ?? 0}%`,
                  background:
                    (s.medianRs ?? 0) >= STRONG_CUT
                      ? "var(--cool-strong)"
                      : (s.medianRs ?? 0) >= BUY_CUT
                        ? "var(--cool-mid)"
                        : "var(--muted)",
                }}
              />
            </span>
          </button>
        ))}
      </div>

      <div className="controls">
        <span className="ctl-label">
          Sectors{sectors.length > 0 ? ` (${sectors.length})` : ""}
        </span>
        <button
          className="chip"
          aria-pressed={sectors.length === 0}
          onClick={() => {
            setSectors([]);
            // Subsectors are scoped to the sector selection, so clearing the
            // parent must clear the child or a hidden filter keeps applying.
            setSubsectors([]);
          }}
        >
          All
        </button>
        {availableSectors.map((s) => (
          <button
            key={s}
            className="chip"
            aria-pressed={selected.has(s)}
            onClick={() => {
              toggle(sectors, setSectors, s);
              setSubsectors([]);
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Only offered once a sector is chosen. Two hundred unfiltered
          subsector chips is not a control, it is a wall. */}
      {sectors.length > 0 && availableSubsectors.length > 1 && (
        <div className="controls sub">
          <span className="ctl-label">
            Subsectors{subsectors.length > 0 ? ` (${subsectors.length})` : ""}
          </span>
          <button
            className="chip"
            aria-pressed={subsectors.length === 0}
            onClick={() => setSubsectors([])}
          >
            All
          </button>
          {availableSubsectors.map((s) => (
            <button
              key={s}
              className="chip"
              aria-pressed={subsectors.includes(s)}
              onClick={() => toggle(subsectors, setSubsectors, s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="controls">
        <span className="ctl-label">Sort</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            className="chip"
            aria-pressed={sort === s.key}
            onClick={() => {
              if (sort === s.key) setDir(dir === "asc" ? "desc" : "asc");
              else {
                setSort(s.key);
                setDir(s.key === "ticker" ? "asc" : "desc");
              }
            }}
          >
            {s.label}
            {sort === s.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
          </button>
        ))}
      </div>

      <p className="result-count" aria-live="polite">
        {rows.length.toLocaleString()} of {all.length.toLocaleString()} names
        {sectors.length > 0 ? ` in ${sectors.length} sector${sectors.length > 1 ? "s" : ""}` : ""}
      </p>

      <div className="panel">
        <table className="leaders-tbl">
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              {showSector && <th scope="col">Sector</th>}
              <th scope="col" className="num">RS</th>
              <th scope="col" className="num">3M</th>
              <th scope="col" className="num">12M</th>
              <th scope="col" className="num">vs MA</th>
              <th scope="col" className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => {
              const w = railWidth(r.rsPct);
              return (
                <tr key={r.ticker} className={r.inTheme ? "in-theme" : undefined}>
                  <th scope="row">
                    <span className="lt-ticker">{r.ticker}</span>
                    {r.inTheme && (
                      <span className="theme-dot" title="In the AI CapEx theme">●</span>
                    )}
                    <span className="lt-name">{r.name}</span>
                  </th>
                  {showSector ? (
                    <td className="lt-sector">
                      <span>{r.sector}</span>
                      <span className="lt-sub">{r.subsector}</span>
                    </td>
                  ) : (
                    <td className="lt-sector only-sub">
                      <span className="lt-sub">{r.subsector}</span>
                    </td>
                  )}
                  <td className="num">
                    {num(r.rsPct)}
                    <span className="lt-rail" aria-hidden="true">
                      <span className="lt-rail-fill" style={{ width: `${w ?? 0}%` }} />
                    </span>
                  </td>
                  <td className={`num ${signClass(r.r3m)}`}>{pct(r.r3m)}</td>
                  <td className={`num ${signClass(r.r12m)}`}>{pct(r.r12m)}</td>
                  <td className={`num ${signClass(r.vsMa)}`}>{pct(r.vsMa)}</td>
                  <td className="num">{money(r.price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {rows.length === 0 && (
          <p className="empty">No names match this sector selection.</p>
        )}
        {rows.length > shown && (
          <button className="more" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more of{" "}
            {(rows.length - shown).toLocaleString()}
          </button>
        )}
      </div>
    </section>
  );
}
