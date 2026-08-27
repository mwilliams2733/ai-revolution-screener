import { getScreen } from "@/lib/screen-service";
import { DEFAULT_PARAMS } from "@/lib/params";
import ScreenTable from "./screen-table";
import TickerLookup from "./ticker-lookup";
import LeadersTable from "./leaders-table";
import { buildRefreshStamp } from "@/lib/refresh-stamp";

// Delayed end-of-day bars: revalidate hourly rather than on every request.
export const revalidate = 3600;

function Distribution({ marks }: { marks: number[] }) {
  return (
    <div className="dist" role="img" aria-label={`Distribution of ${marks.length} theme names across the ranked universe`}>
      <div className="dist-tick" style={{ left: `${DEFAULT_PARAMS.buyRs}%` }} />
      <div className="dist-tick" style={{ left: `${DEFAULT_PARAMS.strongRs}%` }} />
      <span className="dist-label" style={{ left: `${DEFAULT_PARAMS.buyRs}%` }}>
        {DEFAULT_PARAMS.buyRs}
      </span>
      <span className="dist-label" style={{ left: `${DEFAULT_PARAMS.strongRs}%` }}>
        {DEFAULT_PARAMS.strongRs}
      </span>
      {marks.map((p, i) => (
        <span
          key={i}
          className="dist-mark"
          style={{
            left: `${Math.max(0, Math.min(99.7, p))}%`,
            background:
              p >= DEFAULT_PARAMS.strongRs
                ? "var(--cool-strong)"
                : p >= DEFAULT_PARAMS.buyRs
                  ? "var(--cool-mid)"
                  : "var(--muted)",
          }}
        />
      ))}
    </div>
  );
}

