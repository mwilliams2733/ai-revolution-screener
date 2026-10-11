# Signal Trader tab — Claude Build Brief v4

**Date:** 2026-10-10 · **Status:** ready to build · **Supersedes:** v3
**Repo:** `C:\Users\mwill\Documents\mwilliams2733\AIRevolution`
(github.com/mwilliams2733/ai-revolution-screener)

## What changed from v3, and why

Every change below was checked against the repo, the live database or the lab
bundle on 2026-10-10. The evidence is quoted so the builder does not re-derive it.

| # | v3 said | v4 says | Evidence |
|---|---|---|---|
| A | Trade both sides: stock shorts + puts | **Long only: stock longs + calls.** Shorts and puts are deferred (owner decision, 2026-10-10). | The lab tested 70 short variants. On the test set all 70 had a positive mean forward return (the stock rose, so the short lost) and none had a CI below zero. `vol_spike` was only ever tested long. |
| B | Scan at 21:30 UTC, mark at 21:35 UTC | **One morning job after the refresh**, before the open. | 21:30 UTC is 17:30 ET in summer. Polygon's daily bar is partial until it settles at 18:00 ET (plan 016; 17 partial sessions were stored and repaired in Sept 2026). Also, today's bar only reaches `daily_bars` when the 12:00 UTC refresh runs the next morning. |
| C | Backfill ~2 years of history (WS1) | **No backfill needed**; assert coverage. | `daily_bars` already holds all 12 tickers for every one of 533 stored sessions (2024-08-23 → 2026-10-08), zero gaps. |
| D | Cross-check the port against lab firings | **Golden file from the lab script itself**, plus a database parity check. | A straightforward re-implementation of `vol_spike` on the lab CSVs gives **185** test trades, not the report's **162**. The lab applies a row filter the README does not describe, so a hand port will not match by accident. |
| E | Grade against the lab's +2.34% | **Grade against SPY over the same window, and count independent episodes.** | SPY itself averaged **+0.64%** per 10 sessions over the test period. The 185 replicated trades fall on 104 distinct dates (8 tickers fired together on 2025-01-27) and in only **34** non-overlapping 10-session episodes. Counting each date once, the t-stat is **2.86**, not 3.87. The report's own multiple-comparison bar is about 3.6. |
| F | Stop fills at the stop price | **A gap through the stop fills at the open.** | A stock that opens below its stop cannot be sold at the stop. |

**What E means for expectations:** the volume-spike edge is promising, not
proven. Live trading is the real test, and at about 1.5 independent episodes a
month it will take roughly 20 months to reach 30. The grading section must say
so rather than imply certainty early.

## 0. Decision log

| # | Question | Decision |
|---|----------|----------|
| 1 | Manual approve vs auto paper-trade? | **Auto paper-trade everything the job emits.** Global pause toggle + per-position manual close in the UI. |
| 2 | Position sizing? | **$1,000 notional per stock pick, $300 premium per options play.** One config value each. |
| 3 | Exit rules? | Hold the full window; stock stop -8% (gap through the stop fills at the open); options exits ±50% of premium or window end. |
| 4 | Long-only or long+short? | **Long only (changed in v4, see A).** Re-enable a short signal only when a quarterly re-run (WS8) finds one whose test CI excludes zero and whose date-clustered t-stat clears the Bonferroni bar. |
| 5 | Standalone app or component? | **A tab in the AI Revolution app**: new route `app/signal-trader/`. |
| 6 | Universe? | **The 12 lab tickers:** SPY, QQQ, AAPL, MSFT, NVDA, TSLA, AMD, META, AMZN, GOOGL, JPM, XOM. Independent of the screener's theme map. |
| 7 | Options premium cap? | **Ask < $1.50/share.** Skip + log the leg if nothing qualifies. |
| 8 | UI/UX bar? | Match the repo's visual system (CSS vars in `app/globals.css`, Space Grotesk / JetBrains Mono). |
| 9 | When do picks appear? | **Each weekday morning, before the open** (new in v4, see B). |

**Sizing reasoning:** fixed notional keeps every pick equally weighted, so
grading compares signals, not bet sizes. $1k on $100k paper = 1% per position.
At about 8 picks a month on 10-day holds, typically 2–4 are open. $300 per
options play (≈2 contracts at the $1.50 cap) is deliberately small; a 50% stop
is $150.

## 1. Objective

