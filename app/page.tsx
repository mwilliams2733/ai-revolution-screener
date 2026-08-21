import { getScreen } from "@/lib/screen-service";
import { DEFAULT_PARAMS } from "@/lib/params";
import ScreenTable from "./screen-table";
import TickerLookup from "./ticker-lookup";

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
            <span className="stat-k">Gate demoted</span>
            <span className="stat-v num">{data.demoted}</span>
          </span>
          <span>
            <span className="stat-k">Capped out</span>
            <span className="stat-v num">{data.capped}</span>
          </span>
        </div>

        <Distribution marks={marks} />
      </header>

      <TickerLookup />

      <ScreenTable data={data} />

      <p className="foot">
        Each rail runs 0 to 100 across the ranked universe, with the two cutoffs marked. Cool
        means the name trades above its 200-day moving-average proxy, warm means below.
        A Strong Buy must also show accelerating revenue or an expanding operating margin, and
        the tier is capped at the top {data.strongBuyLimit} by rank; names that fail either test
        are held at Buy with the reason shown. Fundamentals checked for{" "}
        {data.meta.fundamentalsChecked} names. Bars for {Object.keys(data.anchors).length} anchor
        sessions, {cached} served from cache. Screen built in{" "}
        {(data.meta.elapsedMs / 1000).toFixed(1)}s.
      </p>
    </main>
  );
}
