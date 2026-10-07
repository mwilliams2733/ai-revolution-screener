# Market-wide grouped screen — design

Date: 2026-10-07. Status: awaiting review.

## Goal

Rank every liquid US stock (~2,300) under the same tier rules the AI theme uses
today, and show them grouped by theme. The AI book (portfolio weights, the
10-slot Strong Buy limit, alerts, digest) stays exactly as it is.

Why: the hand-written theme list (`lib/theme.ts`, 108 ranked names) plus the
10-slot cap means only 15 distinct names held Strong Buy across 16 live
sessions (2026-08-21..10-06). The user wants to see the whole market.

## Decisions taken

| Question | Decision |
|---|---|
| Grouping | AI theme if listed in `THEME`; otherwise SIC sector |
| Rules for non-AI stocks | Full rules: true MA, hysteresis band, stage, fundamentals, balance sheet |
| Excluded names (CapEx spenders, memory veto) | Ranked and tiered, shown with a badge |
| Strong Buy limit | None in the grouped view; the 10-slot cap and incumbent margin apply to the AI book only |
| Fundamentals source | Stored in the database, filled overnight (approach A) |

## Groups

`groupOf(ticker)` in a new `lib/groups.ts`, pure:

1. In `CAPEX_SPENDERS` → group `AI spenders`, badge `net AI CapEx spender`.
2. In `THEME` → that AI theme, first declared wins (current rule). Members of
   `CROWDING_VETO` keep their theme (`memory_storage`) with badge
   `crowding veto: memory/storage`.
3. Has a SIC sector (`lib/sic.ts` `classify`) → that sector.
4. Otherwise → `Unclassified`.

Each group carries a `kind`: `ai_theme`, `ai_spenders` or `sector`, so the UI can
label AI themes distinctly from industry sectors. Display names for the 12 AI
themes live beside `THEME` (e.g. `optics_networking` → "Optics & networking").

## Pipeline (`lib/screen-service.ts` `computeScreen`)

Today the overlays run on `themed` (108 rows). After this change they run on all
`ranked` rows:

```
ranked (all liquid) ─► true MA ─► hysteresis ─► trend/stage ─► fundamentals ─► balance sheet
                                                                                   │
                                     ┌─────────────────────────────────────────────┤
                                     ▼                                             ▼
                     market rows (no cap, grouped)        book = AI-theme rows, excluding
                                                          spenders and vetoed ─► capStrongBuy(10,
                                                          incumbents) ─► buildPortfolio
```

Both outputs come from the same overlaid rows, so a tier means the same thing in
both places except for the cap. The book is derived by filtering the market
rows, never recomputed separately.

`ScreenPayload` changes:

- `themed` keeps its meaning: the AI book rows, capped. Every current consumer
  (page header, `screen-table.tsx`, refresh snapshot, digest, audit) is
  unchanged.
- `leaders: LeaderRow[]` is replaced by `market: MarketRow[]`. A `MarketRow` is
  the current `LeaderRow` plus `group`, `groupKind`, `badge`, the final `tier`
  (uncapped), and the held-down reasons (stage, gate, health) as short strings.
  It stays trimmed: no volume series, no trend detail.
- `vetoed` stays for the AI book's greyed rows.

### Data loads at full scale

| Load | Today | After | Note |
|---|---|---|---|
| Close history (200d MA) | 108 tickers | ~2,300 | Single query, filtered with `ANY(tickers)` |
| Trend history (252 sessions, H/L/C) | 108 | ~2,300 | Measured unfiltered: 1.64M rows / 14s for 12,567 tickers. Filtered to liquid: estimated ~300k rows, ~17MB |
| Balance sheet | all rows read already | same | `company_health` covers 4,612 tickers |
| Fundamentals | live EDGAR, ≤42 calls | DB table read | See below |

The trend and close loads must be measured at full scale during implementation
(two runs, cold and warm) against the 64MB Neon response cap and the 60s
`/api/screen` limit. If either load exceeds ~32MB, chunk the ticker list.

## Fundamentals storage

