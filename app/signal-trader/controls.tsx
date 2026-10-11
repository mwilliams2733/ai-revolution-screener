"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

async function post(path: string, body: unknown): Promise<string | null> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { error?: string; result?: string };
  return j.error ?? j.result ?? `HTTP ${res.status}`;
}

export function PauseToggle({ paused }: { paused: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="st-control">
      <button
        className={`st-btn ${paused ? "st-btn-warn" : ""}`}
        aria-pressed={paused}
        disabled={pending}
        onClick={() => start(async () => { setError(await post("/api/signal-trader/pause", { paused: !paused })); router.refresh(); })}
      >
        {paused ? "Auto-trade paused — resume" : "Auto-trade on — pause"}
      </button>
      {error && <span className="st-error" role="alert">{error}</span>}
    </span>
  );
}

export function CloseButton({ pickKey, label }: { pickKey: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="st-control">
      <button
        className="st-btn"
        disabled={pending}
        onClick={() => start(async () => { setError(await post("/api/signal-trader/close", { key: pickKey })); router.refresh(); })}
      >
        {label}
      </button>
      {error && <span className="st-error" role="alert">{error}</span>}
    </span>
  );
}
