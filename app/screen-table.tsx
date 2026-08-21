"use client";

import { useMemo, useState } from "react";
import { STRONG_BUY_LIMIT, type PricedRow, type ScreenPayload, type VetoedRow } from "@/lib/screen-service";
import CompanyTooltip from "./company-tooltip";
import type { ScreenRow, Tier } from "@/lib/types";
import { DEFAULT_PARAMS } from "@/lib/params";

/** Tier cutoffs drawn on every rail. These are the real decision boundaries. */
const BUY_CUT = DEFAULT_PARAMS.buyRs;
const STRONG_CUT = DEFAULT_PARAMS.strongRs;

type SortKey = "rsPct" | "ticker" | "vsMa" | "r3m" | "r12m" | "dollarVolume";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "rsPct", label: "RS rank" },
  { key: "vsMa", label: "vs MA" },
  { key: "r3m", label: "3-month" },
  { key: "r12m", label: "12-month" },
  { key: "dollarVolume", label: "Liquidity" },
  { key: "ticker", label: "Ticker" },
];

type Row = PricedRow | VetoedRow | ScreenRow;

const isVetoed = (r: Row): r is VetoedRow => "excluded" in r;
const isPriced = (r: Row): r is PricedRow => "gate" in r;

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "--";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function sectorLabel(s: string): string {
  return s.replace(/_/g, " ");
}

/** Cool above the MA proxy, warm below it. Intensity carries the tier. */
function toneOf(row: Row): string {
  if (isVetoed(row)) return "var(--veto)";
  if (row.vsMa < 0) return "var(--warm)";
  if (row.tier === "Strong Buy") return "var(--cool-strong)";
  if (row.tier === "Buy") return "var(--cool-mid)";
  return "var(--muted)";
}

function badgeClass(row: Row): string {
  if (row.vsMa < 0) return "t-below";
  const t: Tier | null = row.tier;
  if (t === "Strong Buy") return "t-strong";
  if (t === "Buy") return "t-buy";
  return "t-hold";
}

function Rail({ row }: { row: Row }) {
  const p = Math.max(0, Math.min(100, row.rsPct ?? 0));
  return (
    <>
      <div
        className="rail"
        role="img"
        aria-label={`Relative strength percentile ${Math.round(p)} of 100`}
      >
        <div className="rail-fill" style={{ width: `${p}%`, background: toneOf(row) }} />
        <div className="rail-tick" style={{ left: `${BUY_CUT}%` }} />
        <div className="rail-tick" style={{ left: `${STRONG_CUT}%` }} />
      </div>
      <div className="rail-legend" aria-hidden="true">
        <span>0</span>
        <span>{BUY_CUT} buy</span>
        <span>{STRONG_CUT} strong</span>
        <span>100</span>
      </div>
    </>
  );
}

function Figures({ row }: { row: Row }) {
  return (
    <div className="figs">
      <span>
        <span className="fig-k">RS </span>
        <span className="fig-v num">{Math.round(row.rsPct ?? 0)}</span>
      </span>
      <span>
        <span className="fig-k">vs MA </span>
        <span className={`fig-v num ${row.vsMa >= 0 ? "pos" : "neg"}`}>{pct(row.vsMa)}</span>
      </span>
      <span>
        <span className="fig-k">3M </span>
        <span className={`fig-v num ${row.r3m >= 0 ? "pos" : "neg"}`}>{pct(row.r3m, 0)}</span>
      </span>
      <span>
        <span className="fig-k">12M </span>
        <span className={`fig-v num ${row.r12m >= 0 ? "pos" : "neg"}`}>{pct(row.r12m, 0)}</span>
      </span>
      <span>
        <span className="fig-k">Vol </span>
        <span className="fig-v num">{money(row.dollarVolume)}</span>
      </span>
      {isPriced(row) && row.open != null && (
        <span>
          <span className="fig-k">O/C </span>
          <span className="fig-v num">
            {row.open.toFixed(2)}
            {" / "}
            <span className={row.price >= row.open ? "pos" : "neg"}>{row.price.toFixed(2)}</span>
          </span>
        </span>
      )}
    </div>
  );
}