New table `company_fundamentals (ticker PK, facts JSONB, fetched_at TIMESTAMPTZ)`,
created idempotently by its consumer, matching `company_health`.

- Stores the `Fundamentals` object `lib/edgar.ts` `fundamentalsFor` returns, or
  a null marker for "no SEC filings", so a foreign issuer is not re-fetched
  nightly.
- The screen reads the table and passes the facts to the unchanged
  `applyFundamentalOverlay`. A name with no stored row is `unverified`, which
  already means "do not demote".
- The in-memory `fundamentalCache` and the live EDGAR fetch in
  `fundamentalsForCandidates` are removed from the request path.
- **Filling:** `scripts/fundamentals.ts` (`npm run fundamentals`) fetches every
  momentum Strong Buy candidate that is missing or older than 7 days. It resumes
  by set difference, never by high-water mark, like `scripts/health.ts`.
- **Top-up:** the refresh route fetches missing or stale candidates within a
  wall-clock budget (start at 60s, tuned after measuring), then stops. Whatever
  is left is picked up the next night. The response reports fetched / remaining
  counts.

## Hysteresis memory for non-book names

`tier_history` stays AI-book only. It has nine readers in `lib/db.ts` plus the
backtest, audit and replay scripts, feeding alerts, turnover stats, cohort,
schedule status and the replay guard. Adding market rows there would make each
of them filter or break.

Instead, new table `market_band_tiers (session DATE, ticker TEXT, band_tier TEXT,
PK(session, ticker))`, written by the refresh for every non-book ranked row,
pruned to the last 10 sessions. `previousMomentumTiers` merges both sources:
book names from `tier_history` (unchanged query), everyone else from
`market_band_tiers` for the same prior session. No other reader changes.

## Page

- AI book section and `screen-table.tsx`: unchanged, first on the page.
- `leaders-table.tsx` is replaced by `market-groups.tsx`:
  - Group summary strip, ordered by median RS, each chip showing count, median
    RS and Strong Buy / Buy / Hold counts. Clicking a chip jumps to the group.
  - One collapsible section per group, rows ranked by RS within the group.
    Columns: ticker, name, tier, RS (with rail), 3M, 12M, vs MA, stage,
    held-down reason, badge.
  - Filters persisted with `usePersistedState`: group kind (AI themes / sectors
    / all), tier, and search. A group with more than 25 rows shows the top 25
    and a "show all" control.
- Verified visually with claude-in-chrome at desktop and phone width.

## Not changing

Alerts, digest, portfolio weights, risk panel, turnover statistics, cohort, the
backtest, the replay script, and the `THEME` contents.

## Tests

Each guard is confirmed by breaking the code it protects and seeing the test fail.

- `groups.test.ts`: spender → `AI spenders`; vetoed → its theme with badge;
  duplicate theme member → first theme; SIC fallback; no SIC → `Unclassified`.
- Cap split: given 30 qualifying AI rows and 30 qualifying non-AI rows, market
  view shows all 60 as Strong Buy, book shows exactly 10, and no spender or
  vetoed name is in the book.
- Book derived from market rows: a row's pre-cap tier is identical in both.
- Fundamentals: no stored row → `unverified`, never `demote`; stale rows are
  selected for fetch, fresh rows are not; resume by set difference picks up a
  gap in the middle, not just the tail.
- `previousMomentumTiers`: book names come from `tier_history`, others from
  `market_band_tiers`; a name in both resolves to `tier_history`.
- Existing `tier_history` readers: the suites for alerts, digest, cohort and
  schedule status pass unchanged.

## Risks

- **Request time.** Overlays over 2,300 rows plus two bigger loads may push a
  cold `/api/screen` toward 60s. Measure before and after; if it is over 40s
  cold, raise `/api/screen` `maxDuration` from 60 to 300 (the refresh and digest
  routes already run at 300).
- **Fundamentals warm-up.** Until the backfill runs, most non-AI Strong Buy
  candidates are `unverified` and keep their momentum tier. The UI shows the
  unverified count in the grouped section header.
- **Balance-sheet staleness.** `company_health` is filled only by the manual
  `npm run health`. That is true today and is not changed here, but more names
  now depend on it.