export default async function Page() {
  let data: Awaited<ReturnType<typeof getScreen>>;

  try {
    data = await getScreen();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown failure";
    return (
      <main className="wrap">
        <div className="err">
          <h2>The screen could not run</h2>
          <p>{msg}</p>
          <p>
            Prices come from the grouped daily endpoint. Check that{" "}
            <code>POLYGON_API_KEY</code> is set in <code>.env.local</code>, then reload.
          </p>
        </div>
      </main>
    );
  }

  // Unranked names are omitted from the strip rather than stacked at zero,
  // which would invent a cluster of worst-in-market names that do not exist.
  const marks = data.themed
    .map((r) => r.rsPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const strong = data.themed.filter((r) => r.tier === "Strong Buy").length;
  const cached = Object.values(data.anchors).filter((a) => a.source === "db").length;

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="title">AI Revolution Screener</h1>

        {/* Silence when current; loud only when the refresh has actually
            stopped. A screener showing week-old prices that looks identical to
            a fresh one is the dangerous case. */}
        {data.staleness.freshness !== "current" && (
          <p
            className={`stale-banner ${data.staleness.freshness}`}
            role={data.staleness.freshness === "very-stale" ? "alert" : undefined}
          >
            <strong>{data.staleness.label}.</strong> Showing the close from {data.asOf}.
          </p>
        )}
        <p className="subtitle">
          Relative strength ranked across every liquid US name, then filtered to the AI
          CapEx-taker theme. Ranking happens before the filter, which is what keeps the tier
          cutoffs meaningful.
        </p>

        <div className="stats">
          <span>
            <span className="stat-k">Session</span>
            <span className="stat-v num" title={data.staleness.label}>
              {data.asOf}
            </span>
          </span>
          {/* Sits beside Session on purpose: Session says WHICH data, this says
              whether the pipeline that fetches it is still running. Omitted
              entirely when the run log is empty -- "never" would be alarming on
              a fresh database where it is simply not known yet.

              Rendered on the server at DAY granularity so the hourly page cache
              cannot make it wrong; see lib/refresh-stamp.ts. */}
          {data.lastRefresh &&
            (() => {
              const stamp = buildRefreshStamp(data.lastRefresh, new Date());
              return (
                <span>
                  <span className="stat-k">Last checked</span>
                  <span
                    className={`stat-v${stamp.state === "ok" ? "" : ` refresh-${stamp.state}`}`}
                    title={stamp.detail}
                  >
                    {stamp.label}
                    {stamp.state !== "ok" && (
                      <span className="refresh-flag"> {stamp.state}</span>
                    )}
                  </span>
                </span>
              );
            })()}
          <span>
            <span className="stat-k">Ranked universe</span>
            <span className="stat-v num">{data.universeSize.toLocaleString()}</span>
          </span>
          <span>
            <span className="stat-k">In theme</span>
            <span className="stat-v num">{data.themed.length}</span>
          </span>
          <span>
            <span className="stat-k">Strong buy</span>
            <span className="stat-v num">{strong}</span>
          </span>
          <span>
            <span className="stat-k">Held out</span>
            <span className="stat-v num">{data.vetoed.length}</span>
          </span>
          <span>
            <span className="stat-k">Stage capped</span>
            <span className="stat-v num">{data.stageDemoted}</span>
          </span>
          <span>
            <span className="stat-k">Gate demoted</span>
            <span className="stat-v num">{data.demoted}</span>
          </span>
          <span>
            <span className="stat-k">Capped out</span>
            <span className="stat-v num">{data.capped}</span>
          </span>
          <span>
            <span className="stat-k">Balance sheet</span>
            <span className="stat-v num">{data.healthCapped}</span>
          </span>
        </div>

        <Distribution marks={marks} />

        {/* Portfolio-level risk. The gap between the two effective-bet figures
            is the cost of theme concentration, and the board meeting concedes
            the whole book drew down together. */}
        <div className="risk">
          <span>
            <span className="stat-k">Holdings</span>
            <span className="stat-v num">{data.risk.holdings}</span>
          </span>
          <span>
            <span className="stat-k">Effective bets</span>
            <span className="stat-v num">
              {data.risk.effectiveBetsCorrelation != null
                ? data.risk.effectiveBetsCorrelation.toFixed(1)
                : data.risk.effectiveBetsWeight != null
                  ? `${data.risk.effectiveBetsWeight.toFixed(1)}*`
                  : "--"}
            </span>
          </span>
          <span>
            <span className="stat-k">Mean correlation</span>
            <span className="stat-v num">
              {data.risk.meanCorrelation != null ? data.risk.meanCorrelation.toFixed(2) : "--"}
            </span>
          </span>
          <span>
            <span className="stat-k">Top 3 sectors</span>
            <span className="stat-v num">
              {data.risk.sectors.topThreeShare != null
                ? `${(data.risk.sectors.topThreeShare * 100).toFixed(0)}%`
                : "--"}
            </span>
          </span>
        </div>

        {data.risk.effectiveBetsCorrelation == null && data.risk.effectiveBetsWeight != null && (
          <p className="risk-note">
            * Weight concentration only. Correlation needs {data.risk.correlationWindow} sessions
            of stored history, which have not been backfilled yet.
          </p>
        )}
      </header>

      <section className="history">
        <div className="sec-head">
          <h2 className="sec-title">Tier stability</h2>
          <span className="sec-note">
            {data.history.sessions === 0
              ? "No nights recorded yet."
              : `Measured over all ${data.history.sessions} recorded sessions.`}
          </span>
        </div>

        {data.history.sessions < 2 ? (
          /* One night is a photograph, not a history. Saying so beats rendering
             a zero that reads as "perfectly stable". */
          <p className="lookup-note">
            Turnover and time-in-tier need at least two recorded nights. The refresh runs at
            22:00 UTC on weekdays, so these fill in from tomorrow.
          </p>
        ) : (
          <>
            <div className="risk">
              <span>
                <span className="stat-k">
                  Annualised turnover
                  <span className="stat-window"> · {data.history.sessions} sessions</span>
                </span>
                <span className="stat-v num">
                  {data.history.turnover != null
                    ? `${Math.round(data.history.turnover * 100)}%`
                    : "--"}
                </span>
              </span>
              <span>
                <span className="stat-k">Median time in tier</span>
                <span className="stat-v num">
                  {data.history.medianTimeInTier != null
                    ? `${data.history.medianTimeInTier} sessions`
                    : "--"}
                </span>
              </span>
              <span>
                <span className="stat-k">Recent moves</span>
                <span className="stat-v num">{data.history.transitions.length}</span>
              </span>
            </div>

            {data.history.turnover != null && data.history.turnover > 2 && (
              <p className="lookup-note neg">
                Turnover above 200% a year suggests the tier cutoffs are chasing noise rather
                than tracking a regime.
              </p>
            )}

            {data.history.transitions.length > 0 && (
              <ul className="transitions">
                {data.history.transitions.slice(0, 12).map((t) => (
                  <li key={`${t.session}-${t.ticker}`}>
                    <span className="num tr-date">{t.session}</span>
                    <span className="ticker tr-ticker">{t.ticker}</span>
                    <span className="tr-move">
                      {t.from ?? "—"} → {t.to ?? "off screen"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {data.history.leastStable.length > 0 && (
              <p className="lookup-note">
                Least stable:{" "}
                {data.history.leastStable
                  .map((s) => `${s.ticker} (${s.sessions})`)
                  .join(", ")}
                . A name flipping tier every few sessions is a signal-quality problem, not a
                trading opportunity.
              </p>
            )}
          </>
        )}
      </section>

      <TickerLookup />

      <ScreenTable data={data} />

      {/* The full universe, below the theme. Order is the argument: the theme
          table is what the strategy says to do, the leaders table is the
          market it was selected from. Putting leaders first would bury the
          decision surface under 2,300 rows. */}
      <LeadersTable data={data} />

      <p className="foot">
        Each rail runs 0 to 100 across the ranked universe, with the two cutoffs marked. Cool
        means the name trades above its 200-day moving-average proxy, warm means below.
        A late-stage chart (Weinstein 3 or 4) caps the tier one step; a Strong Buy must also
        show accelerating revenue or an expanding operating margin; and the top tier is limited
        to the {data.strongBuyLimit} highest-ranked survivors. Every name held down shows why. Fundamentals checked for{" "}
        {data.meta.fundamentalsChecked} names. Bars for {Object.keys(data.anchors).length} anchor
        sessions, {cached} served from cache. Screen built in{" "}
        {(data.meta.elapsedMs / 1000).toFixed(1)}s.
      </p>

      <details className="legend">
        <summary>What do the columns mean?</summary>
        <dl className="legend-list">
          <div><dt>RS</dt><dd>Relative-strength percentile against every liquid US stock (~2,200), not against the theme. 40% 3-month, 30% 6-month, 30% 12-month.</dd></div>
          <div><dt>The rail</dt><dd>RS drawn 0–100 with ticks at the tier cutoffs, 55 and 80. Cool means above the 200-day average, warm means below.</dd></div>
          <div><dt>Day / Wk / Mo</dt><dd>Close against the previous close, 5 sessions ago and 21 sessions ago. Trading sessions, not calendar days.</dd></div>
          <div><dt>vs MA</dt><dd>Distance from the 200-day moving average.</dd></div>
          <div><dt>TT</dt><dd>Trend template out of 8. Blank until 222 sessions of history exist — a partial score would read as failure.</dd></div>
          <div><dt>Stage</dt><dd>Weinstein stage: 1 base, 2 advance, 3 topping, 4 decline, T transitional.</dd></div>
          <div><dt>U/D</dt><dd>Up-day volume over down-day volume across 50 sessions. Above 1.0 is accumulation.</dd></div>
          <div><dt>Acc</dt><dd>Accumulation grade A–E, ranked across the full universe.</dd></div>
          <div><dt>Held out</dt><dd>Excluded on purpose, with the reason attached. Never silently dropped.</dd></div>
        </dl>
      </details>
    </main>
  );
}
