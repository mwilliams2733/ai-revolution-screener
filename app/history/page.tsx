/**
 * Top 10 history: pick a session, see that day's cohort and what happened next.
 *
 * Only LIVE sessions are offered. A replayed session was reconstructed under a
 * different ruleset -- no fundamental gate, today's theme map, a universe
 * pruned with hindsight -- so its "top 10" never existed on that date. Showing
 * it would be fiction wearing a date, so liveSessions() excludes it at the
 * query rather than the UI hiding it later.
 */

import Link from "next/link";
import { liveSessions, cohortAt, closesOn } from "@/lib/db";
import { benchmarkPct, cohortRows, summarise } from "@/lib/cohort";
import { signClass } from "@/lib/format";

export const revalidate = 3600;

const f = (v: number | null, d = 1) => (v == null ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

export default async function History({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session: wanted } = await searchParams;
  const sessions = await liveSessions();

  if (sessions.length === 0) {
    return (
      <main className="wrap">
        <header className="masthead">
          <h1 className="title">Top 10 history</h1>
          <p className="subtitle">
            No live sessions recorded yet. History begins the first time the nightly refresh
            snapshots tiers; reconstructed sessions are deliberately not offered, because they
            were built under a different ruleset.
          </p>
        </header>
      </main>
    );
  }

  // sessions is newest-first, so [0] is the latest and the last entry is the
  // oldest live cohort. Default to the OLDEST: it is the only one with any
  // elapsed time to show. Defaulting to the latest would open the page on a
  // table of zeroes, which looks broken rather than empty.
  const latest = sessions[0];
  const oldest = sessions[sessions.length - 1];
  const session = wanted && sessions.includes(wanted) ? wanted : oldest;

  const { top, themed } = await cohortAt(session);
  const current = await cohortAt(latest);
  const currentTop = new Set(current.top.map((t) => t.ticker));

  const names = [...new Set([...themed, ...top.map((t) => t.ticker)])];
  const [entry, now] = await Promise.all([closesOn(session, names), closesOn(latest, names)]);

  const rows = cohortRows(top, entry, now, currentTop);
  const s = summarise(rows);
  const theme = benchmarkPct(themed, entry, now);
  const held = sessions.indexOf(session) - sessions.indexOf(latest);

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="title">Top 10 history</h1>
        <p className="subtitle">
          The ten Strong Buys as they stood on a chosen session, and how they have moved since.
          Only sessions the screener recorded live are offered — reconstructed history ran a
          different ruleset and its top ten never existed.
        </p>

        <nav className="sessions" aria-label="Choose a session">
          {sessions.map((d) => (
            <Link
              key={d}
              href={`/history?session=${d}`}
              className={`session-chip${d === session ? " on" : ""}`}
              aria-current={d === session ? "page" : undefined}
            >
              {d}
            </Link>
          ))}
        </nav>

        <div className="stats">
          <span>
            <span className="stat-k">Cohort</span>
            <span className="stat-v num">{session}</span>
          </span>
          <span>
            <span className="stat-k">Sessions held</span>
            <span className="stat-v num">{held}</span>
          </span>
          <span>
            <span className="stat-k">Cohort mean</span>
            <span className={`stat-v num ${signClass(s.mean ?? 0)}`}>{f(s.mean)}</span>
          </span>
          <span>
            <span className="stat-k">Theme</span>
            <span className={`stat-v num ${signClass(theme ?? 0)}`}>{f(theme)}</span>
          </span>
          <span>
            <span className="stat-k">vs theme</span>
            <span className={`stat-v num ${signClass((s.mean ?? 0) - (theme ?? 0))}`}>
              {s.mean != null && theme != null ? `${s.mean - theme >= 0 ? "+" : ""}${(s.mean - theme).toFixed(1)}pp` : "--"}
            </span>
          </span>
          <span>
            <span className="stat-k">Win rate</span>
            <span className="stat-v num">{s.winRate == null ? "--" : `${s.winRate.toFixed(0)}%`}</span>
          </span>
        </div>

        {/* The absolute number misleads on its own: every live cohort so far is
            negative while the theme fell further, which is the signal working. */}
        <p className="note">
          Read the cohort against the theme, not against zero. Every live cohort so far is
          negative in absolute terms while the theme fell further.
          {held === 0 && " This is the latest session, so nothing has happened since yet."}
        </p>
      </header>

      <table className="cohort">
        <thead>
          <tr>
            <th>Ticker</th>
            <th className="num">Entry RS</th>
            <th className="num">Entry</th>
            <th className="num">Now</th>
            <th className="num">Change</th>
            <th>Still top 10</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .slice()
            .sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity))
            .map((r) => (
              <tr key={r.ticker}>
                <td>
                  <Link href={`/history/${r.ticker}`} className="tick">
                    {r.ticker}
                  </Link>
                </td>
                <td className="num">{r.entryRs == null ? "--" : Math.round(r.entryRs)}</td>
                <td className="num">{r.entryClose == null ? "--" : r.entryClose.toFixed(2)}</td>
                <td className="num">{r.nowClose == null ? "--" : r.nowClose.toFixed(2)}</td>
                <td className={`num ${signClass(r.pct ?? 0)}`}>{f(r.pct)}</td>
                <td>{r.stillHeld ? "yes" : "dropped"}</td>
              </tr>
            ))}
        </tbody>
      </table>

      {s.missing > 0 && (
        <p className="note">
          {s.missing} name{s.missing === 1 ? "" : "s"} had no price at one end and {s.missing === 1 ? "is" : "are"}{" "}
          excluded from the averages rather than counted as flat.
        </p>
      )}

      <p className="note">
        <strong>These cohorts are not independent.</strong> Every one of them ends on{" "}
        {latest}, so the overlapping windows are largely the same price movements counted
        repeatedly — the effective sample is nearer one than {sessions.length}. Useful for
        watching; not evidence that the ruleset works. That question needs{" "}
        <code>npm run backtest</code>, which measures non-overlapping windows and refuses to
        claim significance.
      </p>

      <p className="note">
        <Link href="/">← back to the screen</Link>
      </p>
    </main>
  );
}
