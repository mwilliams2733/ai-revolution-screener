"use client";

import { useMemo } from "react";
import {
  filterAndGroup,
  summariseGroups,
  type KindFilter,
  type TierFilter,
} from "@/lib/groups";
import { DEFAULT_PARAMS } from "@/lib/params";
import { MISSING, num, pct, railWidth, signClass } from "@/lib/format";
import { usePersistedState } from "./use-persisted-state";
import type { MarketRow } from "@/lib/market-rows";
import type { ScreenPayload } from "@/lib/screen-service";

/**
 * Every ranked name, grouped: AI themes, AI spenders, then SIC sectors.
 *
 * Same ranking as the AI book above -- percentiles are computed once across the
 * whole liquid universe -- and the same ruleset, with one difference: no
 * Strong Buy cap. Every name that clears every rule shows as Strong Buy here.
 * The cap is a property of the book, and a capped book name says so.
 */

const PREVIEW = 25;
const STRONG_CUT = DEFAULT_PARAMS.strongRs;
const BUY_CUT = DEFAULT_PARAMS.buyRs;

const KINDS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All groups" },
  { key: "ai", label: "AI themes" },
  { key: "sector", label: "Sectors" },
];
const TIER_FILTERS: TierFilter[] = ["all", "Strong Buy", "Buy", "Hold"];

