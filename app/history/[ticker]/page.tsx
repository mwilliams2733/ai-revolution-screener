/**
 * One name's trend: full stored price history, with its live tier changes.
 *
 * Prices span EVERYTHING -- a close is a close regardless of which ruleset
 * produced a tier that day. Tier markers do not: only live rows are drawn,
 * because a replayed tier badge on a chart is the same fiction as a replayed
 * cohort, just harder to notice.
 *
 * The sparkline is hand-rolled SVG rather than a charting library. This project
 * has no charting dependency and its existing visual -- the distribution rail
 * on the screen -- is CSS and SVG, so adding one for two lines would be both a
 * dependency and a style break.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { tickerTrend } from "@/lib/db";
import { changePct } from "@/lib/cohort";
import { signClass } from "@/lib/format";

export const revalidate = 3600;

const W = 720;
const H = 160;

/** Map a series to an SVG polyline over the full plot area. */
function path(values: readonly number[]): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - lo) / span) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export default async function Trend({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: raw } = await params;
  const ticker = decodeURIComponent(raw).toUpperCase();
  const { bars, tiers } = await tickerTrend(ticker);

  if (bars.length === 0) notFound();

  const closes = bars.map((b) => b.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const total = changePct(first, last);

  // Tier changes only, not every recorded session: a list of 8 identical rows
  // saying "Strong Buy" is noise, and the transitions are the story.
  const changes: { session: string; from: string | null; to: string | null }[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const prev = i === 0 ? null : tiers[i - 1].tier;
    if (i === 0 || prev !== tiers[i].tier) {
      changes.push({ session: tiers[i].session, from: i === 0 ? null : prev, to: tiers[i].tier });
    }
  }

  const index = new Map(bars.map((b, i) => [b.session, i]));
  const marks = tiers
    .map((t) => ({ ...t, i: index.get(t.session) }))
    .filter((t): t is typeof t & { i: number } => t.i != null);

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="title">{ticker}</h1>
        <p className="subtitle">
          Full stored price history. Tier markers are drawn only for sessions the screener
          recorded live — reconstructed tiers ran a different ruleset and are left off
          rather than shown with a caveat.
        </p>

        <div className="stats">
          <span>
            <span className="stat-k">Sessions</span>
            <span className="stat-v num">{bars.length.toLocaleString()}</span>
          </span>
          <span>
            <span className="stat-k">From</span>
            <span className="stat-v num">{bars[0].session}</span>
          </span>
          <span>
            <span className="stat-k">Latest close</span>
            <span className="stat-v num">{last.toFixed(2)}</span>
          </span>
          <span>
            <span className="stat-k">Over the window</span>
            <span className={`stat-v num ${signClass(total ?? 0)}`}>
              {total == null ? "--" : `${total >= 0 ? "+" : ""}${total.toFixed(1)}%`}
            </span>
          </span>
          <span>
            <span className="stat-k">Live tier rows</span>
            <span className="stat-v num">{tiers.length}</span>
          </span>
        </div>
      </header>

      <svg
        className="spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${ticker} close from ${bars[0].session} to ${bars[bars.length - 1].session}, ${
          total == null ? "unmeasured" : `${total.toFixed(0)} percent`
        }`}
      >
        <path d={path(closes)} className="spark-line" />
        {marks.map((m) => (
          <circle
            key={m.session}
            cx={((m.i / (closes.length - 1)) * W).toFixed(1)}
            cy={(
              H -
              ((closes[m.i] - Math.min(...closes)) / (Math.max(...closes) - Math.min(...closes) || 1)) * H
            ).toFixed(1)}
            r={2.5}
            className={`spark-mark tier-${(m.tier ?? "none").replace(/\s+/g, "-").toLowerCase()}`}
          >
            <title>{`${m.session} — ${m.tier ?? "no tier"}${m.rsPct == null ? "" : `, RS ${Math.round(m.rsPct)}`}`}</title>
          </circle>
        ))}
      </svg>

      <h2 className="section">Tier changes</h2>
      {changes.length === 0 ? (
        <p className="note">No live tier history for this name yet.</p>
      ) : (
        <table className="cohort">
          <thead>
            <tr>
              <th>Session</th>
              <th>From</th>
              <th>To</th>
              <th className="num">Close</th>
            </tr>
          </thead>
          <tbody>
            {changes
              .slice()
              .reverse()
              .map((c) => {
                const i = index.get(c.session);
                return (
                  <tr key={c.session}>
                    <td className="num">{c.session}</td>
                    <td>{c.from ?? "first seen"}</td>
                    <td>{c.to ?? "--"}</td>
                    <td className="num">{i == null ? "--" : closes[i].toFixed(2)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}

      <p className="note">
        <Link href="/history">← back to top 10 history</Link>
      </p>
    </main>
  );
}
