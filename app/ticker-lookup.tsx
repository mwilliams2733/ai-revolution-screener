"use client";

import { useState } from "react";
import { num, pct, signClass } from "@/lib/format";

interface Row {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  dollarVolume: number;
  r3m: number;
  r12m: number;
  vsMa: number;
  rsPct: number | null;
  tier: string | null;
}

interface Result {
  ticker: string;
  found: boolean;
  row: Row | null;
  inTheme: boolean;
  reason: string | null;
  universeSize: number;
  asOf: string;
}


export default function TickerLookup() {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const t = value.trim().toUpperCase();
    if (!t) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/lookup/${encodeURIComponent(t)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json as Result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  const r = result?.row;

  return (
    <section className="lookup">
      <form className="lookup-form" onSubmit={run}>
        <label className="ctl-label" htmlFor="ticker-input">
          Check any ticker
        </label>
        <input
          id="ticker-input"
          className="lookup-input num"
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          placeholder="SNDK"
          maxLength={10}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="chip lookup-go" type="submit" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Apply ruleset"}
        </button>
      </form>

      {error && <p className="lookup-note neg">{error}</p>}

      {result && !r && (
        <p className="lookup-note">
          <strong className="num">{result.ticker}</strong> is not on the ranked screen.{" "}
          {result.reason ?? "It did not clear the liquidity gate."}
        </p>
      )}

      {result && r && (
        <div className="lookup-card">
          <div className="lookup-head">
            <span className="ticker">{r.ticker}</span>
            <span className="coname">{r.name}</span>
            <span className={`badge-name ${r.vsMa < 0 ? "t-below" : "t-strong"}`}>
              {r.tier ?? "--"}
            </span>
          </div>

          <div className="figs">
            <span>
              <span className="fig-k">RS </span>
              <span className="fig-v num">{num(r.rsPct)}</span>
              <span className="fig-k"> of {result.universeSize.toLocaleString()}</span>
            </span>
            <span>
              <span className="fig-k">Price </span>
              <span className="fig-v num">${r.price.toFixed(2)}</span>
            </span>
            <span>
              <span className="fig-k">vs MA </span>
              <span className={`fig-v num ${signClass(r.vsMa)}`}>{pct(r.vsMa)}</span>
            </span>
            <span>
              <span className="fig-k">3M </span>
              <span className={`fig-v num ${signClass(r.r3m)}`}>{pct(r.r3m, 0)}</span>
            </span>
            <span>
              <span className="fig-k">12M </span>
              <span className={`fig-v num ${signClass(r.r12m)}`}>{pct(r.r12m, 0)}</span>
            </span>
          </div>

          {/* A themed name is tradable; anything else is ranked but held out,
              and the reason travels with it rather than being dropped. */}
          {!result.inTheme && (
            <p className="lookup-note">
              Ranked against the full universe, but outside the tradable set —{" "}
              {result.reason ?? "not in the AI CapEx-taker theme"}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
