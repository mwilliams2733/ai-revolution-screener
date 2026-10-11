# Signal Trader Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Signal Trader" tab that auto-paper-trades the signal lab's long stock signals on 12 tickers, one settled session at a time, and grades the results against SPY with honest sample sizes.

**Architecture:** The lab's Python indicators and evaluation are ported to pure TypeScript in `lib/signal-trader/`, proven equal to the lab by a golden file the lab script itself generates. A pure engine advances paper state one settled session at a time (fill → exits/marks → scan). A thin server layer loads bars from the existing `daily_bars`, runs the engine, and persists each session atomically. A morning cron drives it, and a new `/signal-trader` page reads it.

**Tech Stack:** Next.js 16.3.1 App Router, TypeScript, vitest, Neon Postgres (`@neondatabase/serverless`, `sql.transaction`), tsx scripts, Python 3.11 + pandas (golden generator only).

**Spec:** `docs/superpowers/specs/2026-10-10-signal-trader-brief-v4.md`. Task 0 copies it from `c:\Users\mwill\Downloads\SIGNAL-APP-build-brief-v4.md`. Two owner decisions taken after v4 override it:
- **Options deferred (2026-10-10).** WS5 is out of scope. The probe found the plan returns delta, OI and day OHLC but no ask or last trade, and qualifying calls cost $16–$51/share, so the $300/$1.50 leg could never fill. The tab says options are deferred.
- **Long only (decision 4, already in v4).**

## Global Constraints

- No new npm dependencies. Python is used only by `scripts/signal-trader-golden.py`, which is run once locally; nothing in the deployed app calls Python.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing route or page code (AGENTS.md).
- Universe: `SPY, QQQ, AAPL, MSFT, NVDA, TSLA, AMD, META, AMZN, GOOGL, JPM, XOM`. Benchmark: `SPY`.
- Long only. Stock only. $1,000 notional per pick, fractional shares, starting cash 100000.
- Stop −8%: on the day's low fill at the stop; if the session **opens** at or below the stop, fill at the open (`stop_gap`).
- A pick decided at the close of session *t* fills at the open of the first stored session after *t* whose 09:30 America/New_York open is **after** the pick's `created_at`.
- Signals use only sessions present in `stored_sessions` (settled at 18:00 ET by the refresh).
- Every buy and sell is labelled "PAPER" in the UI.
- Grades are written once, at exit, and never revised.
- The job processes sessions on or after `ST_CONFIG.job.live_start` only, each session exactly once (`st_sessions` primary key), in ascending order.
- `npm run typecheck` and `npm test` must pass after every task; `npm run lint` must add no new problems (baseline: 1 error in `app/use-persisted-state.ts`, 2 warnings).
- Never stage `.claude/` or `.semgrep/`. Use explicit `git add` paths.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The refresh is late and the job runs after the market opened.** Expected: new picks do not fill at that open; they fill at the next one. Pinned by Task 5's test "a pick created after the next open waits for the following session".
2. **The job missed several days and catches up.** Expected: sessions processed in order, each once, and picks created during catch-up fill at the first open after the catch-up run, never retroactively. Pinned by Task 7's test "catch-up never fills before the run that created the pick".
3. **A ticker has no bar for a session (halt, data gap).** Expected: its pending pick stays pending and its open position stays open with a note; nothing is priced from a missing bar. Pinned by Task 5's test "a missing bar leaves the pick pending and the position open".
4. **Two runs for the same session race (Vercel cron and the GitHub backup).** Expected: one persists, the other changes nothing. Pinned by Task 8: the `st_sessions` insert is the first statement of the per-session transaction with no `ON CONFLICT`, so the loser's whole transaction rolls back. Verified by running the dry-run then the real run twice in Task 8 Step 9.
5. **The user presses Close on a pick that has not filled yet.** Expected: the pick is cancelled and never fills. Pinned by Task 10's store behaviour (`requestClose` cancels pending picks) and checked in the UI walkthrough.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-10-10-signal-trader-brief-v4.md` | create | The spec, copied in |
| `research/signal-lab/**` | create | The lab bundle: script, README, results, data CSVs, golden.json |
| `scripts/signal-trader-golden.py` | create | Runs the lab's own code, writes golden.json and cutoffs.json |
| `lib/signal-trader/cutoffs.json` | create (generated) | Train-set decile cutoffs the app trades on |
| `lib/signal-trader/types.ts` | create | `Bar` |
| `lib/signal-trader/lab-data.ts` | create | Read lab CSVs (tests and scripts only) |
| `lib/signal-trader/indicators.ts` | create | Port of `add_features` |
| `lib/signal-trader/signals.ts` | create | Rule names and `fires()` |
| `lib/signal-trader/evaluate.ts` | create | Port of the lab's evaluation + episodes, clustered t, Bonferroni |
| `lib/session-ledger.ts` | modify | `nyInstant`, `marketOpenInstant`; `settleInstant` delegates |
| `lib/signal-trader/config.ts` | create | `ST_CONFIG` |
| `lib/signal-trader/engine.ts` | create | Pure per-session paper engine |
| `lib/signal-trader/grading.ts` | create | Episodes, CIs, time-to-30 for live grades |
| `lib/signal-trader/scan.ts` | create | Features per ticker, session context, in-memory replay |
| `lib/signal-trader/store.ts` | create | Schema + all `st_` table I/O (server-only) |
| `lib/signal-trader/advance.ts` | create | The morning job's orchestration |
| `lib/signal-trader/view.ts` | create | Read model for the page |
| `db/schema.sql` | modify | `st_` tables |
| `app/api/signal-trader/advance/route.ts`, `.../advance/status/route.ts` | create | Cron route + backup-scheduler probe |
| `app/api/signal-trader/pause/route.ts`, `.../close/route.ts` | create | UI actions |
| `app/signal-trader/page.tsx`, `app/signal-trader/controls.tsx` | create | The tab |
| `app/page.tsx`, `app/globals.css` | modify | Nav link, styles |
| `proxy.ts`, `vercel.json`, `.github/workflows/schedule.yml`, `.vercelignore`, `package.json` | modify | Wiring |
| `scripts/signal-trader-advance.ts`, `scripts/signal-trader-parity.ts`, `scripts/signal-trader-revalidate.ts` | create | Dry run, parity + replay check, quarterly re-validation |
| `README.md` | modify | Section for the tab |

---

### Task 0: Branch, spec and research bundle

**Files:**
- Create: `docs/superpowers/specs/2026-10-10-signal-trader-brief-v4.md`, `research/signal-lab/` (from the zip)
- Modify: `.vercelignore`

- [ ] **Step 1: Branch from an up-to-date master**

```bash
git checkout master && git pull --ff-only && git checkout -b feat/signal-trader
```

- [ ] **Step 2: Copy the spec and unpack the bundle**

```bash
cp "/c/Users/mwill/Downloads/SIGNAL-APP-build-brief-v4.md" docs/superpowers/specs/2026-10-10-signal-trader-brief-v4.md
mkdir -p research/signal-lab
unzip -o -q "/c/Users/mwill/Downloads/signal-lab-bundle.zip" -d research/signal-lab
ls research/signal-lab research/signal-lab/data | head -30
```

Expected: `find_best_signal.py`, `README.md`, `results/`, `data/` with 12 CSVs.

- [ ] **Step 3: Keep the bundle out of deployments**

Append to `.vercelignore`:

```
# Research inputs: read by tests and scripts, never by the deployed app.
research
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-10-signal-trader-brief-v4.md docs/superpowers/plans/2026-10-10-signal-trader.md research/signal-lab .vercelignore
git commit -m "Add the Signal Trader spec, plan and the signal-lab research bundle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Golden file from the lab script itself

**Files:**
- Create: `scripts/signal-trader-golden.py`
- Create (generated): `research/signal-lab/golden.json`, `lib/signal-trader/cutoffs.json`

**Interfaces:**
- Produces: `golden.json` = `{ as_of: "2026-10-10", start: "yyyy-mm-dd", tickers: string[], cutoffs: Record<col, {lo, hi}>, check: { vol_spike_10d_test_n: 162 }, firings: Record<rule, Record<ticker, string[]>> }` where rule ∈ `<col>__long` for the 14 continuous columns, plus `vol_spike`, `gap_big`, `breakout_vol`. `cutoffs.json` = `{ as_of, train_frac: 0.7, source: "research/signal-lab", cutoffs: Record<col, {lo, hi}> }`.

- [ ] **Step 1: Write the generator**

```python
#!/usr/bin/env python3
"""
Golden file for the Signal Trader port: what the lab ITSELF says.

Runs the lab's own code (research/signal-lab/find_best_signal.py) on its own
CSVs and writes:
  research/signal-lab/golden.json   every long-rule firing per ticker, plus cutoffs
  lib/signal-trader/cutoffs.json    the train-set decile cutoffs the app trades on

The lab derives its start date from "now" (find_best_signal.py lines 258-259),
so running it on a different day silently changes the sample. AS_OF pins it to
the report's run date. The script exits non-zero unless vol_spike's 10-day
test n equals the report's 162, which proves this replication IS the report.

  python scripts/signal-trader-golden.py
"""
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LAB = os.path.join(ROOT, "research", "signal-lab")
sys.path.insert(0, LAB)
import find_best_signal as lab  # noqa: E402

AS_OF = date(2026, 10, 10)
YEARS, HORIZONS, TRAIN_FRAC = 5, [1, 3, 5, 10, 20], 0.7
TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMD", "META",
           "AMZN", "GOOGL", "JPM", "XOM"]
EXPECTED_VOL_SPIKE_10D_TEST_N = 162


