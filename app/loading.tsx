/**
 * Shown while the server component computes the screen. (Finding U7)
 *
 * A cold render walks the trading calendar, five grouped sessions, the
 * reference universe and up to 42 EDGAR sweeps — around ten seconds on a cold
 * instance. Without this the browser sat on a blank page with no indication
 * that anything was happening.
 */
export default function Loading() {
  return (
    <main className="wrap" aria-busy="true">
      <header className="masthead">
        <h1 className="title">AI Revolution Screener</h1>
        <p className="subtitle">Ranking the liquid universe and checking fundamentals…</p>
      </header>

      <div className="panel">
        <ul className="skeleton-list">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="skeleton-row">
              <span className="skeleton-block skeleton-ticker" />
              <span className="skeleton-block skeleton-rail" />
            </li>
          ))}
        </ul>
      </div>

      <p className="foot">First load builds the screen from scratch; later loads are cached.</p>
    </main>
  );
}