function DataRow({ row }: { row: Row }) {
  const vetoed = isVetoed(row);
  return (
    <tr className={vetoed ? "vetoed" : undefined}>
      <td className="c-name">
        <div className="ticker">{row.ticker}</div>
        <div className="coname">
          <CompanyTooltip ticker={row.ticker} name={row.name || sectorLabel(row.sector)} />
        </div>
        <div className="sector">{sectorLabel(row.sector)}</div>
      </td>

      <td className="c-tier">
        <span className="badge">
          <span className={`badge-name ${badgeClass(row)}`}>
            {vetoed ? "Held out" : row.tier ?? "--"}
          </span>
          {!vetoed && row.weight > 0 && (
            <span className="badge-w num">{(row.weight * 100).toFixed(2)}%</span>
          )}
        </span>
      </td>

      <td className="c-rail">
        <Rail row={row} />
      </td>

      <td className="c-figs">
        <Figures row={row} />
        {vetoed && (
          <div className="veto-note">
            <span className="veto-dot" aria-hidden="true" />
            <span>{row.excluded}</span>
          </div>
        )}
        {/* A demoted name keeps its momentum rank on screen; the gate explains
            why it is not a Strong Buy rather than silently reshuffling it. */}
        {isPriced(row) && row.momentumTier === "Strong Buy" && row.tier !== "Strong Buy" && (
          <div className="gate-note">
            <span className="gate-dot" aria-hidden="true" />
            <span>Momentum Strong Buy, held at Buy — {row.gateReason}</span>
          </div>
        )}
        {/* Capped names met every rule; only rank position kept them out. */}
        {isPriced(row) && row.capped && (
          <div className="gate-note cap">
            <span className="gate-dot" aria-hidden="true" />
            <span>Meets every Strong Buy rule, outside the top {STRONG_BUY_LIMIT} by rank</span>
          </div>
        )}
        {isPriced(row) && row.gate === "unverified" && row.tier === "Strong Buy" && (
          <div className="gate-note unver">
            <span className="gate-dot" aria-hidden="true" />
            <span>Fundamentals unverified — {row.gateReason}</span>
          </div>
        )}
      </td>
    </tr>
  );
}

function Header({
  sort,
  dir,
  onSort,
}: {
  sort: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
}) {
  const arrow = (k: SortKey) => (sort === k ? (dir === -1 ? " ↓" : " ↑") : "");
  return (
    <thead>
      <tr>
        <th scope="col">
          <button className="th-btn" data-active={sort === "ticker"} onClick={() => onSort("ticker")}>
            Name{arrow("ticker")}
          </button>
        </th>
        <th scope="col">Tier</th>
        <th scope="col">
          <button className="th-btn" data-active={sort === "rsPct"} onClick={() => onSort("rsPct")}>
            RS rank{arrow("rsPct")}
          </button>
        </th>
        <th scope="col">
          <button className="th-btn" data-active={sort === "vsMa"} onClick={() => onSort("vsMa")}>
            Figures{arrow("vsMa")}
          </button>
        </th>
      </tr>
    </thead>
  );
}

export default function ScreenTable({ data }: { data: ScreenPayload }) {
  const [sort, setSort] = useState<SortKey>("rsPct");
  const [dir, setDir] = useState<1 | -1>(-1);
  const [sector, setSector] = useState<string>("all");
  const [showVetoed, setShowVetoed] = useState(true);

  const sectors = useMemo(
    () => [...new Set(data.themed.map((r) => r.sector))].sort(),
    [data.themed],
  );

  function onSort(k: SortKey) {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(k === "ticker" ? 1 : -1);
    }
  }

  const rows = useMemo(() => {
    const base = data.themed.filter((r) => sector === "all" || r.sector === sector);
    const cmp = (a: Row, b: Row) => {
      if (sort === "ticker") return a.ticker.localeCompare(b.ticker) * dir;
      const av = (a[sort] as number | null) ?? -Infinity;
      const bv = (b[sort] as number | null) ?? -Infinity;
      return (av - bv) * dir;
    };
    return [...base].sort(cmp);
  }, [data.themed, sector, sort, dir]);

  const vetoed = useMemo(
    () => data.vetoed.filter((r) => sector === "all" || r.sector === sector),
    [data.vetoed, sector],
  );

  return (
    <>
      <div className="controls">
        <span className="ctl-label">Sort</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            className="chip"
            aria-pressed={sort === s.key}
            onClick={() => onSort(s.key)}
          >
            {s.label}
            {sort === s.key ? (dir === -1 ? " ↓" : " ↑") : ""}
          </button>
        ))}

        <select
          className="chip"
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          aria-label="Filter by sector"
        >
          <option value="all">All sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>
              {sectorLabel(s)}
            </option>
          ))}
        </select>
      </div>

      <div className="panel">
        <table>
          <caption className="sr-only" style={{ position: "absolute", left: "-9999px" }}>
            Theme names ranked by relative strength against the full liquid universe
          </caption>
          <Header sort={sort} dir={dir} onSort={onSort} />
          <tbody>
            {rows.map((r) => (
              <DataRow key={r.ticker} row={r} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">No names in this sector cleared the liquidity gate today.</p>
        )}
      </div>

      {vetoed.length > 0 && (
        <>
          <div className="sec-head">
            <h2 className="sec-title">Held out</h2>
            <span className="sec-note">
              Ranked with everything else, then withheld by the crowding veto. Shown so the
              omission stays visible.
            </span>
            <button
              className="chip"
              aria-pressed={showVetoed}
              onClick={() => setShowVetoed((v) => !v)}
            >
              {showVetoed ? "Hide" : `Show ${vetoed.length}`}
            </button>
          </div>

          {showVetoed && (
            <div className="panel">
              <table>
                <tbody>
                  {vetoed.map((r) => (
                    <DataRow key={r.ticker} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