def main():
    start = AS_OF - timedelta(days=int(YEARS * 365.25) + 400)
    data = os.path.join(LAB, "data")
    panel = lab.load_universe(TICKERS, start, AS_OF, "csv", data, data)

    parts = []
    for t, g in panel.groupby("ticker"):
        g = g.sort_values("date").reset_index(drop=True)
        f = lab.add_features(g)
        f["ticker"] = t
        f["date"] = g["date"].values
        f["close"] = g["close"].values
        parts.append(f)
    feats_all = pd.concat(parts, ignore_index=True)

    # The lab's main(), lines 274-292: forward returns, drop the rows the
    # longest horizon cannot score, chronological 70/30 split PER TICKER.
    feats = feats_all.copy()
    for H in HORIZONS:
        feats[f"fwd_{H}"] = feats.groupby("ticker")["close"].transform(
            lambda c, H=H: c.shift(-H) / c - 1)
    feats = feats.dropna(subset=[f"fwd_{HORIZONS[-1]}"]).reset_index(drop=True)
    feats = feats.sort_values(["ticker", "date"]).reset_index(drop=True)
    feats["is_train"] = False
    for t, g in feats.groupby("ticker"):
        cut = int(len(g) * TRAIN_FRAC)
        feats.loc[g.index[np.arange(len(g)) < cut], "is_train"] = True
    tr = feats[feats["is_train"]].reset_index(drop=True)
    te = feats[~feats["is_train"]].reset_index(drop=True)

    cutoffs = {}
    for col in lab.CONTINUOUS:
        x = tr[col].dropna()
        cutoffs[col] = {"lo": float(x.quantile(0.10)), "hi": float(x.quantile(0.90))}

    m = te["vol_spike"].fillna(False).values.astype(bool)
    n = int(lab.dedupe_mask(m, te["ticker"].values, 10).sum())
    if n != EXPECTED_VOL_SPIKE_10D_TEST_N:
        sys.exit(f"vol_spike 10d test n = {n}, expected "
                 f"{EXPECTED_VOL_SPIKE_10D_TEST_N}: the replication is wrong")

    def dates(mask):
        out = {}
        for t, g in feats_all[mask].groupby("ticker"):
            out[t] = [pd.Timestamp(d).strftime("%Y-%m-%d") for d in g["date"]]
        return out

    firings = {}
    for col in lab.CONTINUOUS:
        firings[f"{col}__long"] = dates(feats_all[col].ge(cutoffs[col]["hi"]).fillna(False).values)
    for col in lab.BINARY:
        firings[col] = dates(feats_all[col].fillna(False).values.astype(bool))

    golden = {
        "as_of": AS_OF.isoformat(),
        "start": start.isoformat(),
        "tickers": sorted(TICKERS),
        "cutoffs": cutoffs,
        "check": {"vol_spike_10d_test_n": n},
        "firings": firings,
    }
    with open(os.path.join(LAB, "golden.json"), "w") as f:
        json.dump(golden, f, separators=(",", ":"))
    with open(os.path.join(ROOT, "lib", "signal-trader", "cutoffs.json"), "w") as f:
        json.dump({"as_of": AS_OF.isoformat(), "train_frac": TRAIN_FRAC,
                   "source": "research/signal-lab", "cutoffs": cutoffs}, f, indent=2)
        f.write("\n")
    total = sum(len(v) for r in firings.values() for v in r.values())
    print(f"golden.json: {len(firings)} rules, {total} firings; vol_spike 10d test n = {n}")
    print(f"start {start.isoformat()}  as_of {AS_OF.isoformat()}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

```bash
mkdir -p lib/signal-trader
python scripts/signal-trader-golden.py
```

Expected: `golden.json: 17 rules, <N> firings; vol_spike 10d test n = 162`, and `start 2020-09-08 ...` (or the first trading day on or after it). A non-zero exit means the replication diverged from the report: stop and diagnose.

- [ ] **Step 3: Check sizes**

```bash
ls -la research/signal-lab/golden.json lib/signal-trader/cutoffs.json
```

Expected: golden.json under 1 MB; cutoffs.json about 1–2 KB with 14 entries.

- [ ] **Step 4: Commit**

```bash
git add scripts/signal-trader-golden.py research/signal-lab/golden.json lib/signal-trader/cutoffs.json
git commit -m "Generate the Signal Trader golden file from the lab script itself

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Port the indicators, proven by the golden file

**Files:**
- Create: `lib/signal-trader/types.ts`, `lib/signal-trader/lab-data.ts`, `lib/signal-trader/indicators.ts`, `lib/signal-trader/signals.ts`
- Test: `lib/signal-trader/indicators.test.ts`

**Interfaces:**
- Consumes: `research/signal-lab/golden.json`, `research/signal-lab/data/*.csv`.
- Produces:
  - `types.ts`: `interface Bar { session: string; open: number; high: number; low: number; close: number; volume: number }`
  - `lab-data.ts`: `readLabBars(ticker: string, start: string, end: string): Bar[]`, `LAB_DIR: string`
  - `indicators.ts`: `CONTINUOUS` (14 names), `type Continuous`, `BINARY` (`vol_spike`, `gap_big`, `breakout_vol`), `type Binary`, `interface Features { continuous: Record<Continuous, Float64Array>; binary: Record<Binary, boolean[]> }`, `addFeatures(bars: readonly Bar[]): Features`
  - `signals.ts`: `type LongRule`, `type ShortRule`, `type Rule`, `type Cutoffs = Record<Continuous, {lo: number; hi: number}>`, `LONG_RULES`, `SHORT_RULES`, `fires(rule: Rule, f: Features, i: number, cutoffs: Cutoffs): boolean`

- [ ] **Step 1: Write the types and the lab CSV reader**

```ts
// lib/signal-trader/types.ts
/** One daily bar, oldest-first arrays of these feed every indicator. */
export interface Bar {
  readonly session: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
```

```ts
// lib/signal-trader/lab-data.ts
/**
 * The signal lab's CSVs (research/signal-lab/data), for tests and scripts.
 * Never imported by the app: research/ is excluded from deployments.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "./types";

export const LAB_DIR = join(process.cwd(), "research", "signal-lab");

/** Bars for one ticker with start <= date <= end, oldest first (the lab's load filter). */
export function readLabBars(ticker: string, start: string, end: string): Bar[] {
  const text = readFileSync(join(LAB_DIR, "data", `${ticker}.csv`), "utf8");
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  const at = (name: string) => cols.indexOf(name);
  const [d, o, h, l, c, v] = ["date", "open", "high", "low", "close", "volume"].map(at);
  return lines
    .map((line) => line.split(","))
    .map((x) => ({
      session: x[d].slice(0, 10),
      open: Number(x[o]),
      high: Number(x[h]),
      low: Number(x[l]),
      close: Number(x[c]),
      volume: Number(x[v]),
    }))
    .filter((b) => b.session >= start && b.session <= end)
    .sort((a, b) => a.session.localeCompare(b.session));
}
```

- [ ] **Step 2: Write the failing golden test**

```ts
// lib/signal-trader/indicators.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addFeatures } from "./indicators";
import { LONG_RULES, fires, type Cutoffs } from "./signals";
import { LAB_DIR, readLabBars } from "./lab-data";

interface Golden {
  as_of: string;
  start: string;
  tickers: string[];
  cutoffs: Cutoffs;
  firings: Record<string, Record<string, string[]>>;
}
const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as Golden;

describe("indicators reproduce the lab, firing for firing", () => {
  it("covers every long rule the lab evaluates", () => {
    expect([...LONG_RULES].sort()).toEqual(Object.keys(golden.firings).sort());
  });

  for (const ticker of golden.tickers) {
    it(ticker, () => {
      const bars = readLabBars(ticker, golden.start, golden.as_of);
      const f = addFeatures(bars);
      const problems: string[] = [];
      for (const rule of LONG_RULES) {
        const want = new Set(golden.firings[rule]?.[ticker] ?? []);
        const got = new Set(
          bars.filter((_, i) => fires(rule, f, i, golden.cutoffs)).map((b) => b.session),
        );
        for (const d of got) if (!want.has(d)) problems.push(`${rule} ${d}: port fires, lab does not`);
        for (const d of want) if (!got.has(d)) problems.push(`${rule} ${d}: lab fires, port does not`);
      }
      expect(problems).toEqual([]);
    });
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/signal-trader/indicators.test.ts`
Expected: FAIL, cannot resolve `./indicators`.

- [ ] **Step 4: Write the indicators**

```ts
// lib/signal-trader/indicators.ts
/**
 * The signal lab's indicators, ported from research/signal-lab/
 * find_best_signal.py (rsi, atr_pct, add_features: lines 122-162).
 *
 * pandas' defaults are reproduced exactly, because the cutoffs the app trades
 * on were fit by pandas: a rolling window is NaN until it holds `w` non-NaN
 * values (min_periods = window), standard deviations are sample (ddof = 1),
 * and EWMs use adjust=False. golden.json is the arbiter (indicators.test.ts).
 *
 * The value at index i depends on bars[0..i] only, so computing over the whole
 * history and reading index i carries no look-ahead.
 */
import type { Bar } from "./types";

export const CONTINUOUS = [
  "mom_20", "mom_60", "ma_cross", "rsi_14", "macd_hist", "bb_pctb", "atr_pct",
  "vol_z", "ret_5", "gap", "intraday", "dist_20d_high", "dist_52w_high", "dist_52w_low",
] as const;
export type Continuous = (typeof CONTINUOUS)[number];

export const BINARY = ["vol_spike", "gap_big", "breakout_vol"] as const;
export type Binary = (typeof BINARY)[number];

export interface Features {
  readonly continuous: Readonly<Record<Continuous, Float64Array>>;
  readonly binary: Readonly<Record<Binary, readonly boolean[]>>;
}

const NAN = Number.NaN;

function series(n: number, f: (i: number) => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}

function shift(x: Float64Array, k: number): Float64Array {
  return series(x.length, (i) => (i - k >= 0 ? x[i - k] : NAN));
}

/** pandas rolling(w) with min_periods = w: NaN unless all w values exist. */
function rolling(x: Float64Array, w: number, agg: (win: Float64Array) => number): Float64Array {
  return series(x.length, (i) => {
    if (i < w - 1) return NAN;
    const win = x.subarray(i - w + 1, i + 1);
    for (const v of win) if (Number.isNaN(v)) return NAN;
    return agg(win);
  });
}

function mean(win: Float64Array): number {
  let s = 0;
  for (const v of win) s += v;
  return s / win.length;
}

function std(win: Float64Array): number {
  const m = mean(win);
  let ss = 0;
  for (const v of win) ss += (v - m) ** 2;
  return Math.sqrt(ss / (win.length - 1));
}

function max(win: Float64Array): number {
  let m = -Infinity;
  for (const v of win) if (v > m) m = v;
  return m;
}

function min(win: Float64Array): number {
  let m = Infinity;
  for (const v of win) if (v < m) m = v;
  return m;
}

/**
 * pandas ewm(alpha, adjust=False, min_periods).mean() for a series whose only
 * NaNs are leading: y starts at the first value, then y = (1 - a)·y + a·x.
 */
function ewm(x: Float64Array, alpha: number, minPeriods = 1): Float64Array {
  const out = new Float64Array(x.length).fill(NAN);
  let y = NAN;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isNaN(v)) {
      y = count === 0 ? v : (1 - alpha) * y + alpha * v;
      count++;
    }
    if (count >= Math.max(minPeriods, 1)) out[i] = y;
  }
  return out;
}

/** The lab's `.replace(0, np.nan)` before dividing. */
const nonZero = (x: number) => (x === 0 ? NAN : x);

export function addFeatures(bars: readonly Bar[]): Features {
  const n = bars.length;
  const c = series(n, (i) => bars[i].close);
  const o = series(n, (i) => bars[i].open);
  const h = series(n, (i) => bars[i].high);
  const l = series(n, (i) => bars[i].low);
  const v = series(n, (i) => bars[i].volume);
  const c1 = shift(c, 1);
  const ratio = (a: Float64Array, b: Float64Array) => series(n, (i) => a[i] / b[i] - 1);

  // RSI, Wilder smoothing via ewm(alpha = 1/14, min_periods = 14).
  const d = series(n, (i) => (i === 0 ? NAN : c[i] - c[i - 1]));
  const up = series(n, (i) => (Number.isNaN(d[i]) ? NAN : Math.max(d[i], 0)));
  const down = series(n, (i) => (Number.isNaN(d[i]) ? NAN : -Math.min(d[i], 0)));
  const ag = ewm(up, 1 / 14, 14);
  const al = ewm(down, 1 / 14, 14);

  // MACD: span s means alpha = 2 / (s + 1); no min_periods.
  const ema12 = ewm(c, 2 / 13);
  const ema26 = ewm(c, 2 / 27);
  const macd = series(n, (i) => ema12[i] - ema26[i]);
  const macdSignal = ewm(macd, 2 / 10);

  const mid = rolling(c, 20, mean);
  const sd = rolling(c, 20, std);

  // True range: pandas' row max skips the NaN previous close on the first bar.
  const tr = series(n, (i) =>
    i === 0
      ? h[i] - l[i]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])),
  );
  const atr = ewm(tr, 1 / 14, 14);

  const vMean = rolling(v, 20, mean);
  const vStd = rolling(v, 20, std);

  const continuous: Record<Continuous, Float64Array> = {
    mom_20: ratio(c, shift(c, 20)),
    mom_60: ratio(c, shift(c, 60)),
    ma_cross: ratio(rolling(c, 20, mean), rolling(c, 50, mean)),
    rsi_14: series(n, (i) => 100 - 100 / (1 + ag[i] / nonZero(al[i]))),
    macd_hist: series(n, (i) => (macd[i] - macdSignal[i]) / c[i]),
    bb_pctb: series(n, (i) => (c[i] - (mid[i] - 2 * sd[i])) / (4 * nonZero(sd[i]))),
    atr_pct: series(n, (i) => atr[i] / c[i]),
    vol_z: series(n, (i) => (v[i] - vMean[i]) / nonZero(vStd[i])),
    ret_5: ratio(c, shift(c, 5)),
    gap: ratio(o, c1),
    intraday: ratio(c, o),
    dist_20d_high: ratio(c, rolling(c1, 20, max)),
    dist_52w_high: ratio(c, rolling(c1, 252, max)),
    dist_52w_low: ratio(c, rolling(c1, 252, min)),
  };

  // NaN comparisons are false in JS exactly as in pandas.
  const binary: Record<Binary, boolean[]> = {
    vol_spike: Array.from({ length: n }, (_, i) => continuous.vol_z[i] > 2.0),
    gap_big: Array.from(
      { length: n },
      (_, i) => Math.abs(continuous.gap[i]) > 1.5 * continuous.atr_pct[i],
    ),
    breakout_vol: Array.from(
      { length: n },
      (_, i) => continuous.dist_20d_high[i] >= -0.002 && continuous.vol_z[i] > 1.0,
    ),
  };

  return { continuous, binary };
}
```

- [ ] **Step 5: Write the rules**

```ts
// lib/signal-trader/signals.ts
/**
 * The lab's signal rules (find_best_signal.py lines 300-313): a continuous
 * column fires LONG in its top train decile (>= hi) and SHORT in its bottom
 * decile (<= lo); a binary column fires long when true. NaN never fires.
 */
import { BINARY, CONTINUOUS, type Binary, type Continuous, type Features } from "./indicators";

export type LongRule = `${Continuous}__long` | Binary;
export type ShortRule = `${Continuous}__short`;
export type Rule = LongRule | ShortRule;
export type Cutoffs = Readonly<Record<Continuous, { readonly lo: number; readonly hi: number }>>;

export const LONG_RULES: readonly LongRule[] = [
  ...CONTINUOUS.map((c) => `${c}__long` as const),
  ...BINARY,
];
export const SHORT_RULES: readonly ShortRule[] = CONTINUOUS.map((c) => `${c}__short` as const);

const isBinary = (rule: Rule): rule is Binary => (BINARY as readonly string[]).includes(rule);

export function fires(rule: Rule, f: Features, i: number, cutoffs: Cutoffs): boolean {
  if (isBinary(rule)) return f.binary[rule][i];
  const [col, side] = rule.split("__") as [Continuous, "long" | "short"];
  const x = f.continuous[col][i];
  return side === "long" ? x >= cutoffs[col].hi : x <= cutoffs[col].lo;
}
```

- [ ] **Step 6: Run the golden test**

Run: `npx vitest run lib/signal-trader/indicators.test.ts`
Expected: PASS, 13 tests. If any ticker fails, read every listed mismatch:
- If **every** mismatch is a value within 1e-9 (relative) of its threshold, it is floating-point summation order. Ledger a ruling, and add a tolerance to the test that accepts only those.
- Otherwise the port differs from pandas. Fix the port, never the test.

- [ ] **Step 7: Mutation check**

Temporarily change `std`'s divisor `(win.length - 1)` to `win.length`. Expected: FAIL with mismatches on `vol_z__long`, `vol_spike` and `bb_pctb__long`. Revert, rerun, PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/signal-trader/types.ts lib/signal-trader/lab-data.ts lib/signal-trader/indicators.ts lib/signal-trader/signals.ts lib/signal-trader/indicators.test.ts
git commit -m "Port the signal lab's indicators to TypeScript, matched to its golden file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Port the lab's evaluation, proven by its headline numbers

**Files:**
- Create: `lib/signal-trader/evaluate.ts`
- Test: `lib/signal-trader/evaluate.test.ts`

**Interfaces:**
- Consumes: `addFeatures`, `Features`, `CONTINUOUS` (Task 2); `fires`, `Rule`, `Cutoffs` (Task 2); `readLabBars`, `LAB_DIR` (Task 2).
- Produces:
  - `interface Row { ticker: string; session: string; i: number; fwd: Readonly<Record<number, number>> }`
  - `interface Panel { rows: Row[]; features: Map<string, Features> }`
  - `buildPanel(bars: ReadonlyMap<string, readonly Bar[]>, horizons: readonly number[]): Panel` (drops rows the longest horizon cannot score; rows sorted ticker, then session)
  - `splitPanel(panel: Panel, trainFrac?: number): { train: Row[]; test: Row[] }`
  - `fitCutoffs(train: Row[], features: Map<string, Features>): Cutoffs`
  - `quantile(xs: number[], q: number): number`
  - `dedupe(rows: Row[], mask: boolean[], spacing: number): boolean[]`
  - `interface Stats { n: number; mean: number; hit: number; t: number }`, `stats(xs: number[]): Stats`
  - `ruleFirings(rows: Row[], features: Map<string, Features>, rule: Rule, cutoffs: Cutoffs, H: number): Row[]` (deduped)
  - `interface Clustered { dates: number; episodes: number; tDates: number }`, `clustered(firings: Row[], H: number, calendar: readonly string[]): Clustered`
  - `bonferroniT(nTests: number, alpha?: number): number`
  - `excessMean(firings: Row[], benchmark: ReadonlyMap<string, Readonly<Record<number, number>>>, H: number): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/signal-trader/evaluate.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bonferroniT, buildPanel, clustered, fitCutoffs, quantile, ruleFirings, splitPanel, stats, type Row,
} from "./evaluate";
import { LAB_DIR, readLabBars } from "./lab-data";
import type { Bar } from "./types";

const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as {
  as_of: string; start: string; tickers: string[]; cutoffs: Record<string, { lo: number; hi: number }>;
};
const HORIZONS = [1, 3, 5, 10, 20];

function labPanel() {
  const bars = new Map<string, Bar[]>();
  for (const t of golden.tickers) bars.set(t, readLabBars(t, golden.start, golden.as_of));
  return buildPanel(bars, HORIZONS);
}

describe("the lab's evaluation, reproduced", () => {
  const panel = labPanel();
  const { train, test } = splitPanel(panel);
  const cutoffs = fitCutoffs(train, panel.features);

  it("fits the same decile cutoffs as the lab", () => {
    for (const [col, c] of Object.entries(golden.cutoffs)) {
      expect(cutoffs[col as keyof typeof cutoffs].hi).toBeCloseTo(c.hi, 10);
      expect(cutoffs[col as keyof typeof cutoffs].lo).toBeCloseTo(c.lo, 10);
    }
  });

  it("reproduces the headline: vol_spike, 10 days, test set", () => {
    const s = stats(ruleFirings(test, panel.features, "vol_spike", cutoffs, 10).map((r) => r.fwd[10]));
    expect(s.n).toBe(162);
    expect(s.mean).toBeCloseTo(0.023424082288899868, 12);
    expect(s.hit).toBeCloseTo(0.6234567901234568, 12);
    expect(s.t).toBeCloseTo(3.8722518944992226, 9);
  });

  it("reproduces a decile rule: mom_20 long, 10 days", () => {
    const s = stats(ruleFirings(test, panel.features, "mom_20__long", cutoffs, 10).map((r) => r.fwd[10]));
    expect(s.n).toBe(87);
    expect(s.mean).toBeCloseTo(0.031579718205131765, 12);
  });
});

