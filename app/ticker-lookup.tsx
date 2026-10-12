"use client";

import { useState } from "react";
import { num, pct, signClass } from "@/lib/format";
import type { LookupResult } from "@/lib/lookup";
import { notes, tierClass } from "./market-groups";

export default function TickerLookup() {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
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
      setResult(json as LookupResult);
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
          <strong className="num">{result.ticker}</strong> is not on the ranked screen: {result.reason}
        </p>
      )}

      {result && r && (
        <div className="lookup-card">
          <div className="lookup-head">
            <span className="ticker">{r.ticker}</span>
            <span className="coname">{r.name}</span>
            {r.badge && <span className="mg-badge">{r.badge}</span>}
            <span className={`badge-name ${tierClass(r)}`}>{r.tier ?? "--"}</span>
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

          <p className="lookup-note">{result.placement}.</p>
          {notes(r).map((n) => (
            <p key={n} className="lookup-note">
              {n}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
