# Review log

What a structured review found and fixed, so the next pass starts from here
rather than from scratch. Newest first.

Run `npm run audit` to re-check everything below mechanically.

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
