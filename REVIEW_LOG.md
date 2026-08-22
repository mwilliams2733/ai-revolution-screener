# Review log

What a structured review found and fixed, so the next pass starts from here
rather than from scratch. Newest first.

Run `npm run audit` to re-check everything below mechanically.

---

## 2026-08-22 — history extended to 500 sessions, tier_history reconstructed

**Storage first.** The 250-session backfill had consumed 487 MB of Neon's
512 MB free tier — 97% — because it stored all ~12,000 tickers per session, of
which ~82% are sub-$5 shells that can never reach the screen. Pruning to names
that cleared the liquidity gate on at least 10 sessions took it to **176 MB**.
The irreplaceable part, the `tickers` table with 6,584 delisted names, is 2 MB
and was untouched.

Extended to **500 sessions** (2024-08-23 → 2026-08-21), storing only tracked
names: 2.34M bars, **379 MB, 74% of the tier**.

**tier_history reconstructed** by replaying the screen against stored bars:
248 sessions, 25,958 rows, in one minute. Validated against the live screen for
the current session: **100 of 104 tiers agree**, and all four differences
reconcile to one cause — the replay omits the fundamental gate (2 demotions),
which frees 2 slots that the top-10 cap refills (2 promotions).

The gate is omitted deliberately: EDGAR returns TODAY's filings, so applying it
to a 2025 session would decide that session with results published months later.
The theme map is also today's, which is survivorship bias in the theme dimension
and cannot be fixed without a versioned map.

### The finding this produced

**Annualised turnover is 1,177%** across 248 sessions — roughly **5 tier changes
per session across ~105 names**, or a name changing tier about every three
weeks. METRICS_SPEC flags anything above 200% as cutoffs "chasing noise rather
than tracking a regime". This is nearly six times that.

The move distribution shows why: Hold→Buy 443 and Buy→Hold 426 are almost
perfectly balanced, as are Strong Buy→Buy 183 and Buy→Strong Buy 182. Names are
not migrating in a direction; they are oscillating across hard percentile
boundaries. That is a property of step-function cutoffs at 55 and 80, not of the
market.

Worth considering: hysteresis (a name must cross further to change tier than to
keep one), or a minimum time-in-tier.

---

## 2026-08-22 (later) — alerts, columns, docs

**Step 8 shipped.** Tier-change alerts over Gmail SMTP, using the app password
already in the environment rather than adding Resend. Verified with one real
test message. Silent on the first run by design: with no baseline every name
reads as "entered", and 104 arrival notices on day one would teach the reader to
ignore the alerts.

Env vars are `ALERT_TO` / `ALERTS_ENABLED`, deliberately NOT the shared
`EMAIL_TO` / `EMAIL_ENABLED` which belong to another project and where
`EMAIL_ENABLED` is false. Inheriting them would have made this app silently
never send.

**Day, week and month changes added.** Day is close against the PREVIOUS CLOSE,
matching every quote screen; close-vs-open is a materially different number
(AXTI: -3.3% day, -6.2% intraday, because it gapped up overnight) and is
reported separately in the expander.

**Sector filter is multi-select**, and `README.md` plus an in-app legend now
document every column.

### Open

- `mlwilliams1236@gmail.com` is in `ALLOWED_EMAILS` and deployed but NOT in the
  Cloudflare Access policy, so it still cannot log in. Browser automation of the
  Zero Trust pages failed repeatedly (screenshot CDP faults); needs a hand edit
  or an API token.
- Mobile layout at 390px remains visually unverified, for the same reason. Five
  fields were just added to each row, so this matters more than it did.

---

## 2026-08-22 — database connected, backfill run

Neon Postgres provisioned. Schema applied, 250 sessions backfilled: **2.98M
bars, 11,906 tickers (6,584 delisted, kept for backtest integrity)**, 7.5
minutes.

### Bug found only once real data existed

**Neon's HTTP driver caps a response at 64MB.** `loadCloseHistory(200)` asked
for 200 sessions across ~12,000 tickers -- 2.4M rows -- and got HTTP 507. The
loader caught it and returned an empty map, so every row fell back to the
five-point proxy while the audit reported "needs the backfill". The backfill had
run. A hard failure was indistinguishable from absent data.

Two fixes: history queries are now scoped to the tickers that need them (only
the ~104 themed rows are ever scored, so fetching 12,000 was ~99% waste), and
loader failures are recorded in `meta.warnings` and asserted by the audit rather
than swallowed.

### The metrics, now that they compute

- **Effective bets: 16.8 by weight, 2.9 correlation-adjusted.** A 19-name book
  is about three independent bets. This is the number the position count could
  never show.
- **LITE/AAOI correlate at 0.85** -- the exact pair METRICS_SPEC predicted.
- **True moving averages changed the tiers**: gate demotions went 3 to 4, and
  `vsMa` moved materially (AEHR 60.7% to 70.6%).
- **Stage 3 and 4 names do NOT cleanly cluster in Hold**: 48 late-stage names,
  only 27 of them Hold. CIEN is Stage 3 (topping) while ranked 9th at RS 96.
  The spec said if they do not cluster, that is a finding. It is one: the tier
  rule reads price-versus-average as one bit and cannot see a rolling-over
  average.
