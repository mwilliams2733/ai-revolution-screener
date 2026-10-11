/**
 * Signal Trader: the signal lab traded on paper, one settled session at a time.
 * Long only, stock only. Nothing here places orders or handles real money.
 */
import Link from "next/link";
import { getSignalTraderView } from "@/lib/signal-trader/view";
import { ST_CONFIG } from "@/lib/signal-trader/config";
import { MISSING, signClass } from "@/lib/format";
import { CloseButton, PauseToggle } from "./controls";

export const dynamic = "force-dynamic";

const pc = (x: number | null | undefined, dp = 2) =>
  x == null || Number.isNaN(x) ? MISSING : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;
const usd = (x: number | null | undefined) =>
  x == null || Number.isNaN(x) ? MISSING : `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const range = (ci: { lo: number; hi: number } | null) => (ci ? `[${pc(ci.lo)}, ${pc(ci.hi)}]` : MISSING);

export default async function SignalTrader() {
  let v: Awaited<ReturnType<typeof getSignalTraderView>>;
  try {
    v = await getSignalTraderView();
  } catch (e) {
    return (
      <main className="wrap">
        <h1 className="title">Signal Trader</h1>
        <p className="stale-banner very-stale" role="alert">Could not load: {e instanceof Error ? e.message : String(e)}</p>
      </main>
    );
  }
  const failed = v.lastRun?.status === "error";

  return (
    <main className="wrap st">
      <header className="masthead">
        <h1 className="title">Signal Trader <span className="st-paper">PAPER</span></h1>
        <p className="subtitle"><Link href="/" className="tick">← Screener</Link></p>
        {(v.behind > 1 || failed) && (
          <p className={`stale-banner ${failed ? "very-stale" : "stale"}`} role="alert">
            {failed
              ? <><strong>The last run failed:</strong> {v.lastRun?.note}</>
              : <><strong>{v.behind} sessions waiting.</strong> Last processed {v.lastProcessed ?? "never"}; newest stored {v.latestStored}.</>}
          </p>
        )}
        <p className="subtitle">
          The signal lab&apos;s long signals, traded on paper: picks are decided at a settled close
          and fill at the next open. $1,000 per pick, −8% stop. Long only, stock only; options are
          deferred. Research only — no broker, no orders, no real money.
        </p>
        <div className="st-stats">
          <span><span className="stat-k">Cash</span> <span className="num">{usd(v.cash)}</span></span>
          <span><span className="stat-k">Equity</span> <span className="num">{usd(v.equity)}</span></span>
          <span><span className="stat-k">Last processed</span> <span className="num">{v.lastProcessed ?? "never"}</span></span>
          <PauseToggle paused={v.paused} />
        </div>
      </header>

      <section className="st-section">
        <h2>Picks</h2>
        <p className="note">Last 30 sessions. A pending pick fills at the next open; Cancel stops it.</p>
        <div className="panel st-scroll">
          <table className="st-tbl">
            <thead><tr><th>Decided</th><th>Ticker</th><th>Signal</th><th className="num">Window</th><th className="num">Expected</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {v.picks.map((p) => (
                <tr key={p.key}>
                  <td className="num">{p.decidedSession}</td>
                  <td><strong>{p.ticker}</strong></td>
                  <td>{ST_CONFIG.signals[p.signal].label}</td>
                  <td className="num">{p.windowDays}d</td>
                  <td className="num">{pc(p.expectedMove)}</td>
                  <td>
                    {p.status === "pending" && "Pending — fills at the next open"}
                    {p.status === "open" && <>PAPER bought {p.entrySession} at {usd(p.entryPrice)}</>}
                    {p.status === "closed" && "Closed"}
                    {p.status === "cancelled" && <>Cancelled{p.note ? ` — ${p.note}` : ""}</>}
                  </td>
                  <td>{p.status === "pending" && <CloseButton pickKey={p.key} label="Cancel" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {v.picks.length === 0 && <p className="empty">No picks yet. The first run trades from {ST_CONFIG.job.live_start}.</p>}
        </div>
      </section>

      <section className="st-section">
        <h2>Portfolio</h2>
        <div className="panel st-scroll">
          <table className="st-tbl">
            <thead><tr><th>Ticker</th><th>Signal</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">P&amp;L</th><th className="num">Left</th><th className="num">Stop</th><th></th></tr></thead>
            <tbody>
              {v.positions.map((p) => {
                const mark = p.lastMark ?? p.entryPrice;
                const pnl = p.qty * (mark - p.entryPrice);
                return (
                  <tr key={p.key}>
                    <td><strong>{p.ticker}</strong> <span className="st-paper">PAPER</span></td>
                    <td>{ST_CONFIG.signals[p.signal].label}</td>
                    <td className="num">{usd(p.entryPrice)}<span className="st-sub">{p.entrySession}</span></td>
                    <td className="num">{usd(p.lastMark)}<span className="st-sub">{p.lastMarkSession ?? "—"}</span></td>
                    <td className={`num ${signClass(pnl)}`}>{usd(pnl)}<span className="st-sub">{pc(mark / p.entryPrice - 1)}</span></td>
                    <td className="num">{v.sessionsLeft[p.key]}d</td>
                    <td className="num">{usd(p.stopPrice)}</td>
                    <td>{p.closeRequestedAt ? "Closing at next open" : <CloseButton pickKey={p.key} label="Close" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {v.positions.length === 0 && <p className="empty">No open positions.</p>}
        </div>
      </section>

      <section className="st-section">
        <h2>Grading</h2>
        <p className="note">
          Counted in independent episodes: overlapping windows across tickers are one bet. The lab&apos;s own
          test set was about 34 episodes. Raw return and return in excess of SPY over the same window.
        </p>
        <div className="panel st-scroll">
          <table className="st-tbl">
            <thead><tr><th>Signal</th><th className="num">Picks</th><th className="num">Episodes</th><th className="num">Hit (lab)</th><th className="num">Mean [95% CI]</th><th className="num">vs SPY [95% CI]</th><th className="num">Expected</th><th className="num">P&amp;L</th></tr></thead>
            <tbody>
              {v.scores.map((s) => (
                <tr key={s.signal}>
                  <td>
                    {s.label}
                    {s.smallSample && (
                      <span className="st-sub st-warn">
                        {s.episodes} of {ST_CONFIG.grading.min_episodes} episodes
                        {s.sessionsTo30 != null && s.sessionsTo30 > 0 ? ` — about ${Math.ceil(s.sessionsTo30 / 21)} months to go at this rate` : ""}
                      </span>
                    )}
                  </td>
                  <td className="num">{s.picks}</td>
                  <td className="num">{s.episodes}</td>
                  <td className="num">{s.hitRate == null ? MISSING : `${Math.round(s.hitRate * 100)}%`} ({Math.round(s.labHit * 100)}%)</td>
                  <td className={`num ${signClass(s.meanRaw)}`}>{pc(s.meanRaw)}<span className="st-sub">{range(s.ciRaw)}</span></td>
                  <td className={`num ${signClass(s.meanExcess)}`}>{pc(s.meanExcess)}<span className="st-sub">{range(s.ciExcess)}</span></td>
                  <td className="num">{pc(s.expectedMove)}</td>
                  <td className={`num ${signClass(s.pnl)}`}>{usd(s.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="st-section">
        <h2>Lab</h2>
        <p className="note">
          The ported engine on every stored session, with the shipped cutoffs. Does each signal still hold up
          on this database&apos;s bars? Raw n overstates; read episodes and the date-clustered t.
        </p>
        <div className="panel st-scroll">
          <table className="st-tbl">
            <thead><tr><th>Signal</th><th className="num">Window</th><th className="num">n</th><th className="num">Episodes</th><th className="num">Mean</th><th className="num">vs SPY</th><th className="num">Hit</th><th className="num">t (dates)</th><th className="num">Lab expected</th></tr></thead>
            <tbody>
              {v.lab.map((r) => (
                <tr key={r.signal}>
                  <td>{r.label}</td>
                  <td className="num">{r.window}d</td>
                  <td className="num">{r.n}</td>
                  <td className="num">{r.episodes}</td>
                  <td className={`num ${signClass(r.mean)}`}>{pc(r.mean)}</td>
                  <td className={`num ${signClass(r.excess)}`}>{pc(r.excess)}</td>
                  <td className="num">{Number.isNaN(r.hit) ? MISSING : `${Math.round(r.hit * 100)}%`}</td>
                  <td className="num">{Number.isNaN(r.tDates) ? MISSING : r.tDates.toFixed(2)}</td>
                  <td className="num">{pc(r.expected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