Add a **"Signal Trader" tab** that turns the signal-lab research into daily
auto-paper-traded **long** picks (stock, plus a call when one qualifies), then
tracks and grades the results so Marcus can see what happens when the theory is
traded. Research only: **no real money, no broker connection, no order routing.**

**Research basis** (read first): `lab-bundle/` — `find_best_signal.py`,
`results/REPORT.md`, `results/singles.csv`, `README.md`, `data/*.csv`.
Headline: a **volume-spike day** (volume more than 2σ above its 20-day average)
is followed by **+2.34% over 10 trading days** (95% CI +1.26%/+3.47%, n=162, 62%
hit vs 56% base). Read that with section E above: the independent sample is
about 34 episodes, and about a quarter of the move is market drift.
Secondary long signals: top-decile volume z, strong intraday drift, 20-day
momentum, Bollinger %B. Combos added nothing. Note that the best combo's
numbers equal `vol_spike`'s exactly because every volume spike is also a
top-decile volume-z reading. Ship singles.

## 2. Repo facts (verified 2026-10-10)

- **Stack:** Next.js 16 App Router + React 19 + TypeScript + Tailwind v4,
  deployed on **Vercel** (Fluid compute, 300 s default function timeout,
  region `iad1`). Tests: vitest (`*.test.ts` colocated in `lib/`). Typecheck
  `tsc --noEmit`. Read the guide in `node_modules/next/dist/docs/` before
  writing route or page code (AGENTS.md).
- **DB:** Neon Postgres (`us-west-2`) via `@neondatabase/serverless`
  (`lib/db.ts`, server-only). Schema in `db/schema.sql`, everything
  `IF NOT EXISTS`. Single responses are capped at 64 MB.
- **Bars:** `daily_bars(session, ticker, open, high, low, close, volume)`.
  All 12 tickers present for all 533 stored sessions (2024-08-23 →
  2026-10-08), zero gaps. Fetched with `adjusted=true` (split-adjusted). NVDA's
  only recent split (2024-06-10) predates the stored window. The refresh
  repairs split-stranded history (`scripts/refetch-splits.ts`), so a future
  split is handled.
- **Session settlement:** a session counts as finished only after **18:00
  America/New_York** (plan 016). Only sessions in `stored_sessions` are
  settled. Never read a bar for a session that is not stored.
- **Data source:** `lib/polygon.ts` (server-only). Only `/v3/reference/tickers`
  and the grouped daily endpoint return 200 on this plan; financials and
  Benzinga return 403. **Options endpoints are unprobed** (see WS5). Never
  fetch per-ticker histories; everything this tab needs is already in
  `daily_bars`.
- **Scheduling:** both Vercel crons (`vercel.json`) and GitHub Actions
  (`.github/workflows/schedule.yml`) fire every job, and the routes are
  idempotent. The refresh runs at **12:00 UTC** Mon–Fri. The GitHub backup
  fires 24–40 minutes late in practice. Cron routes authenticate with
  `CRON_SECRET` (`lib/cron-auth.ts`) and are exempt from Cloudflare Access in
  `proxy.ts`. Pattern to follow: `app/api/refresh/route.ts`
  (`dynamic = "force-dynamic"`, `maxDuration = 300`, ledger-based backlog).
- **Design system:** CSS vars in `app/globals.css` (`--paper, --ink,
  --surface, --surface-2, --line, --muted, --cool-mid, --cool-strong,
  --warm, --veto, --radius`), fonts via `next/font` in `app/layout.tsx`.
  Components colocated (`app/screen-table.tsx`, `app/market-groups.tsx`).
  No component library.
- **Conventions:** server-only lib modules assert at import; the UI never
  calls Polygon or the DB directly, always through `lib/` from a server
  component or an `app/api/*` route. Loader failures become visible warnings,
  never silent empty results.

## 3. Non-goals

- No brokerage integration, no real orders, no streaming.
- **No short stock and no puts** until WS8 finds evidence (decision 4).
- No new indicators beyond the lab's 14 + 3 until quarterly re-validation.

## 4. Operating rules

1. **Next.js/Vercel/Neon only.** TypeScript throughout. No Python service.
   The one exception is the one-off golden-file generator in WS2, which runs
   the lab script locally and commits its output.
2. **Server-only discipline** per repo convention.
3. **Paper only.** Fills are DB rows. The UI labels every buy and sell "PAPER".
4. **No look-ahead:**
   - Signals use only **settled** sessions (in `stored_sessions`).
   - A pick is decided from the close of session *t* and fills at the open of
     session *t+1*.
   - A pick created **after** the market opened on *t+1* (09:30
     America/New_York, computed with the real zone because of DST) fills at the
     open of *t+2* instead. A pick decided after the open must not fill at it.
   - Exits are evaluated on daily bars.