const isKind = (v: unknown): v is KindFilter => v === "all" || v === "ai" || v === "sector";
const isTier = (v: unknown): v is TierFilter =>
  typeof v === "string" && (TIER_FILTERS as string[]).includes(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const slug = (s: string) => `g-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function tierClass(r: MarketRow): string {
  if (r.vsMa < 0) return "t-below";
  if (r.tier === "Strong Buy") return "t-strong";
  if (r.tier === "Buy") return "t-buy";
  return "t-hold";
}

function stageLabel(s: MarketRow["stage"]): string {
  if (s == null) return MISSING;
  return s === "Transitional" ? "T" : String(s);
}

function notes(r: MarketRow): string[] {
  const out = [...r.heldDown];
  if (r.bookCapped) out.push("Buy in the AI book — outside its top 10");
  if (r.tier === "Strong Buy" && r.gate === "unverified") out.push("Fundamentals unverified");
  return out;
}

function toggle(list: string[], set: (v: string[]) => void, v: string) {
  set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
}

export default function MarketGroups({ data }: { data: ScreenPayload }) {
  const [kind, setKind] = usePersistedState<KindFilter>("groups.kind", "all", isKind);
  const [tier, setTier] = usePersistedState<TierFilter>("groups.tier", "all", isTier);
  const [query, setQuery] = usePersistedState<string>("groups.query", "", isString);
  const [expanded, setExpanded] = usePersistedState<string[]>("groups.expanded", [], isStringArray);
  const [collapsed, setCollapsed] = usePersistedState<string[]>("groups.collapsed", [], isStringArray);

  const all = data.market;
  // Group order comes from the unfiltered rows, so filtering never reshuffles groups.
  const stats = useMemo(() => summariseGroups(all), [all]);
  const groups = useMemo(
    () => filterAndGroup(all, { kind, tier, query }, stats),
    [all, kind, tier, query, stats],
  );
  const shownRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const unclassified = all.length - data.marketClassified;
  const unverified = data.meta.fundamentalsUnverified;

  return (
    <section className="leaders">
      <header className="leaders-head">
        <h2>Whole market by group</h2>
        <p className="subtitle">
          All {all.length.toLocaleString()} liquid US names under the same rules as the AI
          book, grouped by AI theme and then by industry sector. RS is the same
          market-wide percentile everywhere. There is no Strong Buy limit here: every name
          that clears every rule is a Strong Buy.
        </p>
        {unverified > 0 && (
          <p className="note">
            {unverified.toLocaleString()} Strong Buy candidates could not be checked against
            fundamentals, so they keep their momentum tier. Most file no usable quarterly
            data with the SEC (often foreign issuers) or have too little history; a name
            not fetched yet is picked up by the nightly refresh.
          </p>
        )}
        {unclassified > 0 && (
          <p className="note">
            {unclassified.toLocaleString()} names have no SEC classification and sit under{" "}
            <strong>Unclassified</strong> or <strong>Other</strong>. Run{" "}
            <code>npm run sectors</code> to fill them in.
          </p>
        )}
      </header>

      <div className="sector-stats" role="table" aria-label="Groups ranked by median relative strength">
        <div className="ss-head mg-stats" role="row">
          <span role="columnheader">Group</span>
          <span role="columnheader">Names</span>
          <span role="columnheader">Median RS</span>
          <span role="columnheader">SB / B / H</span>
        </div>
        {stats.map((s) => (
          <a key={s.name} className="ss-row mg-stats" role="row" href={`#${slug(s.name)}`}>
            <span role="cell" className="ss-name">
              {s.name}
              {s.kind !== "sector" && <span className="mg-kind">AI</span>}
            </span>
            <span role="cell" className="num">{s.count}</span>
            <span role="cell" className="num">
              {s.medianRs == null ? MISSING : Math.round(s.medianRs)}
            </span>
            <span role="cell" className="num">
              {s.strongBuy} / {s.buy} / {s.hold}
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
          </a>
        ))}
      </div>

      <div className="controls">
        <span className="ctl-label">Show</span>
        {KINDS.map((k) => (
          <button key={k.key} className="chip" aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="controls">
        <span className="ctl-label">Tier</span>
        {TIER_FILTERS.map((t) => (
          <button key={t} className="chip" aria-pressed={tier === t} onClick={() => setTier(t)}>
            {t === "all" ? "All" : t}
          </button>
        ))}
        <input
          className="mg-search"
          type="search"
          placeholder="Ticker or name"
          aria-label="Search by ticker or company name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <p className="result-count" aria-live="polite">
        {shownRows.toLocaleString()} of {all.length.toLocaleString()} names in {groups.length} groups
      </p>

      {groups.length === 0 && <p className="empty">No names match these filters.</p>}

      {groups.map(({ stat, rows }) => {
        const isCollapsed = collapsed.includes(stat.name);
        const isExpanded = expanded.includes(stat.name);
        const visible = isExpanded ? rows : rows.slice(0, PREVIEW);
        return (
          <section key={stat.name} id={slug(stat.name)} className="mg-group">
            <h3>
              <button
                className="mg-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(collapsed, setCollapsed, stat.name)}
              >
                <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span> {stat.name}
                <span className="mg-count">
                  {rows.length} · median RS {stat.medianRs == null ? MISSING : Math.round(stat.medianRs)}
                </span>
              </button>
            </h3>
            {!isCollapsed && (
              <div className="panel">
                <table className="leaders-tbl">
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col">Tier</th>
                      <th scope="col" className="num">RS</th>
                      <th scope="col" className="num">3M</th>
                      <th scope="col" className="num">12M</th>
                      <th scope="col" className="num">vs MA</th>
                      <th scope="col" className="num">Stage</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const w = railWidth(r.rsPct);
                      const n = notes(r);
                      return (
                        <tr key={r.ticker} className={r.inBook ? "in-theme" : undefined}>
                          <th scope="row">
                            <span className="lt-ticker">{r.ticker}</span>
                            {r.inBook && <span className="theme-dot" title="In the AI book">●</span>}
                            <span className="lt-name">{r.name}</span>
                            {r.badge && <span className="mg-badge">{r.badge}</span>}
                          </th>
                          <td>
                            <span className={`badge-name ${tierClass(r)}`}>{r.tier ?? MISSING}</span>
                          </td>
                          <td className="num">
                            {num(r.rsPct)}
                            <span className="lt-rail" aria-hidden="true">
                              <span className="lt-rail-fill" style={{ width: `${w ?? 0}%` }} />
                            </span>
                          </td>
                          <td className={`num ${signClass(r.r3m)}`}>{pct(r.r3m)}</td>
                          <td className={`num ${signClass(r.r12m)}`}>{pct(r.r12m)}</td>
                          <td className={`num ${signClass(r.vsMa)}`}>{pct(r.vsMa)}</td>
                          <td className="num">{stageLabel(r.stage)}</td>
                          <td className="mg-notes">{n.length ? n.join(" · ") : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length > PREVIEW && (
                  <button className="more" onClick={() => toggle(expanded, setExpanded, stat.name)}>
                    {isExpanded ? `Show top ${PREVIEW}` : `Show all ${rows.length}`}
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
