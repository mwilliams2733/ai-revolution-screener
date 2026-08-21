"use client";

import { useEffect, useRef, useState } from "react";
import { summarise } from "@/lib/summarise";

interface Detail {
  name: string;
  description: string | null;
  sicDescription: string | null;
  marketCap: number | null;
  employees: number | null;
}

interface EarningsEvent {
  date: string;
  hour: string;
  surprisePct: number | null;
}

interface Earnings {
  next: EarningsEvent | null;
  history: EarningsEvent[];
  beatsLastFour: number | null;
}

interface Payload {
  ticker: string;
  detail: Detail | null;
  earnings: Earnings | null;
}

const cache = new Map<string, Payload>();

function money(n: number | null): string {
  if (n == null) return "--";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

const WHEN: Record<string, string> = { bmo: "before open", amc: "after close" };


export default function CompanyTooltip({ ticker, name }: { ticker: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(cache.get(ticker) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = useRef<HTMLSpanElement | null>(null);

  /**
   * Place the panel relative to the trigger, kept inside the viewport.
   *
   * Flips above the trigger when there is not enough room below, which is the
   * common case for rows in the lower half of the screen — on a phone that is
   * most of the table.
   */
  function place() {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(330, window.innerWidth * 0.84);
    const height = Math.min(window.innerHeight * 0.6, 420);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));

    const roomBelow = window.innerHeight - r.bottom;
    const top =
      roomBelow < height + 16 && r.top > height + 16
        ? Math.max(8, r.top - height - 7)
        : Math.min(r.bottom + 7, window.innerHeight - height - 8);

    setPos({ top, left });
  }

  useEffect(() => {
    if (!open || data || error) return;
    let cancelled = false;
    fetch(`/api/company/${encodeURIComponent(ticker)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Payload) => {
        if (cancelled) return;
        cache.set(ticker, j);
        setData(j);
      })
      .catch(() => !cancelled && setError("Could not load company detail."));
    return () => {
      cancelled = true;
    };
  }, [open, data, error, ticker]);

  // A small delay stops tooltips flickering open as the pointer crosses rows.
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      place();
      setOpen(true);
    }, 180);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 120);
  };

  const d = data?.detail;
  const e = data?.earnings;

  return (
    <span
      ref={hostRef}
      className="tt-host"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        className="tt-trigger"
        aria-expanded={open}
        aria-label={`Company detail for ${ticker}`}
        onClick={() => {
          place();
          setOpen((v) => !v);
        }}
      >
        {name || ticker}
      </button>

      {open && (
        <span
          className="tt"
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : undefined}
        >
          <span className="tt-head">
            <strong>{ticker}</strong>
            {d?.name ? ` · ${d.name}` : ""}
          </span>

          {!data && !error && <span className="tt-muted">Loading…</span>}
          {error && <span className="tt-muted">{error}</span>}

          {d?.description && <span className="tt-body">{summarise(d.description)}</span>}
          {!d?.description && data && (
            <span className="tt-muted">
              {d?.sicDescription
                ? `No description filed. Classified as ${d.sicDescription.toLowerCase()}.`
                : "No business description available for this listing."}
            </span>
          )}

          {(d?.marketCap != null || d?.employees != null) && (
            <span className="tt-stats num">
              {d?.marketCap != null && <span>Mkt cap {money(d.marketCap)}</span>}
              {d?.employees != null && <span>{d.employees.toLocaleString()} staff</span>}
            </span>
          )}

          {e && (
            <span className="tt-earn">
              <span className="tt-label">Earnings</span>
              {e.next ? (
                <span className="num">
                  Next {e.next.date}
                  {WHEN[e.next.hour] ? ` · ${WHEN[e.next.hour]}` : ""}
                </span>
              ) : (
                <span className="tt-muted">No date scheduled</span>
              )}
              {e.history.length > 0 && (
                <span className="tt-surprises num">
                  {e.history.slice(0, 4).map((h) => (
                    <span
                      key={h.date}
                      className={
                        h.surprisePct == null ? "" : h.surprisePct >= 0 ? "pos" : "neg"
                      }
                      title={h.date}
                    >
                      {h.surprisePct == null
                        ? "--"
                        : `${h.surprisePct >= 0 ? "+" : ""}${h.surprisePct.toFixed(1)}%`}
                    </span>
                  ))}
                </span>
              )}
              {e.beatsLastFour != null && (
                <span className="tt-muted">Beat consensus {e.beatsLastFour} of last 4</span>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