5. **Config over code:** `lib/signal-trader/config.ts` holds the universe,
   signals, windows, sizing and exits. Quarterly re-runs edit config, not code.
6. **Timezone:** display in America/Phoenix; session logic in
   America/New_York.
7. **Completeness by unit, not by position:** the job asks "is session *s*
   done?" for each session. It never assumes it can resume "from the last
   processed date".

## 5. Workstreams

### WS1 — Data: assert coverage (no backfill)
History is already present (section 2). Add a coverage assertion to the job:
before processing session *s*, every universe ticker must have a bar for *s*.
If one is missing, skip that ticker for *s* and log it to `st_runs`; never
fabricate a bar.
Indicator warmup: the 252-session features (`dist_52w_high`, `dist_52w_low`)
first become valid around **late August 2025** on stored bars (252 sessions
after 2024-08-23). The 20-day features, including `vol_spike`, are valid from
mid-September 2024.

New tables (`st_` prefix), added to `db/schema.sql` with `IF NOT EXISTS` and
accessed through `lib/db.ts` using the existing chunked-insert pattern:
`st_signals(ticker, session, signal_name, strength)`,
`st_picks(id, decided_session, ticker, signal_name, window_days,
expected_move, fill_session, status)`,
`st_positions(id, pick_id, kind, qty, entry_price, entry_session, status,
exit_price, exit_session, exit_reason, realized_return)` — `kind`: `stock` | `call`,
`st_option_legs(position_id, contract_ticker, expiry, strike, delta,
entry_premium, mode, note)` — `mode`: `live` | `approx` | `manual`,
`st_fills(position_id, ts, side, qty, price, note)`,
`st_marks(position_id, session, price, source)`,
`st_grades(pick_id, window_end, realized_return, spy_return, excess_return,
hit, expected_move)`,
`st_account(cash)` (single row, starts 100000),
`st_sessions(session, processed_at, status, note)` — one row per processed
session, the job's ledger,
`st_runs(job, started_at, finished_at, status, note)`.

### WS2 — Signal engine: port the lab to TypeScript
Port `add_features` and the signal rules from `find_best_signal.py` into
`lib/signal-trader/indicators.ts` as pure functions of a bars array. Port only
the **long** sides: the `__long` decile rules plus `vol_spike`, `gap_big` and
`breakout_vol`. Decile cutoffs fit on the lab's train set ship in `config.ts`.

**Golden file (required):**
1. Add `scripts/signal-trader-golden.py`, a thin wrapper that imports the lab
   script, runs it on `lab-bundle/data/*.csv` with its own defaults, and writes
   every test-set firing as `{signal, ticker, date}` to
   `lib/signal-trader/golden.json`. Commit the JSON; the wrapper is a one-off
   and is the only Python in the repo.
2. Before writing any port code, confirm the golden file reproduces the
   report: `vol_spike` 10-day test n must be **162**. A hand re-implementation
   gives 185, so find and port the lab's actual row filter.
3. vitest: the port's firings on the lab CSVs equal the golden file exactly,
   for every signal.

