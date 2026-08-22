"use client";

import { useMemo, useState } from "react";
import { CAP_MARGIN } from "@/lib/strong-buy-cap";
import { STRONG_BUY_LIMIT, type PricedRow, type ScreenPayload, type VetoedRow } from "@/lib/screen-service";
import CompanyTooltip from "./company-tooltip";
import type { ScreenRow, Tier } from "@/lib/types";
import { DEFAULT_PARAMS } from "@/lib/params";
import { MISSING, money, num, pct, railWidth, signClass } from "@/lib/format";
import { usePersistedState } from "./use-persisted-state";
import { TREND_MIN_HISTORY } from "@/lib/trend-template";

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

/** Plain-language names for the eight trend criteria. */
const CRITERION_LABELS: Record<string, string> = {
  priceAboveLongMas: "Above 150d and 200d",
  ma150AboveMa200: "150d above 200d",
  ma200Rising: "200d rising for a month",
  ma50AboveLongMas: "50d above both",
  priceAboveMa50: "Above 50d",
  above30PctOfLow: "30% above 52w low",
  within25PctOfHigh: "Within 25% of 52w high",
  rsAtLeast70: "RS at least 70",
};

type Row = PricedRow | VetoedRow | ScreenRow;

const isVetoed = (r: Row): r is VetoedRow => "excluded" in r;
const isPriced = (r: Row): r is PricedRow => "gate" in r;



/**
 * Runway in the largest unit that still says something.
 *
 * AXTI barely burns, so the arithmetic gives 869 months. Seventy-two years is
 * accurate and useless: a figure that looks like a bug makes the reader
 * distrust the figures that are not. Above ten years the exact number carries
 * no information the reader can act on, so it stops being quoted.
 */
function runwayLabel(months: number): string {
  if (months < 24) return `${Math.round(months)} months`;
  if (months >= 120) return "10+ years";
  return `${(months / 12).toFixed(1)} years`;
}

