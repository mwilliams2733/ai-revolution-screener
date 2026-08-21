"use client";

import { useMemo, useState } from "react";
import { STRONG_BUY_LIMIT, type PricedRow, type ScreenPayload, type VetoedRow } from "@/lib/screen-service";
import CompanyTooltip from "./company-tooltip";
import type { ScreenRow, Tier } from "@/lib/types";
import { DEFAULT_PARAMS } from "@/lib/params";
import { MISSING, money, num, pct, railWidth, signClass } from "@/lib/format";
import { usePersistedState } from "./use-persisted-state";

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

type TierFilter = "all" | "Strong Buy" | "Buy" | "Hold";

const TIER_FILTERS: TierFilter[] = ["all", "Strong Buy", "Buy", "Hold"];

type Row = PricedRow | VetoedRow | ScreenRow;

const isVetoed = (r: Row): r is VetoedRow => "excluded" in r;
const isPriced = (r: Row): r is PricedRow => "gate" in r;



function sectorLabel(s: string): string {
  return s.replace(/_/g, " ");
}

/** Cool above the MA proxy, warm below it. Intensity carries the tier. */
function toneOf(row: Row): string {
  if (isVetoed(row)) return "var(--veto)";
  if (!Number.isFinite(row.vsMa)) return "var(--muted)";
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
  const p = railWidth(row.rsPct);
  // An unmeasured percentile must not draw a zero-length bar: that reads as a
  // real bottom rank rather than as "not ranked".
  if (p == null) {
    return (
      <div className="rail rail-unknown" role="img" aria-label="Relative strength not measured">
        <span className="rail-unknown-label">not ranked</span>
      </div>
    );
  }
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
        <span className="fig-v num">{num(row.rsPct)}</span>
      </span>
      <span>
        <span className="fig-k">vs MA </span>
        <span className={`fig-v num ${signClass(row.vsMa)}`}>{pct(row.vsMa)}</span>
      </span>
      <span>
        <span className="fig-k">3M </span>
        <span className={`fig-v num ${signClass(row.r3m)}`}>{pct(row.r3m, 0)}</span>
      </span>
      <span>
        <span className="fig-k">12M </span>
        <span className={`fig-v num ${signClass(row.r12m)}`}>{pct(row.r12m, 0)}</span>
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

/**
 * Detail revealed by the row expander. (Finding U8)
 *
 * The collapsed row is already at the practical limit for a phone, so anything
 * new goes here rather than becoming another column. This is where the Phase 3
 * metric families will land.
 */
function RowDetail({ row }: { row: Row }) {
  const priced = isPriced(row) ? row : null;
  return (
    <tr className="detail-row">
      <td className="c-detail" colSpan={5}>
        <dl className="detail">
          <div>
            <dt>Sector</dt>
            <dd>{sectorLabel(row.sector)}</dd>
          </div>
          <div>
            <dt>Open / close</dt>
            <dd className="num">
              {priced?.open != null ? `${priced.open.toFixed(2)} / ${row.price.toFixed(2)}` : MISSING}
            </dd>
          </div>
          <div>
            <dt>200d average</dt>
            <dd className="num">
              {num(row.maProxy, 2)}{" "}
              <span className="detail-note">
                {priced?.maSource === "true" ? "rolling mean" : "5-point proxy"}
              </span>
            </dd>
          </div>
          <div>
            <dt>1-month</dt>
            <dd className={`num ${signClass(row.r1m)}`}>{pct(row.r1m, 0)}</dd>
          </div>
          <div>
            <dt>6-month</dt>
            <dd className={`num ${signClass(row.r6m)}`}>{pct(row.r6m, 0)}</dd>
          </div>
          <div>
            <dt>Dollar volume</dt>
            <dd className="num">{money(row.dollarVolume)}</dd>
          </div>
          {priced && (
            <div className="detail-wide">
              <dt>Fundamentals</dt>
              <dd>{priced.gateReason}</dd>
            </div>
          )}
          {isVetoed(row) && (
            <div className="detail-wide">
              <dt>Held out</dt>
              <dd>{row.excluded}</dd>
            </div>
          )}
        </dl>
      </td>
    </tr>
  );
}

function DataRow({
  row,
  expanded,
  onToggle,
}: {
  row: Row;
  expanded: boolean;
  onToggle: () => void;
}) {
  const vetoed = isVetoed(row);
  return (
    <tr className={vetoed ? "vetoed" : undefined}>
      <td className="c-name">
        <div className="ticker">
          {row.ticker}
          <button
            type="button"
            className="row-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} detail for ${row.ticker}`}
            onClick={onToggle}
          >
            {expanded ? "−" : "+"}
          </button>
        </div>
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

const isSortKey = (v: unknown): v is SortKey =>
  typeof v === "string" && SORTS.some((s) => s.key === v);
const isDir = (v: unknown): v is 1 | -1 => v === 1 || v === -1;
const isStr = (v: unknown): v is string => typeof v === "string";
const isTierFilter = (v: unknown): v is TierFilter =>
  typeof v === "string" && (TIER_FILTERS as string[]).includes(v);

export default function ScreenTable({ data }: { data: ScreenPayload }) {
  // Persisted so a reload does not discard the view. (U4)
  const [sort, setSort] = usePersistedState<SortKey>("screen.sort", "rsPct", isSortKey);
  const [dir, setDir] = usePersistedState<1 | -1>("screen.dir", -1, isDir);
  const [sector, setSector] = usePersistedState<string>("screen.sector", "all", isStr);
  const [tierFilter, setTierFilter] = usePersistedState<TierFilter>(
    "screen.tier",
    "all",
    isTierFilter,
  );
  const [showVetoed, setShowVetoed] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggleRow = (ticker: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });

  const sectors = useMemo(
    () => [...new Set(data.themed.map((r) => r.sector))].sort(),
    [data.themed],
  );

  function onSort(k: SortKey) {
    if (k === sort) setDir(dir === 1 ? -1 : 1);
    else {
      setSort(k);
      setDir(k === "ticker" ? 1 : -1);
    }
  }

  const rows = useMemo(() => {
    const base = data.themed
      .filter((r) => sector === "all" || r.sector === sector)
      .filter((r) => tierFilter === "all" || r.tier === tierFilter);
    const cmp = (a: Row, b: Row) => {
      if (sort === "ticker") return a.ticker.localeCompare(b.ticker) * dir;
      const av = (a[sort] as number | null) ?? -Infinity;
      const bv = (b[sort] as number | null) ?? -Infinity;
      return (av - bv) * dir;
    };
    return [...base].sort(cmp);
  }, [data.themed, sector, tierFilter, sort, dir]);

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

        <span className="ctl-label">Tier</span>
        {TIER_FILTERS.map((t) => (
          <button
            key={t}
            className="chip"
            aria-pressed={tierFilter === t}
            onClick={() => setTierFilter(t)}
          >
            {t === "all" ? "All tiers" : t}
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
            {rows.flatMap((r) => {
              const open = expanded.has(r.ticker);
              return open
                ? [
                    <DataRow key={r.ticker} row={r} expanded onToggle={() => toggleRow(r.ticker)} />,
                    <RowDetail key={`${r.ticker}-detail`} row={r} />,
                  ]
                : [
                    <DataRow
                      key={r.ticker}
                      row={r}
                      expanded={false}
                      onToggle={() => toggleRow(r.ticker)}
                    />,
                  ];
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="empty">
            {tierFilter === "all"
              ? "No names in this sector cleared the liquidity gate today."
              : `No ${tierFilter} names${sector === "all" ? "" : " in this sector"} today.`}
          </p>
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
                <caption className="sr-only">
                  Theme names withheld by the crowding veto, ranked with everything else
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">RS rank</th>
                    <th scope="col">Figures</th>
                  </tr>
                </thead>
                <tbody>
                  {vetoed.flatMap((r) => {
                    const open = expanded.has(r.ticker);
                    return open
                      ? [
                          <DataRow
                            key={r.ticker}
                            row={r}
                            expanded
                            onToggle={() => toggleRow(r.ticker)}
                          />,
                          <RowDetail key={`${r.ticker}-detail`} row={r} />,
                        ]
                      : [
                          <DataRow
                            key={r.ticker}
                            row={r}
                            expanded={false}
                            onToggle={() => toggleRow(r.ticker)}
                          />,
                        ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