**Database parity check (report, don't fail the build):** run the port on
`daily_bars` for the overlap 2024-11-19 → 2026-09-11 and list every
`vol_spike` firing that differs from the lab CSVs. Yahoo bars are also
dividend-adjusted and the vendors' consolidated volume can differ, so some
disagreement is expected. Every disagreement must be listed and explained in
the delivery notes.

### WS3 — The morning job: advance one session at a time
One route, `app/api/signal-trader/advance/route.ts`, with CRON_SECRET auth and
a `proxy.ts` exemption like `/api/refresh`. It processes each **settled,
unprocessed** session *s* in date order, capped per run (backlog drains over
several runs, like the refresh). For each *s*, in this order:

1. **Fill** pending picks whose fill session is *s*, at the open of *s*.
2. **Exits and marks** for open positions on the bar of *s* (WS4, WS5).
3. **Grade** every pick whose window ended at *s* (section 7).
4. **Scan** signals on the close of *s*. Insert one pick per (ticker, signal)
   with window and expected move from config, **long only**. At most one open
   pick per ticker; extra firings are logged to `st_signals` only. If the
   global pause is on, log the signals and create no picks.
5. Mark *s* done in `st_sessions`.

The whole session is one unit: a second run for the same *s* is a no-op. If
the refresh has not yet stored the latest session, the job does nothing and
says so.

*Acceptance:* a dry run over 2024-11-19 → 2026-09-11 on stored bars produces
`vol_spike` picks on the dates the parity check (WS2) predicts. Running the job
twice for the same session changes nothing.

### WS4 — Paper stock engine (long only)
In `lib/signal-trader/paper.ts`:
- Fill at the open, $1,000 notional (config), fractional shares OK.
- Exit at the close of the window-end session, or at the **-8% stop**,
  checked against the day's low. If the session **opens below the stop**, fill
  at the open, not the stop. Record `exit_reason`: `window` | `stop` |
  `stop_gap` | `manual`.
- Manual close from the UI fills at the next session's open (the decision is
  made with today's information).

*Acceptance:* vitest replay matches hand-computed P&L **to the cent** for a
held-to-window long, a stopped long, and a long whose open gapped through the
stop.

### WS5 — Paper options engine: calls only (probe, then branch)
**Step 1 — probe.** In code, call `/v3/snapshot/options/{underlying}` and
`/v3/reference/options/contracts` once per underlying and log the result. Do
not assume a 200.
- **If 200 (full mode):** per pick, fetch the 30–60 DTE chain; calls with
  delta ≥ 0.60; cheapest with OI ≥ 1000 and day volume ≥ 200; **ask < $1.50**
  or skip and log; whole contracts `floor(300 / (ask × 100))`, minimum 1; fill
  at the ask, else the last trade (record which); exits ±50% of premium or
  window end; daily mark at the last trade. Mode `live`.
- **If 403 (expected, "Options Lite"):** the tab still recommends the play
  (contract spec: delta rule, DTE, $1.50 cap) and Marcus enters the paper fill
  by hand (contract ticker, premium, contracts). Marks use **delta
  approximation** from the underlying's daily move, labelled `approx`:
  `premium_t ≈ premium_entry + delta_entry × (stock_t − stock_entry) × 100`.
  This ignores time decay and volatility changes, so the label is
  mandatory. Exits ±50% are evaluated on approx marks. Mode `approx`/`manual`.
- Either way, **no qualifying contract (or no fill entered) → leg skipped and
  logged**. Expect that often.

*Acceptance:* probe result logged; full-mode math unit-tested; approx mode
labelled in the UI and the DB.

### WS6 — The tab UI (`app/signal-trader/page.tsx`)
Server component fetching through `lib/` (pattern: `app/page.tsx` +
`getScreen()`), client components for interaction (pattern:
`app/use-persisted-state.ts`). Four sections:

1. **Picks:** ticker, signal, window, expected move, fill status (pending →
   filled, with the fill session), options leg + mode tag. Global
   **auto-trade pause toggle**, per-position **manual Close**.
2. **Portfolio:** open positions with entry, latest mark, P&L, sessions left,
   and the armed stop.
3. **Grading:** per signal, for stock and options legs separately:
   - hit rate vs the lab's expectation;
   - mean return vs expectation, **raw and in excess of SPY over the identical
     window**, each with a 95% CI;
   - **n as picks and as independent episodes** (non-overlapping windows across
     all tickers). The CI and the small-n warning use episodes. Show the warning
     below 30 episodes, and show the expected time to reach 30 at the observed
     episode rate.
   Grades are written once at window close and never revised.
4. **Lab:** re-run of the ported engine on stored bars. Do the active signals
   still validate?

Add the nav link in the main masthead next to `/history`. Show the last
processed session from `st_sessions`. Failures surface in the UI, following
the repo convention: silent when current, loud when stale.

*Acceptance:* pick → fill → mark → exit → grade is fully visible without a
terminal.

### WS7 — Schedule
Add to `vercel.json`:
`{ "path": "/api/signal-trader/advance", "schedule": "45 12 * * 1-5" }` and a
retry `{ "path": "/api/signal-trader/advance", "schedule": "15 13 * * 1-5" }`.
Mirror both in `.github/workflows/schedule.yml` as a `signal-trader` task,
following the existing refresh entry. 12:45 UTC is after the 12:00 refresh and
before the earliest open (13:30 UTC in summer, 14:30 UTC in winter). If the
refresh runs late and the job lands after the open, rule 4 moves those fills to
the next session.

### WS8 — Quarterly re-validation
`scripts/signal-trader-revalidate.ts` (tsx, pattern: `scripts/backtest.ts`):
re-run the ported engine's train/test split on stored bars, and compare live
graded results with the lab's expectations. Report, for each signal: n,
episodes, date-clustered t-stat, the Bonferroni bar, and excess over SPY. Test
the short-side variants too, and flag any that would meet decision 4's bar.
**Propose** config changes; never apply them.
*Acceptance:* today it reproduces the golden file's headline numbers.

### WS9 — Visual polish (match the repo, don't invent)
Use the `app/globals.css` vars and the existing fonts; follow the density of
`app/screen-table.tsx`. Dark and light via the existing scheme. Responsive at
phone width (390 px) with no horizontal page scroll; touch-sized pause and
close controls. "PAPER" on every buy and sell. Numbers formatted consistently
(sign, %, 2 dp; approx mode tagged).
*Acceptance:* desktop and phone screenshots of all four sections in the
delivery notes; zero unstyled elements.

## 6. Fill & exit rules (normative)

| # | Rule |
|---|---|
| 1 | Signals use only settled sessions (in `stored_sessions`), from the close of *t*. |
| 2 | Stock fills at the open of *t+1*; if the pick was created after that open, at the open of *t+2*. The options leg references the first chain or probe after the stock fill. |
| 3 | One open pick per ticker; signals firing while it is open are logged only. |
| 4 | Stock exit: close of the window-end session, or the -8% stop on the day's low, filled at the stop, or **at the open if it gapped through**. |
| 5 | Options exit: ±50% of entry premium (day high/low, or approx marks), or window end. |
| 6 | Fixed notional ($1,000 stock / $300 options); whole contracts only. |
| 7 | Grades are written once at window close from `daily_bars`, never revised. |
| 8 | Long only until decision 4's evidence bar is met. |

## 7. Grading methodology

A closed pick gets `realized_return`, `spy_return` over the identical
sessions, `excess_return = realized − spy`, and `hit = realized > 0`.

For each signal, report n (picks), episodes (non-overlapping windows across all
tickers), hit rate vs expectation, mean raw and excess return with a 95% CI
computed over episodes, and paper P&L. Split stock vs options legs, and options
by mode.

**Read with:** the lab's own test sample is about 34 independent episodes, with
a date-clustered t-stat of 2.86 below its Bonferroni bar of about 3.6. A live
result that disagrees with the lab is information, not a bug.

## 8. Done criteria

- [ ] `npm run typecheck` and `test` pass; `lint` adds no new problems (the
      repo has one pre-existing lint error in `app/use-persisted-state.ts`).
- [ ] The golden file reproduces n=162 for `vol_spike` 10-day; the port matches
      the golden file exactly.
- [ ] Database parity report delivered, every disagreement explained.
- [ ] Replay: advance → fill → mark → exit → grade; P&L matches hand
      calculations to the cent (held, stopped, gapped through the stop).
- [ ] Each weekday morning after the advance job, the tab shows picks for that
      day's open; pause and close work from a phone.
- [ ] Options probe logged; full or Lite mode implemented accordingly and
      labelled.
- [ ] README section: setup, schedule, config reference, quarterly job,
      golden-file regeneration. No credentials in the repo; no real-money paths.

## 9. Config (`lib/signal-trader/config.ts`)

```ts
export const ST_CONFIG = {
  universe: ["SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMD","META","AMZN","GOOGL","JPM","XOM"],
  benchmark: "SPY",
  // Long only (decision 4). expected_move is the lab's raw test-set mean.
  signals: {
    vol_spike: { window_days: 10, expected_move: 0.0234 },
    vol_z:     { window_days: 20, expected_move: 0.0304 },
    intraday:  { window_days: 10, expected_move: 0.0202 },
    mom_20:    { window_days: 10, expected_move: 0.0316 },
    bb_pctb:   { window_days: 3,  expected_move: 0.0078 },
  },
  sizing:  { stock_notional: 1000, options_premium: 300, starting_cash: 100000 },
  exits:   { stock_stop: 0.08, options_take: 0.50, options_stop: 0.50 },
  options: { delta_call: 0.60, min_oi: 1000, min_day_volume: 200,
             max_ask: 1.50, dte_min: 30, dte_max: 60 },
  grading: { min_episodes: 30 },
  job:     { max_sessions_per_run: 5 },
};
```

---
*Research basis: lab-bundle/results/REPORT.md (2026-10-10). Measurements in
"What changed from v3" were taken on 2026-10-10 from the lab CSVs and the live
database. Paper trading is research; nothing here places orders or handles real
money.*