/** Market cap in the unit a reader thinks in: $4.6B, not $4639M. */
function bigMoney(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  return `$${(v / 1e6).toFixed(0)}M`;
}

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
      {isPriced(row) && (
        <>
          <span>
            <span className="fig-k">Open </span>
            <span className="fig-v num">{num(row.open, 2)}</span>
          </span>
          <span>
            <span className="fig-k">Close </span>
            <span className="fig-v num">{num(row.price, 2)}</span>
          </span>
          <span>
            <span className="fig-k">Day </span>
            <span className={`fig-v num ${signClass(row.changes.day)}`}>
              {pct(row.changes.day)}
            </span>
          </span>
          <span>
            <span className="fig-k">Wk </span>
            <span className={`fig-v num ${signClass(row.changes.week)}`}>
              {pct(row.changes.week, 0)}
            </span>
          </span>
          <span>
            <span className="fig-k">Mo </span>
            <span className={`fig-v num ${signClass(row.changes.month)}`}>
              {pct(row.changes.month, 0)}
            </span>
          </span>
        </>
      )}
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
      {isPriced(row) && row.trend && (
        <span>
          <span className="fig-k">TT </span>
          <span
            className={`fig-v num tt-count tt-${row.trend.count >= 7 ? "hi" : row.trend.count >= 5 ? "mid" : "lo"}`}
            title={Object.entries(row.trend.flags)
              .map(([k, v]) => `${v ? "PASS" : "fail"} ${k}`)
              .join(" · ")}
          >
            {row.trend.count}/8
          </span>
        </span>
      )}
      {isPriced(row) && row.stage && (
        <span>
          <span className="fig-k">Stage </span>
          <span className={`fig-v stage stage-${row.stage.stage}`} title={row.stage.label}>
            {row.stage.stage === "Transitional" ? "T" : row.stage.stage}
          </span>
        </span>
      )}
      {isPriced(row) && row.accumulation && (
        <span>
          <span className="fig-k">Acc </span>
          <span className={`fig-v grade grade-${row.accumulation}`} title={`Accumulation ${row.accumulation}`}>
            {row.accumulation}
          </span>
        </span>
      )}
      {isPriced(row) && row.volume.udRatio != null && (
        <span>
          <span className="fig-k">U/D </span>
          <span className={`fig-v num ${row.volume.udRatio >= 1 ? "pos" : "neg"}`}>
            {row.volume.udRatio.toFixed(1)}
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
          {priced?.health && (
            <>
              <div>
                <dt>Share count</dt>
                <dd className="num">
                  {priced.health.dilution == null ? (
                    MISSING
                  ) : (
                    <>
                      <span className={priced.health.dilution.growth > 0 ? "neg" : "pos"}>
                        {pct(priced.health.dilution.growth * 100)}
                      </span>
                      <span className="detail-note"> in a year, split-adjusted</span>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Cash runway</dt>
                <dd className="num">
                  {priced.health.runway == null ? (
                    <span className="detail-note">funds itself</span>
                  ) : (
                    <>
                      {runwayLabel(priced.health.runway)}
                      <span className="detail-note"> at the current burn</span>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Market cap</dt>
                <dd className="num">
                  {priced.health.marketCap == null ? MISSING : bigMoney(priced.health.marketCap)}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Close vs open</dt>
            <dd className={`num ${signClass(priced?.changes.intraday ?? null)}`}>
              {pct(priced?.changes.intraday ?? null)}
              <span className="detail-note"> intraday</span>
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
          <div className="detail-wide">
            <dt>Trend template</dt>
            <dd>
              {priced?.trend == null ? (
                <span className="detail-note">
                  Needs {TREND_MIN_HISTORY} sessions of history — not yet stored
                </span>
              ) : (
                <ul className="criteria">
                  {Object.entries(priced.trend.flags).map(([k, v]) => (
                    <li key={k} className={v ? "pass" : "fail"}>
                      <span aria-hidden="true">{v ? "✓" : "✗"}</span> {CRITERION_LABELS[k] ?? k}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>
              {priced?.stage
                ? `${priced.stage.stage} — ${priced.stage.label} (150d slope ${(priced.stage.slope150 * 100).toFixed(1)}%)`
                : MISSING}
            </dd>
          </div>
          <div>
            <dt>Up/down volume</dt>
            <dd className="num">
              {priced?.volume.udRatio != null ? priced.volume.udRatio.toFixed(2) : MISSING}
              {priced?.accumulationPct != null && (
                <span className="detail-note"> · {Math.round(priced.accumulationPct)}th pct</span>
              )}
            </dd>
          </div>
          <div>
            <dt>OBV slope</dt>
            <dd className={`num ${signClass(priced?.volume.obvSlope ?? null)}`}>
              {priced?.volume.obvSlope != null ? priced.volume.obvSlope.toFixed(3) : MISSING}
            </dd>
          </div>
          <div>
            <dt>Relative volume</dt>
            <dd className="num">
              {priced?.volume.rvol != null ? `${priced.volume.rvol.toFixed(2)}x` : MISSING}
              {priced?.volume.rvol != null && priced.volume.rvol > 2 && (
                <span className="detail-note"> · elevated</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Volume confirms</dt>
            <dd>
              {priced?.volume.udRatio == null
                ? MISSING
                : priced.confirmed
                  ? "Yes"
                  : "No — rising on weak volume"}
            </dd>
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
            why it is not a Strong Buy rather than silently reshuffling it.
            Conditioned on the gate's OWN verdict, not on the tier having
            moved. Inferring it from "momentum Strong Buy but not Strong Buy
            now" was true whenever ANY overlay demoted the row, so AXTI --
            capped at Hold by the balance-sheet guardrails -- claimed the gate
            had held it at Buy and quoted the gate's PASSING reason as the
            explanation. Three overlays can demote a Strong Buy; each must
            speak only for itself. */}
        {isPriced(row) && row.gate === "demote" && (
          <div className="gate-note">
            <span className="gate-dot" aria-hidden="true" />
            <span>
              Momentum Strong Buy, held at {row.tier ?? MISSING} — {row.gateReason}
            </span>
          </div>
        )}
        {/* A late-stage chart caps the tier regardless of momentum rank. */}
        {isPriced(row) && row.stageCapped && (
          <div className="gate-note">
            <span className="gate-dot" aria-hidden="true" />
            <span>Held down — {row.stageReason}</span>
          </div>
        )}
        {/* Capped names met every rule; only rank position kept them out. The
            second line fires when the incumbency margin, not raw rank, decided
            it -- otherwise a name would appear to lose on rank while sitting
            visibly above the name that kept the slot. */}
        {isPriced(row) && row.capped && (
          <div className="gate-note cap">
            <span className="gate-dot" aria-hidden="true" />
            <span>
              Meets every Strong Buy rule, outside the top {STRONG_BUY_LIMIT} by rank
              {row.capHeld && ` — within ${CAP_MARGIN} points of the last slot, held by the incumbent`}
            </span>
          </div>
        )}
        {/* A balance-sheet failure is a different statement from a rank or a
            trend: it questions whether the equity survives. Capped at Hold and
            never hidden -- the reason stays on the row. */}
        {isPriced(row) && row.healthCapped && (
          <div className="gate-note health">
            <span className="gate-dot" aria-hidden="true" />
            <span>Capped at Hold — {row.healthReason}</span>
          </div>
        )}
        {isPriced(row) && row.capHeld && !row.capped && (
          <div className="gate-note cap">
            <span className="gate-dot" aria-hidden="true" />
            <span>Kept the last Strong Buy slot on incumbency, within {CAP_MARGIN} points</span>
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
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isTierFilter = (v: unknown): v is TierFilter =>
  typeof v === "string" && (TIER_FILTERS as string[]).includes(v);

export default function ScreenTable({ data }: { data: ScreenPayload }) {
  // Persisted so a reload does not discard the view. (U4)
  const [sort, setSort] = usePersistedState<SortKey>("screen.sort", "rsPct", isSortKey);
  const [dir, setDir] = usePersistedState<1 | -1>("screen.dir", -1, isDir);
  // Empty array means every sector. Persisted as an array so a reload keeps
  // the exact selection rather than collapsing to "all".
  const [sectors, setSectors] = usePersistedState<string[]>(
    "screen.sectors",
    [],
    isStringArray,
  );
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

  const allSectors = useMemo(
    () => [...new Set(data.themed.map((r) => r.sector))].sort(),
    [data.themed],
  );

  const toggleSector = (s: string) =>
    setSectors(sectors.includes(s) ? sectors.filter((x) => x !== s) : [...sectors, s]);

  function onSort(k: SortKey) {
    if (k === sort) setDir(dir === 1 ? -1 : 1);
    else {
      setSort(k);
      setDir(k === "ticker" ? 1 : -1);
    }
  }

  const rows = useMemo(() => {
    const base = data.themed
      .filter((r) => sectors.length === 0 || sectors.includes(r.sector))
      .filter((r) => tierFilter === "all" || r.tier === tierFilter);
    const cmp = (a: Row, b: Row) => {
      if (sort === "ticker") return a.ticker.localeCompare(b.ticker) * dir;
      const av = (a[sort] as number | null) ?? -Infinity;
      const bv = (b[sort] as number | null) ?? -Infinity;
      return (av - bv) * dir;
    };
    return [...base].sort(cmp);
  }, [data.themed, sectors, tierFilter, sort, dir]);

  const vetoed = useMemo(
    () => data.vetoed.filter((r) => sectors.length === 0 || sectors.includes(r.sector)),
    [data.vetoed, sectors],
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

      </div>

      <div className="controls">
        <span className="ctl-label">
          Sectors{sectors.length > 0 ? ` (${sectors.length})` : ""}
        </span>
        <button
          className="chip"
          aria-pressed={sectors.length === 0}
          onClick={() => setSectors([])}
        >
          All
        </button>
        {allSectors.map((s) => (
          <button
            key={s}
            className="chip"
            aria-pressed={sectors.includes(s)}
            onClick={() => toggleSector(s)}
          >
            {sectorLabel(s)}
          </button>
        ))}
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
              : `No ${tierFilter} names${sectors.length === 0 ? "" : " in the selected sectors"} today.`}
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