describe("helpers", () => {
  it("quantile interpolates linearly, like pandas", () => {
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([5], 0.1)).toBe(5);
  });

  it("Bonferroni bar for the lab's 155 tests is about 3.6", () => {
    // 0.05 / (2 * 155) = 1.61e-4 in each tail -> z = 3.597
    expect(bonferroniT(155)).toBeCloseTo(3.6, 1);
  });

  it("clusters same-day firings and counts non-overlapping episodes", () => {
    const cal = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
    const row = (ticker: string, session: string, r: number): Row => ({ ticker, session, i: 0, fwd: { 3: r } });
    // d0: two tickers fire together; d2 overlaps d0's 3-session window; d5 starts a new one.
    const c = clustered(
      [row("A", "d0", 0.02), row("B", "d0", 0.04), row("A", "d2", 0.01), row("C", "d5", -0.01)],
      3,
      cal,
    );
    expect(c.dates).toBe(3);
    expect(c.episodes).toBe(2);
    // date means: d0 .03, d2 .01, d5 -.01 -> mean .01, sd .02, se .02/sqrt(3)
    expect(c.tDates).toBeCloseTo(0.01 / (0.02 / Math.sqrt(3)), 10);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/signal-trader/evaluate.test.ts`
Expected: FAIL, cannot resolve `./evaluate`.

- [ ] **Step 3: Implement**

```ts
// lib/signal-trader/evaluate.ts
/**
 * The lab's evaluation (find_best_signal.py main(), lines 274-332), ported for
 * quarterly re-validation and the tab's Lab section: forward returns per
 * ticker; drop the rows the longest horizon cannot score; chronological 70/30
 * split PER TICKER by row count; decile cutoffs on the pooled train set;
 * occurrences de-duplicated per ticker (spacing = horizon).
 *
 * Plus what the lab does not report, and what its headline overstates:
 * same-day firings across tickers are one observation (clustered t-stat over
 * dates), and overlapping windows across tickers are one episode.
 */
import { addFeatures, CONTINUOUS, type Features } from "./indicators";
import { fires, type Cutoffs, type Rule } from "./signals";
import type { Bar } from "./types";

export interface Row {
  readonly ticker: string;
  readonly session: string;
  /** Index into the ticker's features. */
  readonly i: number;
  readonly fwd: Readonly<Record<number, number>>;
}

export interface Panel {
  readonly rows: Row[];
  readonly features: Map<string, Features>;
}

export function buildPanel(
  bars: ReadonlyMap<string, readonly Bar[]>,
  horizons: readonly number[],
): Panel {
  const maxH = Math.max(...horizons);
  const rows: Row[] = [];
  const features = new Map<string, Features>();
  for (const ticker of [...bars.keys()].sort()) {
    const b = bars.get(ticker) as readonly Bar[];
    const f = addFeatures(b);
    features.set(ticker, f);
    for (let i = 0; i + maxH < b.length; i++) {
      const fwd: Record<number, number> = {};
      for (const H of horizons) fwd[H] = b[i + H].close / b[i].close - 1;
      rows.push({ ticker, session: b[i].session, i, fwd });
    }
  }
  return { rows, features };
}

export function splitPanel(panel: Panel, trainFrac = 0.7): { train: Row[]; test: Row[] } {
  const train: Row[] = [];
  const test: Row[] = [];
  const byTicker = new Map<string, Row[]>();
  for (const r of panel.rows) {
    const list = byTicker.get(r.ticker);
    if (list) list.push(r);
    else byTicker.set(r.ticker, [r]);
  }
  for (const list of byTicker.values()) {
    const cut = Math.floor(list.length * trainFrac);
    list.forEach((r, k) => (k < cut ? train : test).push(r));
  }
  return { train, test };
}

/** pandas' default (linear) quantile. */
export function quantile(xs: number[], q: number): number {
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  return lo + 1 < a.length ? a[lo] + (a[lo + 1] - a[lo]) * (pos - lo) : a[lo];
}

export function fitCutoffs(train: Row[], features: Map<string, Features>): Cutoffs {
  const out = {} as Record<(typeof CONTINUOUS)[number], { lo: number; hi: number }>;
  for (const col of CONTINUOUS) {
    const xs = train
      .map((r) => (features.get(r.ticker) as Features).continuous[col][r.i])
      .filter((x) => !Number.isNaN(x));
    out[col] = { lo: quantile(xs, 0.1), hi: quantile(xs, 0.9) };
  }
  return out;
}

/** The lab's dedupe_mask: keep occurrences >= spacing rows apart per ticker. */
export function dedupe(rows: Row[], mask: boolean[], spacing: number): boolean[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  const last = new Map<string, number>();
  for (let k = 0; k < rows.length; k++) {
    if (!mask[k]) continue;
    const prev = last.get(rows[k].ticker);
    if (prev === undefined || k - prev >= spacing) {
      keep[k] = true;
      last.set(rows[k].ticker, k);
    }
  }
  return keep;
}

export interface Stats {
  readonly n: number;
  readonly mean: number;
  readonly hit: number;
  readonly t: number;
}

export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (n === 0) return { n, mean: Number.NaN, hit: Number.NaN, t: Number.NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const hit = xs.filter((x) => x > 0).length / n;
  if (n < 2) return { n, mean, hit, t: 0 };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, hit, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

export function ruleFirings(
  rows: Row[],
  features: Map<string, Features>,
  rule: Rule,
  cutoffs: Cutoffs,
  H: number,
): Row[] {
  const mask = rows.map((r) => fires(rule, features.get(r.ticker) as Features, r.i, cutoffs));
  const keep = dedupe(rows, mask, H);
  return rows.filter((_, k) => keep[k]);
}

export interface Clustered {
  /** Distinct firing dates. */
  readonly dates: number;
  /** Non-overlapping H-session windows across ALL tickers that contain a firing. */
  readonly episodes: number;
  /** t-stat with each date's mean counted once. */
  readonly tDates: number;
}

export function clustered(firings: Row[], H: number, calendar: readonly string[]): Clustered {
  const byDate = new Map<string, number[]>();
  for (const r of firings) {
    const list = byDate.get(r.session);
    if (list) list.push(r.fwd[H]);
    else byDate.set(r.session, [r.fwd[H]]);
  }
  const dateMeans = [...byDate.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const pos = new Map(calendar.map((d, k) => [d, k]));
  let episodes = 0;
  let windowEnd = -Infinity;
  for (const d of [...byDate.keys()].sort()) {
    const k = pos.get(d) ?? -1;
    if (k >= windowEnd) {
      episodes++;
      windowEnd = k + H;
    }
  }
  return { dates: byDate.size, episodes, tDates: stats(dateMeans).t };
}

/** Peter Acklam's inverse normal CDF; error < 1.2e-9 over (0, 1). */
function invNorm(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -invNorm(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Two-sided critical z for a family-wise alpha spread over nTests. */
export function bonferroniT(nTests: number, alpha = 0.05): number {
  return invNorm(1 - alpha / (2 * Math.max(nTests, 1)));
}

/** Mean of (firing return − benchmark return over the same window); null without benchmark data. */
export function excessMean(
  firings: Row[],
  benchmark: ReadonlyMap<string, Readonly<Record<number, number>>>,
  H: number,
): number | null {
  const xs = firings
    .map((r) => {
      const b = benchmark.get(r.session)?.[H];
      return b === undefined ? null : r.fwd[H] - b;
    })
    .filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/signal-trader/evaluate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation check**

Temporarily replace `Math.floor(list.length * trainFrac)` with `Math.round(...)`. Expected: the headline test fails (n ≠ 162). Revert, PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/signal-trader/evaluate.ts lib/signal-trader/evaluate.test.ts
git commit -m "Port the signal lab's evaluation, reproducing its headline to 12 digits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Market clock and config

**Files:**
- Modify: `lib/session-ledger.ts` (`settleInstant` at ~line 73)
- Modify: `lib/session-ledger.test.ts` (append)
- Create: `lib/signal-trader/config.ts`

**Interfaces:**
- Produces:
  - `nyInstant(session: string, hour: number, minute?: number): Date`, `marketOpenInstant(session: string): Date` in `lib/session-ledger.ts`
  - `config.ts`: `type SignalName = "vol_spike" | "vol_z" | "intraday" | "mom_20" | "bb_pctb"`, `interface SignalSpec { rule: LongRule; window_days: number; expected_move: number; lab_hit: number; label: string }`, `ST_CONFIG`, `type StConfig = typeof ST_CONFIG`, `SIGNAL_NAMES: readonly SignalName[]` (config order = priority).

- [ ] **Step 1: Write the failing clock tests**

Append to `lib/session-ledger.test.ts` (add `marketOpenInstant, nyInstant` to its import from `./session-ledger`):

```ts
describe("marketOpenInstant", () => {
  it("is 09:30 New York: 13:30 UTC in summer, 14:30 UTC in winter", () => {
    expect(marketOpenInstant("2026-07-15").toISOString()).toBe("2026-07-15T13:30:00.000Z");
    expect(marketOpenInstant("2026-12-15").toISOString()).toBe("2026-12-15T14:30:00.000Z");
  });

  it("settleInstant is nyInstant at 18:00", () => {
    expect(settleInstant("2026-07-15").getTime()).toBe(nyInstant("2026-07-15", 18).getTime());
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/session-ledger.test.ts`
Expected: FAIL, `marketOpenInstant is not a function`.

- [ ] **Step 3: Generalise the instant**

In `lib/session-ledger.ts`, replace the body of `settleInstant` with a call to a new `nyInstant`, and add `marketOpenInstant`. Keep the doc comment above `settleInstant`.

```ts
/** The UTC instant of hour:minute New York wall-clock time on `session`. */
export function nyInstant(session: string, hour: number, minute = 0): Date {
  // Guess the instant assuming UTC, read back what New York's wall clock says
  // at that instant, and correct by the difference. One correction is exact
  // for any time away from a DST switch (02:00), and no caller asks for one.
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const guess = new Date(`${session}T${hh}:${mm}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() + (guess.getTime() - wall));
}

/** The UTC instant at which `session` (yyyy-mm-dd) is settled. */
export function settleInstant(session: string, hourNy: number = SETTLE_HOUR_NY): Date {
  return nyInstant(session, hourNy);
}

/** The regular-session open, 09:30 New York. */
export function marketOpenInstant(session: string): Date {
  return nyInstant(session, 9, 30);
}
```

- [ ] **Step 4: Run all session-ledger tests**

Run: `npx vitest run lib/session-ledger.test.ts`
Expected: PASS (existing tests unchanged plus the 2 new ones).

- [ ] **Step 5: Write the config**

Set `live_start` to the newest stored session at the moment you write this file. Find it with:

```bash
npx tsx --env-file=.env.local -e "import('./lib/db.ts').then(async d => console.log((await d.storedTradingSessions())[0]))"
```

If `tsx -e` cannot import, put the same two lines in an `.mts` file under the git-ignored `.superpowers/` folder and run it with `npx tsx --env-file=.env.local <file>`.

```ts
// lib/signal-trader/config.ts
/**
 * Signal Trader configuration. Quarterly re-validation edits this file, not
 * code (spec section 4, rule 5). Long only and stock only (owner decisions,
 * 2026-10-10): options are deferred because qualifying calls cost $16-$51 a
 * share against a $1.50 cap, and the plan's snapshot carries no ask.
 *
 * Signal order is priority: when several fire on one ticker the same day, the
 * first listed is traded and the rest are logged.
 */
import cutoffsFile from "./cutoffs.json";
import type { Cutoffs, LongRule } from "./signals";

export type SignalName = "vol_spike" | "vol_z" | "intraday" | "mom_20" | "bb_pctb";

export interface SignalSpec {
  readonly rule: LongRule;
  readonly window_days: number;
  /** The lab's raw test-set mean forward return over window_days. */
  readonly expected_move: number;
  /** The lab's test-set hit rate. */
  readonly lab_hit: number;
  readonly label: string;
}

export const ST_CONFIG = {
  universe: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMD", "META", "AMZN", "GOOGL", "JPM", "XOM"],
  benchmark: "SPY",
  signals: {
    vol_spike: { rule: "vol_spike", window_days: 10, expected_move: 0.0234, lab_hit: 0.623, label: "Volume spike" },
    vol_z: { rule: "vol_z__long", window_days: 20, expected_move: 0.0304, lab_hit: 0.663, label: "High volume z" },
    intraday: { rule: "intraday__long", window_days: 10, expected_move: 0.0202, lab_hit: 0.592, label: "Strong intraday drift" },
    mom_20: { rule: "mom_20__long", window_days: 10, expected_move: 0.0316, lab_hit: 0.644, label: "20-day momentum" },
    bb_pctb: { rule: "bb_pctb__long", window_days: 3, expected_move: 0.0078, lab_hit: 0.609, label: "Bollinger %B high" },
  } satisfies Record<SignalName, SignalSpec>,
  sizing: { stock_notional: 1000, starting_cash: 100000 },
  exits: { stock_stop: 0.08 },
  grading: { min_episodes: 30 },
  job: {
    max_sessions_per_run: 5,
    /** First session the live system trades; set when the tab shipped. */
    live_start: "YYYY-MM-DD",
  },
  cutoffs: cutoffsFile.cutoffs as Cutoffs,
} as const;

export type StConfig = typeof ST_CONFIG;
export const SIGNAL_NAMES = Object.keys(ST_CONFIG.signals) as SignalName[];
```

Replace `YYYY-MM-DD` with the session printed above.

- [ ] **Step 6: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add lib/session-ledger.ts lib/session-ledger.test.ts lib/signal-trader/config.ts
git commit -m "Add the market-open instant and the Signal Trader config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The paper engine

**Files:**
- Create: `lib/signal-trader/engine.ts`
- Test: `lib/signal-trader/engine.test.ts`

**Interfaces:**
- Consumes: `marketOpenInstant` (Task 4), `ST_CONFIG`, `StConfig`, `SignalName` (Task 4), `Bar` (Task 2).
- Produces (all exported from `engine.ts`):
  - `PendingPick { key; ticker; signal: SignalName; decidedSession; createdAt: string; windowDays; expectedMove }`
  - `OpenPosition { key; ticker; signal; qty; entryPrice; entrySession; stopPrice; sessionsHeld; windowDays; expectedMove; closeRequestedAt: string | null }`
  - `EngineState { cash; paused; pending: readonly PendingPick[]; open: readonly OpenPosition[] }`
  - `ExitReason = "window" | "stop" | "stop_gap" | "manual"`
  - `Fill { key; session; side: "buy" | "sell"; qty; price; note }`
  - `Exit { key; ticker; signal; session; price; reason: ExitReason; realizedReturn; pnl }`
  - `Grade { key; signal; ticker; entrySession; exitSession; realizedReturn; spyReturn: number | null; excessReturn: number | null; hit: boolean; pnl; expectedMove }`
  - `Mark { key; session; price }`, `SignalLog { session; ticker; signal: SignalName; acted: boolean; note }`, `Cancelled { key; note }`
  - `SessionContext { session; now: Date; barOf(ticker, session): Bar | undefined; fired: ReadonlyMap<string, readonly SignalName[]> }`
  - `SessionOutcome { session; fills; opened; exits; grades; marks; newPicks; cancelled; signals; notes: string[]; state: EngineState }`
  - `pickKey(session, ticker, signal): string`, `advanceSession(state, ctx, cfg?): SessionOutcome`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/signal-trader/engine.test.ts
import { describe, expect, it } from "vitest";
import { advanceSession, type EngineState, type PendingPick, type SessionContext } from "./engine";
import type { SignalName } from "./config";
import type { Bar } from "./types";

// Sessions in July 2026: market opens 13:30 UTC.
const S = ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13"];
const EARLY = (s: string) => new Date(`${s}T12:45:00Z`); // before that day's open
const LATE = (s: string) => new Date(`${s}T15:00:00Z`); // after it

type BarSpec = Partial<Bar> & { open: number };
function book(spec: Record<string, Record<string, BarSpec>>) {
  return (ticker: string, session: string): Bar | undefined => {
    const b = spec[ticker]?.[session];
    if (!b) return undefined;
    return { session, high: b.open, low: b.open, close: b.open, volume: 1, ...b };
  };
}

const empty: EngineState = { cash: 100000, paused: false, pending: [], open: [] };

function pick(over: Partial<PendingPick> = {}): PendingPick {
  return {
    key: `${S[0]}:NVDA:vol_spike`,
    ticker: "NVDA",
    signal: "vol_spike",
    decidedSession: S[0],
    createdAt: EARLY(S[1]).toISOString(),
    windowDays: 10,
    expectedMove: 0.0234,
    ...over,
  };
}

function ctx(
  session: string,
  now: Date,
  barOf: SessionContext["barOf"],
  fired: Record<string, SignalName[]> = {},
): SessionContext {
  return { session, now, barOf, fired: new Map(Object.entries(fired)) };
}

describe("fills", () => {
  it("fills a pick decided before the open at that open: $1,000 at $100 is 10 shares", () => {
    const out = advanceSession(
      { ...empty, pending: [pick()] },
      ctx(S[1], LATE(S[1]), book({ NVDA: { [S[1]]: { open: 100, low: 99, close: 101 } } })),
    );
    expect(out.opened).toHaveLength(1);
    expect(out.opened[0]).toMatchObject({ qty: 10, entryPrice: 100, entrySession: S[1], stopPrice: 92 });
    expect(out.state.cash).toBe(99000);
    expect(out.fills[0]).toMatchObject({ side: "buy", qty: 10, price: 100 });
  });

  it("a pick created after the next open waits for the following session", () => {
    const late = pick({ createdAt: LATE(S[1]).toISOString() });
    const bars = book({ NVDA: { [S[1]]: { open: 100 }, [S[2]]: { open: 102 } } });
    const day1 = advanceSession({ ...empty, pending: [late] }, ctx(S[1], LATE(S[2]), bars));
    expect(day1.opened).toHaveLength(0);
    expect(day1.state.pending).toHaveLength(1);
    const day2 = advanceSession(day1.state, ctx(S[2], LATE(S[2]), bars));
    expect(day2.opened[0]).toMatchObject({ entryPrice: 102, entrySession: S[2] });
  });

  it("cancels a pick when cash is below the notional", () => {
    const out = advanceSession(
      { ...empty, cash: 500, pending: [pick()] },
      ctx(S[1], LATE(S[1]), book({ NVDA: { [S[1]]: { open: 100 } } })),
    );
    expect(out.cancelled).toHaveLength(1);
    expect(out.state.pending).toHaveLength(0);
    expect(out.state.cash).toBe(500);
  });

  it("a missing bar leaves the pick pending and the position open", () => {
    const held: EngineState = {
      ...empty,
      pending: [pick({ ticker: "AMD", key: "k-amd" })],
      open: [{ key: "k-nvda", ticker: "NVDA", signal: "vol_spike", qty: 10, entryPrice: 100, entrySession: S[0], stopPrice: 92, sessionsHeld: 1, windowDays: 10, expectedMove: 0.0234, closeRequestedAt: null }],
    };
    const out = advanceSession(held, ctx(S[1], LATE(S[1]), book({})));
    expect(out.state.pending).toHaveLength(1);
    expect(out.state.open).toHaveLength(1);
    expect(out.state.open[0].sessionsHeld).toBe(1);
    expect(out.notes.length).toBe(2);
  });
});

describe("exits, priced to the cent", () => {
  const open = (over = {}) => ({
    key: "k", ticker: "NVDA", signal: "vol_spike" as const, qty: 10, entryPrice: 100,
    entrySession: S[1], stopPrice: 92, sessionsHeld: 1, windowDays: 3, expectedMove: 0.0234,
    closeRequestedAt: null, ...over,
  });

  it("held to the window: exits at the close of the window's last session", () => {
    // sessionsHeld 2 after S[2]; S[3] is the 3rd session -> exit at its close 108.
    const out = advanceSession(
      { ...empty, open: [open({ sessionsHeld: 2 })] },
      ctx(S[3], LATE(S[3]), book({ NVDA: { [S[3]]: { open: 105, low: 104, close: 108 } }, SPY: { [S[1]]: { open: 500 }, [S[3]]: { open: 505, close: 505 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "window", price: 108 });
    expect(out.exits[0].pnl).toBeCloseTo(80.0, 10);
    expect(out.grades[0].realizedReturn).toBeCloseTo(0.08, 12);
    expect(out.grades[0].spyReturn).toBeCloseTo(0.01, 12);
    expect(out.grades[0].excessReturn).toBeCloseTo(0.07, 12);
    expect(out.grades[0].hit).toBe(true);
    expect(out.state.cash).toBeCloseTo(100000 + 1080, 10);
  });

  it("stopped intraday: fills at the stop, -$80.00", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 97, low: 91, close: 95 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "stop", price: 92 });
    expect(out.exits[0].pnl).toBeCloseTo(-80.0, 10);
  });

  it("gapped through the stop: fills at the open, -$100.00", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 90, low: 88, close: 93 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "stop_gap", price: 90 });
    expect(out.exits[0].pnl).toBeCloseTo(-100.0, 10);
    expect(out.grades[0].hit).toBe(false);
  });

  it("manual close requested before the open: exits at that open", () => {
    const out = advanceSession(
      { ...empty, open: [open({ closeRequestedAt: EARLY(S[2]).toISOString() })] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 103, low: 101, close: 104 } } })),
    );
    expect(out.exits[0]).toMatchObject({ reason: "manual", price: 103 });
  });

  it("otherwise marks at the close and counts the session", () => {
    const out = advanceSession(
      { ...empty, open: [open()] },
      ctx(S[2], LATE(S[2]), book({ NVDA: { [S[2]]: { open: 101, low: 100, close: 102 } } })),
    );
    expect(out.exits).toHaveLength(0);
    expect(out.marks[0]).toMatchObject({ key: "k", price: 102 });
    expect(out.state.open[0].sessionsHeld).toBe(2);
  });
});

describe("scan", () => {
  const bars = book({ NVDA: { [S[1]]: { open: 100 } } });

  it("creates one long pick per ticker, the first signal in config order", () => {
    const out = advanceSession(empty, ctx(S[1], LATE(S[1]), bars, { NVDA: ["vol_spike", "vol_z"] }));
    expect(out.newPicks).toHaveLength(1);
    expect(out.newPicks[0]).toMatchObject({ ticker: "NVDA", signal: "vol_spike", decidedSession: S[1], windowDays: 10 });
    expect(out.signals.map((s) => [s.signal, s.acted, s.note])).toEqual([
      ["vol_spike", true, "PAPER pick created"],
      ["vol_z", false, "another signal acted for this ticker"],
    ]);
  });

  it("logs but does not pick a ticker that already has an open pick", () => {
    const out = advanceSession({ ...empty, pending: [pick()] }, ctx(S[0], LATE(S[0]), bars, { NVDA: ["mom_20"] }));
    expect(out.newPicks).toHaveLength(0);
    expect(out.signals[0]).toMatchObject({ acted: false, note: "ticker already has an open pick" });
  });

  it("logs but does not pick while paused", () => {
    const out = advanceSession({ ...empty, paused: true }, ctx(S[1], LATE(S[1]), bars, { NVDA: ["vol_spike"] }));
    expect(out.newPicks).toHaveLength(0);
    expect(out.signals[0]).toMatchObject({ acted: false, note: "auto-trade paused" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/signal-trader/engine.test.ts`
Expected: FAIL, cannot resolve `./engine`.

- [ ] **Step 3: Implement**

```ts
// lib/signal-trader/engine.ts
/**
 * The paper engine: advance paper state by ONE settled session. Pure.
 *
 * Order inside a session matters and mirrors the clock:
 *   1. fill pending picks at this session's open, if decided before it opened;
 *   2. exits and marks on this session's bar (manual close, gap through the
 *      stop, intraday stop, window end), else mark at the close;
 *   3. scan this session's close for new picks, which fill at a LATER open.
 *
 * Long only, stock only, fixed notional. Everything here is paper.
 */
import { marketOpenInstant } from "../session-ledger";
import { ST_CONFIG, type SignalName, type StConfig } from "./config";
import type { Bar } from "./types";

export interface PendingPick {
  readonly key: string;
  readonly ticker: string;
  readonly signal: SignalName;
  readonly decidedSession: string;
  /** When the job created it; decides which open it may fill at. */
  readonly createdAt: string;
  readonly windowDays: number;
  readonly expectedMove: number;
}

export interface OpenPosition {
  readonly key: string;
  readonly ticker: string;
  readonly signal: SignalName;
  readonly qty: number;
  readonly entryPrice: number;
  readonly entrySession: string;
  readonly stopPrice: number;
  /** Sessions processed while open, the entry session included. */
  readonly sessionsHeld: number;
  readonly windowDays: number;
  readonly expectedMove: number;
  readonly closeRequestedAt: string | null;
}

export interface EngineState {
  readonly cash: number;
  readonly paused: boolean;
  readonly pending: readonly PendingPick[];
  readonly open: readonly OpenPosition[];
}

export type ExitReason = "window" | "stop" | "stop_gap" | "manual";

export interface Fill { readonly key: string; readonly session: string; readonly side: "buy" | "sell"; readonly qty: number; readonly price: number; readonly note: string }
export interface Exit { readonly key: string; readonly ticker: string; readonly signal: SignalName; readonly session: string; readonly price: number; readonly reason: ExitReason; readonly realizedReturn: number; readonly pnl: number }
export interface Grade {
  readonly key: string; readonly signal: SignalName; readonly ticker: string;
  readonly entrySession: string; readonly exitSession: string;
  readonly realizedReturn: number; readonly spyReturn: number | null; readonly excessReturn: number | null;
  readonly hit: boolean; readonly pnl: number; readonly expectedMove: number;
}
export interface Mark { readonly key: string; readonly session: string; readonly price: number }
export interface SignalLog { readonly session: string; readonly ticker: string; readonly signal: SignalName; readonly acted: boolean; readonly note: string }
export interface Cancelled { readonly key: string; readonly note: string }

export interface SessionContext {
  readonly session: string;
  readonly now: Date;
  readonly barOf: (ticker: string, session: string) => Bar | undefined;
  /** Signals firing on this session's close, per ticker, in config order. */
  readonly fired: ReadonlyMap<string, readonly SignalName[]>;
}

export interface SessionOutcome {
  readonly session: string;
  readonly fills: Fill[];
  readonly opened: OpenPosition[];
  readonly exits: Exit[];
  readonly grades: Grade[];
  readonly marks: Mark[];
  readonly newPicks: PendingPick[];
  readonly cancelled: Cancelled[];
  readonly signals: SignalLog[];
  readonly notes: string[];
  readonly state: EngineState;
}

export function pickKey(session: string, ticker: string, signal: SignalName): string {
  return `${session}:${ticker}:${signal}`;
}

export function advanceSession(
  state: EngineState,
  ctx: SessionContext,
  cfg: StConfig = ST_CONFIG,
): SessionOutcome {
  const { session, now } = ctx;
  const openAt = marketOpenInstant(session).getTime();
  const fills: Fill[] = [];
  const opened: OpenPosition[] = [];
  const exits: Exit[] = [];
  const grades: Grade[] = [];
  const marks: Mark[] = [];
  const newPicks: PendingPick[] = [];
  const cancelled: Cancelled[] = [];
  const signals: SignalLog[] = [];
  const notes: string[] = [];
  let cash = state.cash;

  // 1. Fills.
  const pending: PendingPick[] = [];
  const open: OpenPosition[] = [...state.open];
  for (const p of state.pending) {
    if (p.decidedSession >= session || Date.parse(p.createdAt) >= openAt) {
      pending.push(p);
      continue;
    }
    const bar = ctx.barOf(p.ticker, session);
    if (!bar) {
      pending.push(p);
      notes.push(`${p.ticker}: no bar for ${session}; ${p.key} stays pending`);
      continue;
    }
    const notional = cfg.sizing.stock_notional;
    if (cash < notional) {
      cancelled.push({ key: p.key, note: `cash ${cash.toFixed(2)} is below the $${notional} notional` });
      continue;
    }
    const qty = notional / bar.open;
    cash -= notional;
    const pos: OpenPosition = {
      key: p.key, ticker: p.ticker, signal: p.signal, qty, entryPrice: bar.open,
      entrySession: session, stopPrice: bar.open * (1 - cfg.exits.stock_stop),
      sessionsHeld: 0, windowDays: p.windowDays, expectedMove: p.expectedMove, closeRequestedAt: null,
    };
    open.push(pos);
    opened.push(pos);
    fills.push({ key: p.key, session, side: "buy", qty, price: bar.open, note: "PAPER buy at the open" });
  }

  // 2. Exits and marks.
  const still: OpenPosition[] = [];
  for (const p of open) {
    const bar = ctx.barOf(p.ticker, session);
    if (!bar) {
      still.push(p);
      notes.push(`${p.ticker}: no bar for ${session}; ${p.key} not marked`);
      continue;
    }
    const held = p.sessionsHeld + 1;
    const enteredBefore = p.entrySession < session;
    let exit: { price: number; reason: ExitReason } | null = null;
    if (enteredBefore && p.closeRequestedAt && Date.parse(p.closeRequestedAt) < openAt) {
      exit = { price: bar.open, reason: "manual" };
    } else if (enteredBefore && bar.open <= p.stopPrice) {
      exit = { price: bar.open, reason: "stop_gap" };
    } else if (bar.low <= p.stopPrice) {
      exit = { price: p.stopPrice, reason: "stop" };
    } else if (held >= p.windowDays) {
      exit = { price: bar.close, reason: "window" };
    }
    if (!exit) {
      still.push({ ...p, sessionsHeld: held });
      marks.push({ key: p.key, session, price: bar.close });
      continue;
    }
    const proceeds = p.qty * exit.price;
    cash += proceeds;
    const pnl = proceeds - p.qty * p.entryPrice;
    const realizedReturn = exit.price / p.entryPrice - 1;
    fills.push({ key: p.key, session, side: "sell", qty: p.qty, price: exit.price, note: `PAPER sell (${exit.reason})` });
    exits.push({ key: p.key, ticker: p.ticker, signal: p.signal, session, price: exit.price, reason: exit.reason, realizedReturn, pnl });
    const spyIn = ctx.barOf(cfg.benchmark, p.entrySession)?.open;
    const spyOut = ctx.barOf(cfg.benchmark, session)?.close;
    const spyReturn = spyIn && spyOut ? spyOut / spyIn - 1 : null;
    grades.push({
      key: p.key, signal: p.signal, ticker: p.ticker, entrySession: p.entrySession, exitSession: session,
      realizedReturn, spyReturn, excessReturn: spyReturn === null ? null : realizedReturn - spyReturn,
      hit: realizedReturn > 0, pnl, expectedMove: p.expectedMove,
    });
  }

  // 3. Scan this close.
  const busy = new Set([...pending.map((p) => p.ticker), ...still.map((p) => p.ticker)]);
  for (const ticker of cfg.universe) {
    let acted = false;
    for (const signal of ctx.fired.get(ticker) ?? []) {
      const note = state.paused
        ? "auto-trade paused"
        : acted
          ? "another signal acted for this ticker"
          : busy.has(ticker)
            ? "ticker already has an open pick"
            : "";
      if (note) {
        signals.push({ session, ticker, signal, acted: false, note });
        continue;
      }
      const spec = cfg.signals[signal];
      const p: PendingPick = {
        key: pickKey(session, ticker, signal), ticker, signal, decidedSession: session,
        createdAt: now.toISOString(), windowDays: spec.window_days, expectedMove: spec.expected_move,
      };
      pending.push(p);
      newPicks.push(p);
      busy.add(ticker);
      acted = true;
      signals.push({ session, ticker, signal, acted: true, note: "PAPER pick created" });
    }
  }

  return {
    session, fills, opened, exits, grades, marks, newPicks, cancelled, signals, notes,
    state: { cash, paused: state.paused, pending, open: still },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/signal-trader/engine.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation checks**

1. Temporarily delete `|| Date.parse(p.createdAt) >= openAt`. Expected: "a pick created after the next open waits" FAILS.
2. Temporarily delete the `stop_gap` branch. Expected: "gapped through the stop" FAILS.

Revert both; PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/signal-trader/engine.ts lib/signal-trader/engine.test.ts
git commit -m "Add the Signal Trader paper engine: fill, exit, mark and scan per session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Grading with honest sample sizes

**Files:**
- Create: `lib/signal-trader/grading.ts`
- Test: `lib/signal-trader/grading.test.ts`

**Interfaces:**
- Consumes: `Grade` (Task 5), `ST_CONFIG`, `StConfig`, `SIGNAL_NAMES`, `SignalName` (Task 4).
- Produces: `interface Interval { lo: number; hi: number }`, `tCrit(df: number): number`, `meanCi(xs: number[]): { mean: number; ci: Interval | null }`, `episodesOf(rows: readonly Grade[], indexOf: (s: string) => number): Grade[][]`, `interface SignalScore { signal; label; picks; episodes; hitRate: number | null; labHit; meanRaw: number | null; ciRaw: Interval | null; meanExcess: number | null; ciExcess: Interval | null; expectedMove; pnl; smallSample: boolean; sessionsTo30: number | null }`, `scoreSignals(rows: readonly Grade[], indexOf: (s: string) => number, nowIndex: number, cfg?: StConfig): SignalScore[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/signal-trader/grading.test.ts
import { describe, expect, it } from "vitest";
import { episodesOf, meanCi, scoreSignals, tCrit } from "./grading";
import type { Grade } from "./engine";

const g = (over: Partial<Grade>): Grade => ({
  key: "k", signal: "vol_spike", ticker: "NVDA", entrySession: "s0", exitSession: "s9",
  realizedReturn: 0.01, spyReturn: 0.005, excessReturn: 0.005, hit: true, pnl: 10, expectedMove: 0.0234,
  ...over,
});
const idx = (s: string) => Number(s.slice(1));

describe("episodes", () => {
  it("merges overlapping windows across tickers into one episode", () => {
    const eps = episodesOf(
      [
        g({ key: "a", entrySession: "s0", exitSession: "s9" }),
        g({ key: "b", ticker: "AMD", entrySession: "s5", exitSession: "s14" }),
        g({ key: "c", ticker: "XOM", entrySession: "s15", exitSession: "s24" }),
      ],
      idx,
    );
    expect(eps.map((e) => e.map((r) => r.key))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("intervals", () => {
  it("uses the t distribution: two points, df 1", () => {
    const { mean, ci } = meanCi([0.01, 0.03]);
    expect(mean).toBeCloseTo(0.02, 12);
    // sd .014142, se .01, t(.975, 1) = 12.706
    expect(ci?.lo).toBeCloseTo(0.02 - 12.706 * 0.01, 10);
    expect(ci?.hi).toBeCloseTo(0.02 + 12.706 * 0.01, 10);
    expect(tCrit(40)).toBe(1.96);
  });

  it("gives no interval below two episodes", () => {
    expect(meanCi([0.01]).ci).toBeNull();
  });
});

describe("scoreSignals", () => {
  it("scores over episodes, warns under 30, and projects the time to 30", () => {
    const rows = [
      g({ key: "a", entrySession: "s0", exitSession: "s9", realizedReturn: 0.02, excessReturn: 0.01 }),
      g({ key: "b", entrySession: "s20", exitSession: "s29", realizedReturn: -0.01, excessReturn: -0.02, hit: false }),
    ];
    const [vol] = scoreSignals(rows, idx, 39);
    expect(vol).toMatchObject({ signal: "vol_spike", picks: 2, episodes: 2, smallSample: true });
    expect(vol.hitRate).toBe(0.5);
    expect(vol.meanRaw).toBeCloseTo(0.005, 12);
    // 2 episodes over 40 sessions -> 28 more at 0.05 a session = 560 sessions.
    expect(vol.sessionsTo30).toBeCloseTo(560, 10);
  });

  it("reports every configured signal, even with no grades", () => {
    const scores = scoreSignals([], idx, 0);
    expect(scores.map((s) => s.signal)).toEqual(["vol_spike", "vol_z", "intraday", "mom_20", "bb_pctb"]);
    expect(scores[0]).toMatchObject({ picks: 0, episodes: 0, hitRate: null, sessionsTo30: null });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/signal-trader/grading.test.ts`
Expected: FAIL, cannot resolve `./grading`.

- [ ] **Step 3: Implement**

```ts
// lib/signal-trader/grading.ts
/**
 * Live grading with honest sample sizes.
 *
 * The lab's 162 volume-spike trades were 34 independent episodes: the twelve
 * tickers move together, so overlapping windows across tickers are one bet.
 * Every interval and warning here counts EPISODES, not picks.
 */
import { SIGNAL_NAMES, ST_CONFIG, type SignalName, type StConfig } from "./config";
import type { Grade } from "./engine";

export interface Interval { readonly lo: number; readonly hi: number }

const T975 = [Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064,
  2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** Two-sided 95% t critical value; normal beyond df 30. */
export function tCrit(df: number): number {
  if (df < 1) return Number.NaN;
  return df <= 30 ? T975[df] : 1.96;
}

export function meanCi(xs: number[]): { mean: number; ci: Interval | null } {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : Number.NaN;
  if (n < 2) return { mean, ci: null };
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const half = tCrit(n - 1) * (sd / Math.sqrt(n));
  return { mean, ci: { lo: mean - half, hi: mean + half } };
}

/** Group grades whose holding windows overlap (any ticker) into episodes. */
export function episodesOf(rows: readonly Grade[], indexOf: (s: string) => number): Grade[][] {
  const sorted = [...rows].sort((a, b) => indexOf(a.entrySession) - indexOf(b.entrySession));
  const out: Grade[][] = [];
  let end = -Infinity;
  for (const r of sorted) {
    if (indexOf(r.entrySession) > end) out.push([r]);
    else out[out.length - 1].push(r);
    end = Math.max(end, indexOf(r.exitSession));
  }
  return out;
}

export interface SignalScore {
  readonly signal: SignalName;
  readonly label: string;
  readonly picks: number;
  readonly episodes: number;
  readonly hitRate: number | null;
  readonly labHit: number;
  readonly meanRaw: number | null;
  readonly ciRaw: Interval | null;
  readonly meanExcess: number | null;
  readonly ciExcess: Interval | null;
  readonly expectedMove: number;
  readonly pnl: number;
  readonly smallSample: boolean;
  /** Sessions until min_episodes at the observed episode rate; null with no history. */
  readonly sessionsTo30: number | null;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function scoreSignals(
  rows: readonly Grade[],
  indexOf: (s: string) => number,
  nowIndex: number,
  cfg: StConfig = ST_CONFIG,
): SignalScore[] {
  const need = cfg.grading.min_episodes;
  return SIGNAL_NAMES.map((signal) => {
    const spec = cfg.signals[signal];
    const rs = rows.filter((r) => r.signal === signal);
    const eps = episodesOf(rs, indexOf);
    const raw = meanCi(eps.map((e) => avg(e.map((r) => r.realizedReturn))));
    const excessEps = eps
      .map((e) => e.filter((r) => r.excessReturn !== null).map((r) => r.excessReturn as number))
      .filter((xs) => xs.length > 0)
      .map(avg);
    const excess = meanCi(excessEps);
    let sessionsTo30: number | null = null;
    if (eps.length >= need) sessionsTo30 = 0;
    else if (eps.length > 0) {
      const span = nowIndex - indexOf(eps[0][0].entrySession) + 1;
      sessionsTo30 = span > 0 ? (need - eps.length) / (eps.length / span) : null;
    }
    return {
      signal,
      label: spec.label,
      picks: rs.length,
      episodes: eps.length,
      hitRate: rs.length ? rs.filter((r) => r.hit).length / rs.length : null,
      labHit: spec.lab_hit,
      meanRaw: eps.length ? raw.mean : null,
      ciRaw: raw.ci,
      meanExcess: excessEps.length ? excess.mean : null,
      ciExcess: excess.ci,
      expectedMove: spec.expected_move,
      pnl: rs.reduce((a, r) => a + r.pnl, 0),
      smallSample: eps.length < need,
      sessionsTo30,
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/signal-trader/grading.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation check**

Temporarily change `if (indexOf(r.entrySession) > end)` to `if (true)`. Expected: "merges overlapping windows" FAILS. Revert, PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/signal-trader/grading.ts lib/signal-trader/grading.test.ts
git commit -m "Grade Signal Trader picks over independent episodes, against SPY

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scan context and in-memory replay

**Files:**
- Create: `lib/signal-trader/scan.ts`
- Test: `lib/signal-trader/scan.test.ts`

**Interfaces:**
- Consumes: `addFeatures`, `Features` (Task 2); `fires` (Task 2); `ST_CONFIG`, `SIGNAL_NAMES`, `SignalName`, `StConfig` (Task 4); `advanceSession`, `EngineState`, `SessionContext`, `SessionOutcome` (Task 5); `settleInstant` (`lib/session-ledger.ts`).
- Produces:
  - `interface Market { bars: Map<string, Bar[]>; features: Map<string, Features>; index: Map<string, Map<string, number>> }`
  - `buildMarket(bars: Map<string, Bar[]>): Market`
  - `signalsFiring(m: Market, ticker: string, session: string, cfg?: StConfig): SignalName[]`
  - `contextFor(m: Market, session: string, now: Date, cfg?: StConfig): SessionContext`
  - `startState(cfg?: StConfig): EngineState`
  - `replay(m: Market, sessions: readonly string[], cfg?: StConfig, nowFor?: (session: string) => Date): { outcomes: SessionOutcome[]; state: EngineState }`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/signal-trader/scan.test.ts
import { describe, expect, it } from "vitest";
import { buildMarket, contextFor, replay, signalsFiring, startState } from "./scan";
import { advanceSession } from "./engine";
import type { Bar } from "./types";

/**
 * 40 sessions of a flat stock with constant volume and one 10x volume day at
 * index 30. Constant volume keeps every other rule quiet: vol_z is NaN while
 * the window has no variance, and flat prices give zero momentum and drift.
 */
function flatWithSpike(ticker: string): Bar[] {
  const out: Bar[] = [];
  const day0 = Date.UTC(2026, 0, 5);
  for (let k = 0; k < 40; k++) {
    const session = new Date(day0 + k * 86400000).toISOString().slice(0, 10);
    const vol = k === 30 ? 10_000_000 : 1_000_000;
    out.push({ session, open: 100, high: 101, low: 99, close: 100, volume: vol });
  }
  return out;
}

const market = () =>
  buildMarket(new Map([["NVDA", flatWithSpike("NVDA")], ["SPY", flatWithSpike("SPY")]]));

describe("scan", () => {
  it("fires vol_spike on the spike day only", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    const fired = days.filter((s) => signalsFiring(m, "NVDA", s).includes("vol_spike"));
    expect(fired).toEqual([days[30]]);
  });

  it("builds a context whose bars are that session's", () => {
    const m = market();
    const s = m.bars.get("NVDA")![12].session;
    const c = contextFor(m, s, new Date());
    expect(c.barOf("NVDA", s)?.session).toBe(s);
    expect(c.barOf("NVDA", "1999-01-01")).toBeUndefined();
  });

  it("catch-up never fills before the run that created the pick", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    // One late run processes the spike day and the next 3 days at once.
    const now = new Date(`${days[34]}T20:00:00Z`);
    let state = startState();
    const opened: string[] = [];
    for (const s of days.slice(30, 34)) {
      const out = advanceSession(state, contextFor(m, s, now));
      opened.push(...out.opened.map((p) => p.entrySession));
      state = out.state;
    }
    expect(opened).toEqual([]);
    expect(state.pending).toHaveLength(2); // NVDA and SPY both spiked
  });

  it("replay fills the spike pick at the next session's open", () => {
    const m = market();
    const days = m.bars.get("NVDA")!.map((b) => b.session);
    const { outcomes } = replay(m, days.slice(25, 40));
    const entries = outcomes.flatMap((o) => o.opened).filter((p) => p.ticker === "NVDA");
    expect(entries.map((p) => p.entrySession)).toEqual([days[31]]);
  });
});
```

The synthetic calendar includes weekends; the engine never inspects weekdays, so this is fine. Replay's default `nowFor` is the decided session's 18:00 ET settle, which precedes the next open.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/signal-trader/scan.test.ts`
Expected: FAIL, cannot resolve `./scan`.

- [ ] **Step 3: Implement**

```ts
// lib/signal-trader/scan.ts
/**
 * From stored bars to the engine's per-session context, and an in-memory
 * replay over history (dry runs, parity checks, tests). Pure.
 *
 * Features are computed once per ticker over its whole history; the value at a
 * session's index uses only bars up to that session.
 */
import { settleInstant } from "../session-ledger";
import { ST_CONFIG, SIGNAL_NAMES, type SignalName, type StConfig } from "./config";
import { advanceSession, type EngineState, type SessionContext, type SessionOutcome } from "./engine";
import { addFeatures, type Features } from "./indicators";
import { fires } from "./signals";
import type { Bar } from "./types";

export interface Market {
  readonly bars: Map<string, Bar[]>;
  readonly features: Map<string, Features>;
  readonly index: Map<string, Map<string, number>>;
}

export function buildMarket(bars: Map<string, Bar[]>): Market {
  const features = new Map<string, Features>();
  const index = new Map<string, Map<string, number>>();
  for (const [ticker, list] of bars) {
    features.set(ticker, addFeatures(list));
    index.set(ticker, new Map(list.map((b, i) => [b.session, i])));
  }
  return { bars, features, index };
}

export function signalsFiring(
  m: Market,
  ticker: string,
  session: string,
  cfg: StConfig = ST_CONFIG,
): SignalName[] {
  const i = m.index.get(ticker)?.get(session);
  const f = m.features.get(ticker);
  if (i === undefined || !f) return [];
  return SIGNAL_NAMES.filter((name) => fires(cfg.signals[name].rule, f, i, cfg.cutoffs));
}

export function contextFor(
  m: Market,
  session: string,
  now: Date,
  cfg: StConfig = ST_CONFIG,
): SessionContext {
  const fired = new Map<string, SignalName[]>();
  for (const ticker of cfg.universe) {
    const names = signalsFiring(m, ticker, session, cfg);
    if (names.length) fired.set(ticker, names);
  }
  return {
    session,
    now,
    fired,
    barOf: (ticker, s) => {
      const i = m.index.get(ticker)?.get(s);
      return i === undefined ? undefined : m.bars.get(ticker)?.[i];
    },
  };
}

export function startState(cfg: StConfig = ST_CONFIG): EngineState {
  return { cash: cfg.sizing.starting_cash, paused: false, pending: [], open: [] };
}

export function replay(
  m: Market,
  sessions: readonly string[],
  cfg: StConfig = ST_CONFIG,
  nowFor: (session: string) => Date = (s) => settleInstant(s),
): { outcomes: SessionOutcome[]; state: EngineState } {
  let state = startState(cfg);
  const outcomes: SessionOutcome[] = [];
  for (const s of sessions) {
    const out = advanceSession(state, contextFor(m, s, nowFor(s), cfg), cfg);
    outcomes.push(out);
    state = out.state;
  }
  return { outcomes, state };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/signal-trader/scan.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/signal-trader/scan.ts lib/signal-trader/scan.test.ts
git commit -m "Build the per-session scan context and an in-memory replay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Persistence, the morning job and its schedule

**Files:**
- Create: `lib/signal-trader/store.ts`, `lib/signal-trader/advance.ts`, `app/api/signal-trader/advance/route.ts`, `app/api/signal-trader/advance/status/route.ts`, `scripts/signal-trader-advance.ts`
- Modify: `db/schema.sql`, `proxy.ts:30`, `vercel.json`, `.github/workflows/schedule.yml`, `package.json`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `store.ts`: `ensureSchema(): Promise<void>`, `loadUniverseBars(tickers: readonly string[]): Promise<Map<string, Bar[]>>`, `storedSessionsAsc(): Promise<string[]>`, `processedSessions(): Promise<Set<string>>`, `loadState(): Promise<EngineState>`, `persistSession(o: SessionOutcome, note: string): Promise<void>`, `setPaused(paused: boolean): Promise<void>`, `requestClose(key: string, now: Date): Promise<"cancelled" | "close_requested" | "not_found">`, `startRun(job: string): Promise<number>`, `finishRun(id: number, status: "ok" | "error", note: string): Promise<void>`, and the read helpers used by Task 10: `readAccount()`, `readPicks(sinceSession: string)`, `readOpenPositions()`, `readLatestMarks()`, `readGrades()`, `readRecentSignals(sinceSession: string)`, `readLastProcessed()`, `readLastRun(job: string)`.
  - `advance.ts`: `backlog(): Promise<{ todo: string[]; latestStored: string | null; lastProcessed: string | null }>`, `runAdvance(opts?: { now?: Date; dryRun?: boolean }): Promise<AdvanceReport>`, `interface AdvanceReport { dryRun: boolean; processed: { session: string; picks: number; fills: number; exits: number; notes: string[] }[]; remaining: number; note: string }`

- [ ] **Step 1: Document the schema**

Append to `db/schema.sql`:

```sql
-- Signal Trader (paper only). Created by lib/signal-trader/store.ts ensureSchema.
-- One row per processed session; the PRIMARY KEY makes a second run for the
-- same session roll back its whole transaction (idempotency).
CREATE TABLE IF NOT EXISTS st_sessions (
  session      DATE PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT
);
CREATE TABLE IF NOT EXISTS st_account (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  cash   DOUBLE PRECISION NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS st_signals (
  session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL,
  acted BOOLEAN NOT NULL, note TEXT,
  PRIMARY KEY (session, ticker, signal)
);
CREATE TABLE IF NOT EXISTS st_picks (
  pick_key TEXT PRIMARY KEY, decided_session DATE NOT NULL, ticker TEXT NOT NULL,
  signal TEXT NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,               -- pending | open | closed | cancelled
  note TEXT
);
CREATE TABLE IF NOT EXISTS st_positions (
  pick_key TEXT PRIMARY KEY REFERENCES st_picks(pick_key), ticker TEXT NOT NULL,
  signal TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL, entry_price DOUBLE PRECISION NOT NULL,
  entry_session DATE NOT NULL, stop_price DOUBLE PRECISION NOT NULL,
  sessions_held INTEGER NOT NULL, window_days INTEGER NOT NULL,
  expected_move DOUBLE PRECISION NOT NULL, close_requested_at TIMESTAMPTZ,
  status TEXT NOT NULL,               -- open | closed
  exit_price DOUBLE PRECISION, exit_session DATE, exit_reason TEXT, realized_return DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS st_fills (
  pick_key TEXT NOT NULL, side TEXT NOT NULL, session DATE NOT NULL,
  qty DOUBLE PRECISION NOT NULL, price DOUBLE PRECISION NOT NULL, note TEXT,
  PRIMARY KEY (pick_key, side)
);
CREATE TABLE IF NOT EXISTS st_marks (
  pick_key TEXT NOT NULL, session DATE NOT NULL, price DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (pick_key, session)
);
CREATE TABLE IF NOT EXISTS st_grades (
  pick_key TEXT PRIMARY KEY, signal TEXT NOT NULL, ticker TEXT NOT NULL,
  entry_session DATE NOT NULL, exit_session DATE NOT NULL,
  realized_return DOUBLE PRECISION NOT NULL, spy_return DOUBLE PRECISION,
  excess_return DOUBLE PRECISION, hit BOOLEAN NOT NULL, pnl DOUBLE PRECISION NOT NULL,
  expected_move DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS st_runs (
  id BIGSERIAL PRIMARY KEY, job TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  status TEXT, note TEXT
);
```

- [ ] **Step 2: Write the store**

```ts
// lib/signal-trader/store.ts
/**
 * Signal Trader persistence. Server-only. Every table is st_-prefixed and
 * created by ensureSchema (mirrors db/schema.sql), like company_health and
 * mail_sends are created by their consumers.
 *
 * persistSession writes one session in ONE transaction whose first statement
 * claims st_sessions(session). A concurrent run for the same session fails
 * that insert and rolls back everything it would have written.
 */
import { neon } from "@neondatabase/serverless";
import { ST_CONFIG } from "./config";
import type { EngineState, Grade, OpenPosition, PendingPick, SessionOutcome } from "./engine";
import type { SignalName } from "./config";
import type { Bar } from "./types";

function client() {
  if (typeof window !== "undefined") throw new Error("lib/signal-trader/store.ts is server-only.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

const n = (x: unknown) => Number(x);

let schemaReady = false;
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = client();
  await sql`CREATE TABLE IF NOT EXISTS st_sessions (session DATE PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS st_account (id INTEGER PRIMARY KEY CHECK (id = 1), cash DOUBLE PRECISION NOT NULL, paused BOOLEAN NOT NULL DEFAULT false)`;
  await sql`CREATE TABLE IF NOT EXISTS st_signals (session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL, acted BOOLEAN NOT NULL, note TEXT, PRIMARY KEY (session, ticker, signal))`;
  await sql`CREATE TABLE IF NOT EXISTS st_picks (pick_key TEXT PRIMARY KEY, decided_session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, note TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS st_positions (pick_key TEXT PRIMARY KEY REFERENCES st_picks(pick_key), ticker TEXT NOT NULL, signal TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL, entry_price DOUBLE PRECISION NOT NULL, entry_session DATE NOT NULL, stop_price DOUBLE PRECISION NOT NULL, sessions_held INTEGER NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL, close_requested_at TIMESTAMPTZ, status TEXT NOT NULL, exit_price DOUBLE PRECISION, exit_session DATE, exit_reason TEXT, realized_return DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS st_fills (pick_key TEXT NOT NULL, side TEXT NOT NULL, session DATE NOT NULL, qty DOUBLE PRECISION NOT NULL, price DOUBLE PRECISION NOT NULL, note TEXT, PRIMARY KEY (pick_key, side))`;
  await sql`CREATE TABLE IF NOT EXISTS st_marks (pick_key TEXT NOT NULL, session DATE NOT NULL, price DOUBLE PRECISION NOT NULL, PRIMARY KEY (pick_key, session))`;
  await sql`CREATE TABLE IF NOT EXISTS st_grades (pick_key TEXT PRIMARY KEY, signal TEXT NOT NULL, ticker TEXT NOT NULL, entry_session DATE NOT NULL, exit_session DATE NOT NULL, realized_return DOUBLE PRECISION NOT NULL, spy_return DOUBLE PRECISION, excess_return DOUBLE PRECISION, hit BOOLEAN NOT NULL, pnl DOUBLE PRECISION NOT NULL, expected_move DOUBLE PRECISION NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS st_runs (id BIGSERIAL PRIMARY KEY, job TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, status TEXT, note TEXT)`;
  await sql`INSERT INTO st_account (id, cash, paused) VALUES (1, ${ST_CONFIG.sizing.starting_cash}, false) ON CONFLICT (id) DO NOTHING`;
  schemaReady = true;
}

/** Bars for the universe over every stored (settled) session, oldest first. */
export async function loadUniverseBars(tickers: readonly string[]): Promise<Map<string, Bar[]>> {
  const sql = client();
  const rows = (await sql`
    SELECT b.ticker, b.session::text AS session, b.open, b.high, b.low, b.close, b.volume
    FROM daily_bars b JOIN stored_sessions s ON s.session = b.session
    WHERE b.ticker = ANY(${[...tickers]}::text[])
      AND b.open IS NOT NULL AND b.high IS NOT NULL AND b.low IS NOT NULL
    ORDER BY b.ticker, b.session
  `) as { ticker: string; session: string; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown }[];
  const out = new Map<string, Bar[]>();
  for (const r of rows) {
    const bar: Bar = { session: r.session, open: n(r.open), high: n(r.high), low: n(r.low), close: n(r.close), volume: n(r.volume) };
    const list = out.get(r.ticker);
    if (list) list.push(bar);
    else out.set(r.ticker, [bar]);
  }
  return out;
}

export async function storedSessionsAsc(): Promise<string[]> {
  const rows = (await client()`SELECT session::text AS session FROM stored_sessions ORDER BY session`) as { session: string }[];
  return rows.map((r) => r.session);
}

export async function processedSessions(): Promise<Set<string>> {
  await ensureSchema();
  const rows = (await client()`SELECT session::text AS session FROM st_sessions`) as { session: string }[];
  return new Set(rows.map((r) => r.session));
}

export async function loadState(): Promise<EngineState> {
  await ensureSchema();
  const sql = client();
  const [acct] = (await sql`SELECT cash, paused FROM st_account WHERE id = 1`) as { cash: unknown; paused: boolean }[];
  const pending = (await sql`
    SELECT pick_key, ticker, signal, decided_session::text AS decided_session, created_at, window_days, expected_move
    FROM st_picks WHERE status = 'pending' ORDER BY decided_session, pick_key
  `) as { pick_key: string; ticker: string; signal: SignalName; decided_session: string; created_at: Date | string; window_days: unknown; expected_move: unknown }[];
  const open = (await sql`
    SELECT pick_key, ticker, signal, qty, entry_price, entry_session::text AS entry_session, stop_price,
           sessions_held, window_days, expected_move, close_requested_at
    FROM st_positions WHERE status = 'open' ORDER BY entry_session, pick_key
  `) as { pick_key: string; ticker: string; signal: SignalName; qty: unknown; entry_price: unknown; entry_session: string; stop_price: unknown; sessions_held: unknown; window_days: unknown; expected_move: unknown; close_requested_at: Date | string | null }[];
  const iso = (d: Date | string) => new Date(d).toISOString();
  return {
    cash: n(acct.cash),
    paused: acct.paused,
    pending: pending.map((p): PendingPick => ({
      key: p.pick_key, ticker: p.ticker, signal: p.signal, decidedSession: p.decided_session,
      createdAt: iso(p.created_at), windowDays: n(p.window_days), expectedMove: n(p.expected_move),
    })),
    open: open.map((p): OpenPosition => ({
      key: p.pick_key, ticker: p.ticker, signal: p.signal, qty: n(p.qty), entryPrice: n(p.entry_price),
      entrySession: p.entry_session, stopPrice: n(p.stop_price), sessionsHeld: n(p.sessions_held),
      windowDays: n(p.window_days), expectedMove: n(p.expected_move),
      closeRequestedAt: p.close_requested_at ? iso(p.close_requested_at) : null,
    })),
  };
}

export async function persistSession(o: SessionOutcome, note: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  const q = [
    // First: claim the session. No ON CONFLICT -- a duplicate run must fail here.
    sql`INSERT INTO st_sessions (session, note) VALUES (${o.session}::date, ${note})`,
    ...o.newPicks.map((p) => sql`
      INSERT INTO st_picks (pick_key, decided_session, ticker, signal, window_days, expected_move, created_at, status)
      VALUES (${p.key}, ${p.decidedSession}::date, ${p.ticker}, ${p.signal}, ${p.windowDays}, ${p.expectedMove}, ${p.createdAt}::timestamptz, 'pending')`),
    ...o.cancelled.map((c) => sql`UPDATE st_picks SET status = 'cancelled', note = ${c.note} WHERE pick_key = ${c.key}`),
    ...o.opened.map((p) => sql`
      INSERT INTO st_positions (pick_key, ticker, signal, qty, entry_price, entry_session, stop_price, sessions_held, window_days, expected_move, status)
      VALUES (${p.key}, ${p.ticker}, ${p.signal}, ${p.qty}, ${p.entryPrice}, ${p.entrySession}::date, ${p.stopPrice}, 0, ${p.windowDays}, ${p.expectedMove}, 'open')`),
    ...o.opened.map((p) => sql`UPDATE st_picks SET status = 'open' WHERE pick_key = ${p.key}`),
    ...o.fills.map((f) => sql`
      INSERT INTO st_fills (pick_key, side, session, qty, price, note)
      VALUES (${f.key}, ${f.side}, ${f.session}::date, ${f.qty}, ${f.price}, ${f.note})`),
    ...o.marks.map((m) => sql`INSERT INTO st_marks (pick_key, session, price) VALUES (${m.key}, ${m.session}::date, ${m.price})`),
    ...o.state.open.map((p) => sql`UPDATE st_positions SET sessions_held = ${p.sessionsHeld} WHERE pick_key = ${p.key}`),
    ...o.exits.map((e) => sql`
      UPDATE st_positions SET status = 'closed', exit_price = ${e.price}, exit_session = ${e.session}::date,
        exit_reason = ${e.reason}, realized_return = ${e.realizedReturn}
      WHERE pick_key = ${e.key}`),
    ...o.exits.map((e) => sql`UPDATE st_picks SET status = 'closed' WHERE pick_key = ${e.key}`),
    ...o.grades.map((g: Grade) => sql`
      INSERT INTO st_grades (pick_key, signal, ticker, entry_session, exit_session, realized_return, spy_return, excess_return, hit, pnl, expected_move)
      VALUES (${g.key}, ${g.signal}, ${g.ticker}, ${g.entrySession}::date, ${g.exitSession}::date, ${g.realizedReturn},
              ${g.spyReturn}, ${g.excessReturn}, ${g.hit}, ${g.pnl}, ${g.expectedMove})`),
    ...o.signals.map((s) => sql`
      INSERT INTO st_signals (session, ticker, signal, acted, note)
      VALUES (${s.session}::date, ${s.ticker}, ${s.signal}, ${s.acted}, ${s.note})`),
    sql`UPDATE st_account SET cash = ${o.state.cash} WHERE id = 1`,
  ];
  await sql.transaction(q);
}

export async function setPaused(paused: boolean): Promise<void> {
  await ensureSchema();
  await client()`UPDATE st_account SET paused = ${paused} WHERE id = 1`;
}

/** Cancel a pick that has not filled; otherwise ask for a close at the next open. */
export async function requestClose(key: string, now: Date): Promise<"cancelled" | "close_requested" | "not_found"> {
  await ensureSchema();
  const sql = client();
  const cancelled = (await sql`
    UPDATE st_picks SET status = 'cancelled', note = 'cancelled by user before it filled'
    WHERE pick_key = ${key} AND status = 'pending' RETURNING pick_key`) as unknown[];
  if (cancelled.length) return "cancelled";
  const flagged = (await sql`
    UPDATE st_positions SET close_requested_at = ${now.toISOString()}::timestamptz
    WHERE pick_key = ${key} AND status = 'open' AND close_requested_at IS NULL RETURNING pick_key`) as unknown[];
  return flagged.length ? "close_requested" : "not_found";
}

export async function startRun(job: string): Promise<number> {
  await ensureSchema();
  const [r] = (await client()`INSERT INTO st_runs (job) VALUES (${job}) RETURNING id`) as { id: unknown }[];
  return n(r.id);
}

export async function finishRun(id: number, status: "ok" | "error", note: string): Promise<void> {
  await client()`UPDATE st_runs SET finished_at = now(), status = ${status}, note = ${note} WHERE id = ${id}`;
}

// ---- Read helpers for the page ----

export async function readAccount(): Promise<{ cash: number; paused: boolean }> {
  await ensureSchema();
  const [a] = (await client()`SELECT cash, paused FROM st_account WHERE id = 1`) as { cash: unknown; paused: boolean }[];
  return { cash: n(a.cash), paused: a.paused };
}

export interface PickRow {
  key: string; decidedSession: string; ticker: string; signal: SignalName; windowDays: number;
  expectedMove: number; status: string; note: string | null; entrySession: string | null; entryPrice: number | null;
}

export async function readPicks(sinceSession: string): Promise<PickRow[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT p.pick_key, p.decided_session::text AS decided_session, p.ticker, p.signal, p.window_days,
           p.expected_move, p.status, p.note, s.entry_session::text AS entry_session, s.entry_price
    FROM st_picks p LEFT JOIN st_positions s ON s.pick_key = p.pick_key
    WHERE p.decided_session >= ${sinceSession}::date
    ORDER BY p.decided_session DESC, p.ticker`) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: r.pick_key as string, decidedSession: r.decided_session as string, ticker: r.ticker as string,
    signal: r.signal as SignalName, windowDays: n(r.window_days), expectedMove: n(r.expected_move),
    status: r.status as string, note: (r.note as string | null) ?? null,
    entrySession: (r.entry_session as string | null) ?? null,
    entryPrice: r.entry_price == null ? null : n(r.entry_price),
  }));
}

export async function readOpenPositions(): Promise<(OpenPosition & { lastMark: number | null; lastMarkSession: string | null })[]> {
  const state = await loadState();
  const marks = await readLatestMarks();
  return state.open.map((p) => ({ ...p, lastMark: marks.get(p.key)?.price ?? null, lastMarkSession: marks.get(p.key)?.session ?? null }));
}

export async function readLatestMarks(): Promise<Map<string, { price: number; session: string }>> {
  await ensureSchema();
  const rows = (await client()`
    SELECT DISTINCT ON (pick_key) pick_key, session::text AS session, price
    FROM st_marks ORDER BY pick_key, session DESC`) as { pick_key: string; session: string; price: unknown }[];
  return new Map(rows.map((r) => [r.pick_key, { price: n(r.price), session: r.session }]));
}

export async function readGrades(): Promise<Grade[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT pick_key, signal, ticker, entry_session::text AS entry_session, exit_session::text AS exit_session,
           realized_return, spy_return, excess_return, hit, pnl, expected_move
    FROM st_grades ORDER BY exit_session DESC`) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: r.pick_key as string, signal: r.signal as SignalName, ticker: r.ticker as string,
    entrySession: r.entry_session as string, exitSession: r.exit_session as string,
    realizedReturn: n(r.realized_return), spyReturn: r.spy_return == null ? null : n(r.spy_return),
    excessReturn: r.excess_return == null ? null : n(r.excess_return), hit: r.hit as boolean,
    pnl: n(r.pnl), expectedMove: n(r.expected_move),
  }));
}

export async function readRecentSignals(sinceSession: string): Promise<{ session: string; ticker: string; signal: SignalName; acted: boolean; note: string }[]> {
  await ensureSchema();
  const rows = (await client()`
    SELECT session::text AS session, ticker, signal, acted, note FROM st_signals
    WHERE session >= ${sinceSession}::date ORDER BY session DESC, ticker`) as { session: string; ticker: string; signal: SignalName; acted: boolean; note: string }[];
  return rows;
}

export async function readLastProcessed(): Promise<string | null> {
  await ensureSchema();
  const [r] = (await client()`SELECT max(session)::text AS s FROM st_sessions`) as { s: string | null }[];
  return r?.s ?? null;
}

export async function readLastRun(job: string): Promise<{ startedAt: string; finishedAt: string | null; status: string | null; note: string | null } | null> {
  await ensureSchema();
  const [r] = (await client()`
    SELECT started_at, finished_at, status, note FROM st_runs WHERE job = ${job}
    ORDER BY started_at DESC LIMIT 1`) as { started_at: Date | string; finished_at: Date | string | null; status: string | null; note: string | null }[];
  if (!r) return null;
  return {
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    status: r.status, note: r.note,
  };
}
```

- [ ] **Step 3: Write the orchestration**

```ts
// lib/signal-trader/advance.ts
/**
 * The morning job: process every settled, unprocessed session on or after
 * live_start, in order, one transaction per session.
 *
 * Completeness is per unit -- "is session s in st_sessions?" -- never "how far
 * did we get". Runs after the 12:00 UTC refresh has stored yesterday's settled
 * bar; a run that finds nothing new does nothing and says so.
 */
import { ST_CONFIG } from "./config";
import { advanceSession } from "./engine";
import { buildMarket, contextFor } from "./scan";
import {
  finishRun, loadState, loadUniverseBars, persistSession, processedSessions, startRun, storedSessionsAsc,
} from "./store";

export interface AdvanceReport {
  readonly dryRun: boolean;
  readonly processed: { session: string; picks: number; fills: number; exits: number; notes: string[] }[];
  readonly remaining: number;
  readonly note: string;
}

export async function backlog(): Promise<{ todo: string[]; latestStored: string | null; lastProcessed: string | null }> {
  const [stored, done] = await Promise.all([storedSessionsAsc(), processedSessions()]);
  const todo = stored.filter((s) => s >= ST_CONFIG.job.live_start && !done.has(s));
  const processed = [...done].sort();
  return { todo, latestStored: stored.at(-1) ?? null, lastProcessed: processed.at(-1) ?? null };
}

export async function runAdvance(opts: { now?: Date; dryRun?: boolean } = {}): Promise<AdvanceReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const runId = dryRun ? null : await startRun("advance");
  try {
    const { todo } = await backlog();
    const batch = todo.slice(0, ST_CONFIG.job.max_sessions_per_run);
    if (batch.length === 0) {
      const report = { dryRun, processed: [], remaining: 0, note: "nothing to do: no settled session is waiting" };
      if (runId !== null) await finishRun(runId, "ok", report.note);
      return report;
    }
    const market = buildMarket(await loadUniverseBars(ST_CONFIG.universe));
    let state = await loadState();
    const processed: AdvanceReport["processed"] = [];
    for (const s of batch) {
      const out = advanceSession(state, contextFor(market, s, now));
      if (!dryRun) await persistSession(out, out.notes.join(" | "));
      processed.push({ session: s, picks: out.newPicks.length, fills: out.fills.length, exits: out.exits.length, notes: out.notes });
      state = out.state;
    }
    const report = {
      dryRun, processed, remaining: todo.length - batch.length,
      note: `processed ${processed.map((p) => p.session).join(", ")}`,
    };
    if (runId !== null) await finishRun(runId, "ok", report.note);
    return report;
  } catch (e) {
    if (runId !== null) await finishRun(runId, "error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
```

- [ ] **Step 4: Read the route-handler guide, then write the routes**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (or the closest file under `03-file-conventions`) before writing.

```ts
// app/api/signal-trader/advance/route.ts
/**
 * POST|GET /api/signal-trader/advance -> the Signal Trader morning job.
 * Cron target (Vercel + GitHub backup). Exempt from Cloudflare Access in
 * proxy.ts; authenticates with CRON_SECRET. Paper only.
 */
import { NextResponse } from "next/server";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { runAdvance } from "@/lib/signal-trader/advance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await runAdvance()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
```

```ts
// app/api/signal-trader/advance/status/route.ts
/**
 * GET /api/signal-trader/advance/status -> is there anything to process?
 * The GitHub backup asks this first and skips on "done":true. Uses the job's
 * own work list (backlog), so the two cannot disagree.
 */
import { NextResponse } from "next/server";
import { cronAuthorised, cronUnauthorisedBody } from "@/lib/cron-auth";
import { backlog } from "@/lib/signal-trader/advance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json(cronUnauthorisedBody(), { status: 401 });
  const b = await backlog();
  return NextResponse.json({ done: b.todo.length === 0, waiting: b.todo, latestStored: b.latestStored, lastProcessed: b.lastProcessed });
}
```

- [ ] **Step 5: Wire the schedule**

`proxy.ts`, line 30:

```ts
const CRON_PATHS = ["/api/refresh", "/api/digest", "/api/signal-trader/advance"];
```

`vercel.json` `crons` array becomes:

```json
[
  { "path": "/api/refresh", "schedule": "0 12 * * 1-5" },
  { "path": "/api/digest", "schedule": "0 13 * * 1-5" },
  { "path": "/api/signal-trader/advance", "schedule": "45 12 * * 1-5" },
  { "path": "/api/signal-trader/advance", "schedule": "15 13 * * 1-5" }
]
```

`.github/workflows/schedule.yml`:
- add `- cron: "45 12 * * 1-5"   # 05:45 Phoenix - signal trader` and `- cron: "15 13 * * 1-5"   # 06:15 Phoenix - signal trader retry` under `schedule:`;
- add `signal-trader` to the `workflow_dispatch` options;
- replace the "Choose endpoint" step's `run:` with:

```bash
if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
  if [ "${{ inputs.task }}" = "signal-trader" ]; then
    echo "path=/api/signal-trader/advance" >> "$GITHUB_OUTPUT"
  else
    echo "path=/api/${{ inputs.task }}" >> "$GITHUB_OUTPUT"
  fi
elif [ "${{ github.event.schedule }}" = "0 12 * * 1-5" ]; then
  echo "path=/api/refresh" >> "$GITHUB_OUTPUT"
elif [ "${{ github.event.schedule }}" = "45 12 * * 1-5" ] || [ "${{ github.event.schedule }}" = "15 13 * * 1-5" ]; then
  echo "path=/api/signal-trader/advance" >> "$GITHUB_OUTPUT"
else
  echo "path=/api/digest" >> "$GITHUB_OUTPUT"
fi
```

- [ ] **Step 6: Dry-run script and npm scripts**

```ts
// scripts/signal-trader-advance.ts
/**
 * Run the Signal Trader morning job by hand.
 *   npm run signal-trader:advance -- --dry-run   # compute, write nothing
 *   npm run signal-trader:advance                # the real thing (same as the cron)
 */
import { runAdvance } from "../lib/signal-trader/advance";

runAdvance({ dryRun: process.argv.includes("--dry-run") })
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

Add to `package.json` scripts:

```json
"signal-trader:advance": "tsx --env-file=.env.local scripts/signal-trader-advance.ts",
```

- [ ] **Step 7: Typecheck, lint, test**

Run: `npm run typecheck && npm test && npm run lint`
Expected: typecheck and tests pass; lint shows only the baseline problems.

- [ ] **Step 8: Dry run against the live database**

Run: `npm run signal-trader:advance -- --dry-run`
Expected: `ensureSchema` creates the `st_` tables (additive) and the account row. The JSON lists `live_start` (and any later stored session) with pick counts, `dryRun: true`. Nothing is written to `st_sessions`. Confirm:

```bash
npx tsx --env-file=.env.local -e "import('@neondatabase/serverless').then(async ({neon}) => console.log(await neon(process.env.DATABASE_URL)\`SELECT count(*) FROM st_sessions\`))"
```

Expected: `count: '0'`.

- [ ] **Step 9: The first real run, then prove idempotency**

Run `npm run signal-trader:advance` twice.
Expected: the first run processes `live_start` (picks created, if any fired). The second reports `nothing to do`. Then rerun the count query: `st_sessions` holds exactly the processed sessions, and `st_picks` has no duplicates (`SELECT pick_key, count(*) FROM st_picks GROUP BY 1 HAVING count(*) > 1` returns no rows).

- [ ] **Step 10: Commit**

```bash
git add db/schema.sql lib/signal-trader/store.ts lib/signal-trader/advance.ts app/api/signal-trader/advance proxy.ts vercel.json .github/workflows/schedule.yml scripts/signal-trader-advance.ts package.json
git commit -m "Persist the Signal Trader per session and run it each morning after the refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Database parity and replay check

**Files:**
- Create: `scripts/signal-trader-parity.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadUniverseBars` (Task 8), `readLabBars`, `LAB_DIR` (Task 2), `buildMarket`, `signalsFiring`, `replay` (Task 7), `ST_CONFIG` (Task 4).

- [ ] **Step 1: Write the script**

```ts
// scripts/signal-trader-parity.ts
/**
 * Spec WS2 parity + WS3 acceptance, as a report (it never fails the build).
 *
 *  1. vol_spike firings on daily_bars vs the lab CSVs over their overlap. Every
 *     disagreement is listed with both volume z-scores so it can be explained
 *     (dividend adjustment, vendor volume).
 *  2. An in-memory replay over the overlap on daily_bars: every pick it makes
 *     must be decided on a session where its signal fired.
 *
 *   npm run signal-trader:parity
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ST_CONFIG } from "../lib/signal-trader/config";
import { LAB_DIR, readLabBars } from "../lib/signal-trader/lab-data";
import { buildMarket, replay, signalsFiring } from "../lib/signal-trader/scan";
import { loadUniverseBars } from "../lib/signal-trader/store";

const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as { start: string; as_of: string };

async function main(): Promise<void> {
  const db = buildMarket(await loadUniverseBars(ST_CONFIG.universe));
  const lab = buildMarket(new Map(ST_CONFIG.universe.map((t) => [t, readLabBars(t, golden.start, golden.as_of)])));

  const dbDays = new Set([...db.index.get("SPY")!.keys()]);
  const overlap = [...lab.index.get("SPY")!.keys()].filter((d) => dbDays.has(d) && d >= "2024-11-19");
  console.log(`overlap ${overlap[0]} .. ${overlap.at(-1)} (${overlap.length} sessions)`);

  let agree = 0;
  const disagree: string[] = [];
  for (const t of ST_CONFIG.universe) {
    for (const d of overlap) {
      const a = signalsFiring(db, t, d).includes("vol_spike");
      const b = signalsFiring(lab, t, d).includes("vol_spike");
      if (a === b) { if (a) agree++; continue; }
      const z = (m: typeof db) => m.features.get(t)!.continuous.vol_z[m.index.get(t)!.get(d)!];
      disagree.push(`${t} ${d}: db ${a ? "fires" : "quiet"} (z ${z(db).toFixed(3)}), lab ${b ? "fires" : "quiet"} (z ${z(lab).toFixed(3)})`);
    }
  }
  console.log(`vol_spike firings agreeing: ${agree}; disagreements: ${disagree.length}`);
  for (const line of disagree) console.log("  " + line);

  const { outcomes } = replay(db, overlap);
  const picks = outcomes.flatMap((o) => o.newPicks);
  const bad = picks.filter((p) => !signalsFiring(db, p.ticker, p.decidedSession).includes(p.signal));
  console.log(`replay: ${picks.length} picks, ${outcomes.flatMap((o) => o.exits).length} exits; picks without a firing signal: ${bad.length}`);
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `package.json`: `"signal-trader:parity": "tsx --env-file=.env.local scripts/signal-trader-parity.ts",`

- [ ] **Step 2: Run it and record the result**

Run: `npm run signal-trader:parity`
Expected: an overlap range, a disagreement count with every case listed, and `picks without a firing signal: 0`. Each disagreement needs an explanation in the delivery notes. A z-score sitting near 2.0 on one side is the expected kind; anything else is investigated before continuing.

- [ ] **Step 3: Commit**

```bash
git add scripts/signal-trader-parity.ts package.json
git commit -m "Add the Signal Trader database parity and replay check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The tab

**Files:**
- Create: `lib/signal-trader/view.ts`, `app/api/signal-trader/pause/route.ts`, `app/api/signal-trader/close/route.ts`, `app/signal-trader/page.tsx`, `app/signal-trader/controls.tsx`
- Modify: `app/page.tsx` (masthead, ~line 88), `app/globals.css` (append)

**Interfaces:**
- Consumes: store read helpers, `setPaused`, `requestClose` (Task 8); `scoreSignals`, `SignalScore` (Task 6); `buildMarket`, `signalsFiring` (Task 7); `buildPanel`, `ruleFirings`, `stats`, `clustered`, `excessMean` (Task 3); `ST_CONFIG`, `SIGNAL_NAMES` (Task 4); `money`, `signClass`, `MISSING` (`lib/format.ts`).
- Produces: `getSignalTraderView(): Promise<SignalTraderView>` and the page.

- [ ] **Step 1: The read model**

```ts
// lib/signal-trader/view.ts
/**
 * Everything the Signal Trader page shows, read once on the server.
 * The Lab section re-runs the ported engine on stored bars with the SHIPPED
 * cutoffs (not refit): do the configured signals still hold up?
 */
import { ST_CONFIG, SIGNAL_NAMES, type SignalName } from "./config";
import { buildPanel, clustered, excessMean, ruleFirings, stats } from "./evaluate";
import { scoreSignals, type SignalScore } from "./grading";
import { buildMarket } from "./scan";
import {
  loadUniverseBars, readAccount, readGrades, readLastProcessed, readLastRun, readOpenPositions, readPicks,
  readRecentSignals, storedSessionsAsc, type PickRow,
} from "./store";

export interface LabRow { signal: SignalName; label: string; window: number; n: number; episodes: number; mean: number; hit: number; tDates: number; excess: number | null; expected: number }

export interface SignalTraderView {
  cash: number; equity: number; paused: boolean;
  latestStored: string | null; lastProcessed: string | null; behind: number;
  lastRun: Awaited<ReturnType<typeof readLastRun>>;
  picks: PickRow[];
  positions: Awaited<ReturnType<typeof readOpenPositions>>;
  sessionsLeft: Record<string, number>;
  scores: SignalScore[];
  lab: LabRow[];
  recentSignals: Awaited<ReturnType<typeof readRecentSignals>>;
}

export async function getSignalTraderView(): Promise<SignalTraderView> {
  const [sessions, account, positions, grades, lastProcessed, lastRun] = await Promise.all([
    storedSessionsAsc(), readAccount(), readOpenPositions(), readGrades(), readLastProcessed(), readLastRun("advance"),
  ]);
  const indexOf = (s: string) => {
    const k = sessions.indexOf(s);
    return k >= 0 ? k : sessions.length;
  };
  const since = sessions[Math.max(0, sessions.length - 30)] ?? ST_CONFIG.job.live_start;
  const [picks, recentSignals] = await Promise.all([readPicks(since), readRecentSignals(since)]);
  const latestStored = sessions.at(-1) ?? null;
  const behind = sessions.filter((s) => s >= ST_CONFIG.job.live_start && (!lastProcessed || s > lastProcessed)).length;

  const equity = account.cash + positions.reduce((a, p) => a + p.qty * (p.lastMark ?? p.entryPrice), 0);
  const sessionsLeft = Object.fromEntries(positions.map((p) => [p.key, Math.max(0, p.windowDays - p.sessionsHeld)]));

  // Lab: shipped cutoffs on every stored session.
  const bars = await loadUniverseBars(ST_CONFIG.universe);
  const market = buildMarket(bars);
  const windows = [...new Set(SIGNAL_NAMES.map((n) => ST_CONFIG.signals[n].window_days))];
  const panel = buildPanel(bars, windows);
  const spy = new Map(panel.rows.filter((r) => r.ticker === ST_CONFIG.benchmark).map((r) => [r.session, r.fwd]));
  const lab: LabRow[] = SIGNAL_NAMES.map((signal) => {
    const spec = ST_CONFIG.signals[signal];
    const H = spec.window_days;
    const f = ruleFirings(panel.rows, market.features, spec.rule, ST_CONFIG.cutoffs, H);
    const s = stats(f.map((r) => r.fwd[H]));
    const c = clustered(f, H, sessions);
    return { signal, label: spec.label, window: H, n: s.n, episodes: c.episodes, mean: s.mean, hit: s.hit, tDates: c.tDates, excess: excessMean(f, spy, H), expected: spec.expected_move };
  });

  return {
    cash: account.cash, equity, paused: account.paused, latestStored, lastProcessed, behind, lastRun,
    picks, positions, sessionsLeft,
    scores: scoreSignals(grades, indexOf, sessions.length - 1),
    lab, recentSignals,
  };
}
```

- [ ] **Step 2: Action routes (behind Cloudflare Access, not cron-exempt)**

```ts
// app/api/signal-trader/pause/route.ts
/** POST { paused: boolean } -> set the global auto-trade pause. Paper only. */
import { NextResponse } from "next/server";
import { setPaused } from "@/lib/signal-trader/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") {
    return NextResponse.json({ error: "Send { paused: true | false }." }, { status: 400 });
  }
  await setPaused(body.paused);
  return NextResponse.json({ paused: body.paused });
}
```

```ts
// app/api/signal-trader/close/route.ts
/**
 * POST { key } -> cancel a pick that has not filled, or close an open paper
 * position at the next open (the decision is made with today's information).
 */
import { NextResponse } from "next/server";
import { requestClose } from "@/lib/signal-trader/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  if (typeof body?.key !== "string" || !body.key) {
    return NextResponse.json({ error: "Send { key: <pick key> }." }, { status: 400 });
  }
  const result = await requestClose(body.key, new Date());
  return NextResponse.json({ result }, { status: result === "not_found" ? 404 : 200 });
}
```

- [ ] **Step 3: Client controls**

Read the client-component guide (`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`).

```tsx
// app/signal-trader/controls.tsx
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
```

- [ ] **Step 4: The page**

```tsx
// app/signal-trader/page.tsx
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
```

- [ ] **Step 5: Nav link and styles**

In `app/page.tsx`, change the masthead's history paragraph (~line 87) to:

```tsx
        <p className="subtitle">
          <Link href="/history" className="tick">Top 10 history →</Link>{" "}
          <Link href="/signal-trader" className="tick">Signal Trader →</Link>
        </p>
```

Append to `app/globals.css`:

```css
/* Signal Trader (app/signal-trader). Reuses masthead, panel, note, empty and
   stale-banner; these rules cover only what is new. */
.st-section { margin-top: 40px; }
.st-section h2 { font-size: 1.05rem; margin: 0 0 6px; }
.st-paper {
  font-size: 0.6rem; letter-spacing: 0.08em; font-weight: 700; color: var(--warm);
  border: 1px solid var(--warm); border-radius: 4px; padding: 1px 4px; vertical-align: middle;
}
.st-stats { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; margin-top: 12px; }
.st-scroll { overflow-x: auto; }
.st-tbl { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.st-tbl th, .st-tbl td { padding: 8px 10px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
.st-tbl thead th { border-top: 0; font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
.st-tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.st-sub { display: block; font-size: 0.7rem; color: var(--muted); }
.st-warn { color: var(--warm); }
.st-control { display: inline-flex; gap: 8px; align-items: center; }
.st-btn {
  min-height: 40px; min-width: 44px; padding: 6px 14px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-size: 0.8rem; cursor: pointer;
}
.st-btn:hover { border-color: var(--cool-mid); }
.st-btn:disabled { opacity: 0.6; cursor: wait; }
.st-btn-warn { border-color: var(--warm); color: var(--warm); }
.st-error { font-size: 0.75rem; color: var(--veto); }
```

- [ ] **Step 6: Typecheck, lint, test**

Run: `npm run typecheck && npm test && npm run lint`
Expected: pass; lint at baseline.

- [ ] **Step 7: Verify in the browser**

Start `npm run dev` in the background. With claude-in-chrome, open `http://localhost:3000/signal-trader` at desktop width and at 390 px width (load it in a 390 px same-origin iframe if the window cannot resize):
1. All four sections render; "PAPER" appears in the title and on every open position.
2. The masthead on `/` shows "Signal Trader →", and it navigates.
3. Pause toggles and survives a reload; resume restores it. Leave it in its original state.
4. If a pending pick exists, Cancel turns it to "Cancelled — cancelled by user before it filled". If there is no pending pick, call the close route for a non-existent key and confirm the 404 message renders.
5. At 390 px: no horizontal page scroll (tables scroll inside their panels), and the buttons are at least 40 px tall.

Take a desktop and a phone screenshot of each section for the delivery notes.

- [ ] **Step 8: Commit**

```bash
git add lib/signal-trader/view.ts app/api/signal-trader/pause app/api/signal-trader/close app/signal-trader app/page.tsx app/globals.css
git commit -m "Add the Signal Trader tab: picks, portfolio, grading and lab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Quarterly re-validation

**Files:**
- Create: `scripts/signal-trader-revalidate.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3's evaluation, `readLabBars` (Task 2), `loadUniverseBars`, `readGrades`, `storedSessionsAsc` (Task 8), `scoreSignals` (Task 6), `LONG_RULES`, `SHORT_RULES` (Task 2).

- [ ] **Step 1: Write the script**

```ts
// scripts/signal-trader-revalidate.ts
/**
 * Quarterly re-validation. PROPOSES config changes; never applies them.
 *
 *   npm run signal-trader:revalidate -- --source lab   # reproduce the lab's headline
 *   npm run signal-trader:revalidate -- --source db    # stored bars + live grades
 *
 * Refits cutoffs on the chosen data's own train set (the lab's method), then
 * reports every long AND short rule at every horizon: n, episodes,
 * date-clustered t against the Bonferroni bar, and excess over SPY. A short
 * rule is flagged only if its CI clears zero AND its clustered t clears the
 * bar (decision 4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ST_CONFIG } from "../lib/signal-trader/config";
import { bonferroniT, buildPanel, clustered, excessMean, fitCutoffs, ruleFirings, splitPanel, stats } from "../lib/signal-trader/evaluate";
import { scoreSignals } from "../lib/signal-trader/grading";
import { LAB_DIR, readLabBars } from "../lib/signal-trader/lab-data";
import { LONG_RULES, SHORT_RULES } from "../lib/signal-trader/signals";
import { loadUniverseBars, readGrades, storedSessionsAsc } from "../lib/signal-trader/store";
import type { Bar } from "../lib/signal-trader/types";

const HORIZONS = [1, 3, 5, 10, 20];

async function main(): Promise<void> {
  const source = process.argv.includes("--source") ? process.argv[process.argv.indexOf("--source") + 1] : "db";
  let bars: Map<string, Bar[]>;
  if (source === "lab") {
    const g = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as { start: string; as_of: string };
    bars = new Map(ST_CONFIG.universe.map((t) => [t, readLabBars(t, g.start, g.as_of)]));
  } else {
    bars = await loadUniverseBars(ST_CONFIG.universe);
  }
  const panel = buildPanel(bars, HORIZONS);
  const { train, test } = splitPanel(panel);
  const cutoffs = fitCutoffs(train, panel.features);
  const calendar = [...new Set(panel.rows.map((r) => r.session))].sort();
  const spy = new Map(test.filter((r) => r.ticker === ST_CONFIG.benchmark).map((r) => [r.session, r.fwd]));
  const rules = [...LONG_RULES, ...SHORT_RULES];
  const bar = bonferroniT(rules.length * HORIZONS.length);
  console.log(`source ${source}; test from ${test.map((r) => r.session).sort()[0]}; ${rules.length * HORIZONS.length} tests; Bonferroni |t| > ${bar.toFixed(2)}`);
  console.log("rule                     H   n    ep   mean     vsSPY    hit   t(raw)  t(dates)");
  for (const rule of rules) {
    for (const H of HORIZONS) {
      const f = ruleFirings(test, panel.features, rule, cutoffs, H);
      if (f.length < 20) continue;
      const s = stats(f.map((r) => r.fwd[H]));
      const c = clustered(f, H, calendar);
      const short = rule.endsWith("__short");
      const ex = excessMean(f, spy, H);
      const flag = short && -s.mean > 0 && -c.tDates > bar ? "  <- short meets decision 4's bar" : "";
      console.log(
        `${rule.padEnd(24)} ${String(H).padStart(2)} ${String(s.n).padStart(4)} ${String(c.episodes).padStart(4)}  ${(s.mean * 100).toFixed(2).padStart(6)}%  ${ex == null ? "   --  " : (ex * 100).toFixed(2).padStart(6) + "%"}  ${(s.hit * 100).toFixed(0).padStart(3)}%  ${s.t.toFixed(2).padStart(6)}  ${c.tDates.toFixed(2).padStart(6)}${flag}`,
      );
    }
  }
  if (source === "db") {
    const sessions = await storedSessionsAsc();
    const scores = scoreSignals(await readGrades(), (s) => sessions.indexOf(s), sessions.length - 1);
    console.log("\nlive grades vs lab expectations:");
    for (const s of scores) {
      console.log(`  ${s.signal.padEnd(10)} picks ${s.picks} episodes ${s.episodes} hit ${s.hitRate == null ? "--" : Math.round(s.hitRate * 100) + "%"} (lab ${Math.round(s.labHit * 100)}%) mean ${s.meanRaw == null ? "--" : (s.meanRaw * 100).toFixed(2) + "%"} (expected ${(s.expectedMove * 100).toFixed(2)}%)`);
    }
  }
  console.log("\nProposals are for a human to apply in lib/signal-trader/config.ts; nothing was changed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `package.json`: `"signal-trader:revalidate": "tsx --env-file=.env.local scripts/signal-trader-revalidate.ts",`

- [ ] **Step 2: Reproduce the lab's headline**

Run: `npm run signal-trader:revalidate -- --source lab`
Expected: the `vol_spike  10` row shows n `162`, mean `2.34%`, hit `62%`, t(raw) `3.87`. A different value means the port drifted; stop and diagnose.

- [ ] **Step 3: Run on stored bars**

Run: `npm run signal-trader:revalidate -- --source db`
Expected: a table over stored bars (a shorter history than the lab's, so the test set is small), plus the live-grade summary.

- [ ] **Step 4: Commit**

```bash
git add scripts/signal-trader-revalidate.ts package.json
git commit -m "Add Signal Trader quarterly re-validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: README and final checks

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Signal Trader" section to the README**

Cover:
- **What it is:** paper only, long only, stock only; options deferred and why.
- **Schedule:** 12:45 UTC with a 13:15 retry; the GitHub backup; the status probe.
- **Fill and exit rules:** next open after the decision; −8% stop, with a gap filling at the open; window close.
- **Grading:** episodes, and returns vs SPY.
- **Config reference:** `lib/signal-trader/config.ts`, and `live_start`.
- **Scripts:** `signal-trader:advance [-- --dry-run]`, `signal-trader:parity`, `signal-trader:revalidate -- --source lab|db`.
- **Golden file:** regenerate with `python scripts/signal-trader-golden.py`. Doing so rewrites `cutoffs.json`, which changes what the app trades.

- [ ] **Step 2: Full check**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: all pass (lint at baseline).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the Signal Trader tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