- **Accumulation grades are mostly C and below.** AAOI sits at RS 98 with a
  0.73 up/down ratio and an E grade -- rising on distribution, and correctly
  flagged unconfirmed.

---

## 2026-08-21 — first full review (phases 0-5)

Baseline at start: 98 tests, no database, screen running live off Polygon.
At end: **202 tests**, same live-only state, every finding fixed or recorded.

### Critical

**C1 — the moving average was a five-point proxy with no path to a true MA.**
`computeMaProxy` averaged the current price and four sampled anchors. Reasonable
for the SIGN of a trend, but not a 200-day mean, and `vsMa`, the Buy/Hold
separator, the trend gate in `assignTier` and the colour encoding all inherited
it. There was no branch that would have switched to a real average even with
250 sessions stored.
Fixed in `lib/moving-average.ts`: a real rolling mean, `assignTier` re-run
because the trend gate reads `vsMa`, and `maSource: "proxy"` marked on rows
that fall back. **Still reporting `proxy` for every row** until the backfill
runs.

### High

**H1 — the backfill permanently discarded real trading sessions.**
Grouped-daily answers 200-with-zero-rows for weekends, holidays *and* sessions
that have not happened yet. Both writers collapsed those into
`recordSession(date, 0, false)`. Proven live at 06:33 UTC: the work list
included that Friday, the market had not opened, and the session would have been
buried permanently — `missingSessions` skips anything already in the ledger.
Fixed in `lib/session-ledger.ts`; both writers now take their work list from the
real trading calendar and retry rather than bury. **This had to land before any
backfill ran.**

**H2 — null percentiles rendered as a real zero.** Four sites did `rsPct ?? 0`.
Fixed in `lib/format.ts`; an unmeasured percentile now draws a hatched "not
ranked" track rather than an empty bar.

**H3 — staleness was displayed but never assessed.** Fixed in
`lib/staleness.ts`, measured in trading sessions rather than calendar days so
Monday showing Friday's close is "current" instead of a false alarm.

### Medium

- **M1** `isoDaysAgo` duplicated in three files; now `lib/dates.ts`.
- **M4** cron fetched 3 sessions but looked back only 10, so a long backlog
  could never drain. Window widened to 60.
- **M2** survivorship: the code is correct (`fullUniverse()` fetches
  `active=false`) but has never run. Not fixable without a database.
- **M3** EDGAR is fetched per-ticker on the request path. Belongs in the nightly
  refresh once there is somewhere to cache it.

### UI (phase 4)

Every interactive control was under the 44px touch minimum (tooltip trigger
worst at ~16px); the held-out table had no `<thead>` or caption; there was no
tier filter; sort and filter state died on reload; `--veto` was **2.66:1** and
`--cool-mid` **3.42:1** against the 4.5:1 floor. All fixed. All 14
foreground/background pairs now pass in both themes.

**Not verified:** horizontal scroll at a real 390px viewport. The browser
tooling failed repeatedly (CDP timeouts), so the mobile audit is analytic.
Worth a human check on an actual phone.

### Metrics added (phase 3)

Three families, all pure and unit-tested, all returning `null` until the
backfill supplies history: volume/accumulation, trend template and Weinstein
stage, portfolio risk. **Sector concentration is the one live figure** — it
needs no price history: 19 holdings, HHI 0.145, top three sectors 54.7%.

Schema gap found: the spec assumed daily OHLCV was stored, but `daily_bars`
held only open/close/volume/vwap. The 52-week high and low are intraday
extremes and cannot be derived from closes. Both columns added.

### Things mutation testing caught in the TESTS, not the code

Three times, a test passed under a deliberate bug because the assertion was
loose enough to be true of the bug:

- `expect([3, "Transitional"]).toContain(stage)` — accepted either, pinned
  neither. `Transitional` was never exercised once.
- `expect(mean).toBeLessThan(0.9)` — true whether or not the correlation
  diagonal was included.
- LITE at the 99th percentile **does not** catch a broken rank-then-filter.
  Verified by reordering the pipeline: LITE stayed at 99, because a name at the
  top of the universe is also top of any subset containing it. The audit now
  asserts `universeSize > themed * 3` structurally instead.

All three are now exact assertions that fail their mutation.

### Known and accepted, not defects

- Ten Strong Buys at 7.43% each is a **74.3% sleeve**, not the published 52%,
  and `buildPortfolio` still builds 7/7/5 from `nStrong = 7`. Decided
  deliberately: the tier badge is a signal grade, not a position size.
- The fixture match rate is unchanged at 10/15 exact. Nothing was tuned against
  those 19 names; every change lives in an overlay and the core's maths is
  byte-identical to the port apart from `theme.ts`.

### Still blocked on one thing

`DATABASE_URL`. No Neon project exists, so `db/schema.sql` has never been
applied, the 250-session backfill has never run, `/api/refresh` returns 503, and
every metric above that needs history reports `null`. Nothing else blocks.
