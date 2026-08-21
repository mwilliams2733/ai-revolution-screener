# Handoff: deploying the screener

Target: reachable from your phone and your computer, shared with exactly one
other person, API keys never exposed to the browser, scheduled refresh.

---

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router) | One repo serves the API routes and the UI, deploys as-is |
| Host | Vercel free tier | Free HTTPS, global CDN, good mobile performance |
| Auth | Cloudflare Access | Free up to 50 users, email allowlist, zero auth code to write |
| Scheduler | Vercel Cron | One line in `vercel.json`, hits a route on a schedule |
| Cache/state | Neon Postgres free tier | Stores daily bars so you are not refetching 250 sessions |
| Alerts | Resend free tier | 3,000 emails/month, trivial API |

Everything above has a free tier that comfortably covers two users.

**On auth specifically.** Do not roll your own. Put Cloudflare Access in front of
the Vercel deployment and allowlist your two email addresses. Login becomes a
one-time email code, it works identically on phone and desktop, and your app code
never handles a credential. The alternative, Vercel's built-in password
protection, requires a Pro plan.

**Keys stay server-side.** Every data call goes through a Next.js route handler
using `process.env.POLYGON_API_KEY`. Nothing with an `NEXT_PUBLIC_` prefix. This
is the main reason not to build the screener as a static HTML page.

---

## Repo shape

```
ai-revolution-screener/
  app/
    page.tsx                    # ranked table, tier badges, sector filter
    api/screen/route.ts         # runs the screen, returns JSON
    api/refresh/route.ts        # cron target: pulls bars, writes to Postgres
  lib/
    polygon.ts                  # grouped daily + reference tickers
    edgar.ts                    # SEC XBRL fundamentals
    factors.ts                  # RS, MA position, percentile ranks
    theme.ts                    # THEME map, CAPEX_SPENDERS, CROWDING_VETO
    tiers.ts                    # assign_tier, weights
  db/schema.sql
  vercel.json
```

`screener.py` in this folder is the reference implementation. Port `factors.ts`
and `tiers.ts` directly from it, the logic is deliberately small and pure. Keep
`screener.py --selftest` green as your regression suite while you port, the tier
cases in it are real portfolio values.

---

## Data plan

**Prices: your existing Massive/Polygon key.** Confirmed working on your tier:

- `/v3/reference/tickers` for the common-stock universe
- `/v2/aggs/grouped/locale/us/market/stocks/{date}` for whole-market daily bars

The grouped endpoint is the important one. One call returns roughly 12,500 bars,
so 250 calls backfills a full year for the entire market. Backfill once into
Postgres, then a single call per trading day keeps it current. Do not fetch
per-ticker histories, that is 2,000+ calls for the same information.

**Fundamentals: SEC EDGAR XBRL, free, no key, no rate limit beyond courtesy.**

- `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`
- Send a real `User-Agent` with your email, they enforce this
- CIK comes from the Polygon reference response, zero-pad it to 10 digits

This gives quarterly revenue, operating income, net income and EPS for every
filer, which covers three of the criteria the price data could not: revenue and
EPS acceleration, operating margin expansion, and trailing valuation.

**Forward estimates: the remaining gap.** EDGAR is actuals only. Options, in the
order I would try them:

1. **Finnhub free tier.** 60 calls/minute, includes `/stock/earnings` with
   surprise history and `/stock/recommendation`. Enough for a few hundred theme
   names refreshed daily. Free key, no card.
2. **Post-earnings drift as a proxy.** You already have every daily bar. Measure
   the 1-day and 10-day abnormal return around each earnings date. A stock that
   consistently gaps up on earnings is beating estimates, which is what the
   surprise criterion is actually trying to detect. Zero extra dependencies, and
   arguably a better signal than the consensus number itself.
3. **Upgrade Massive** to include the Benzinga endpoints, which is what your
   403s were. Only worth it if you want raw consensus values specifically.

I would ship with 2, add 1 if you want the explicit numbers.

---

## Build order

1. `lib/factors.ts` and `lib/tiers.ts`, ported from `screener.py`, with the
   selftest cases as unit tests. No network needed, get this green first.
2. `lib/polygon.ts` plus the Postgres schema. Backfill 250 sessions once.
3. `api/screen/route.ts` returning ranked JSON. Verify against the numbers in
   `STRATEGY_DECODED.md` section 2, LITE should come out at the 99th percentile.
4. `app/page.tsx`. A sortable table with tier badges gets you 90% of the value.
   Design for the phone first, it is the harder constraint.
5. Cloudflare Access in front, allowlist the two emails.
6. `api/refresh/route.ts` plus a Vercel Cron entry at 22:00 UTC on weekdays.
7. `lib/edgar.ts` and the fundamental gates, once the momentum half is trusted.
8. Resend alerts on tier changes, which is the thing you will actually open the
   app for.

---

## Things worth getting right

**Do not drop the theme gate.** Section 4 of the strategy doc shows the momentum
screen returns a biotech portfolio without it. The `THEME` map in `screener.py`
is a starting point, not a finished universe. Budget real time on it and keep it
in version control so you can see how it drifts.

**Keep the crowding veto visible, not silent.** Right now it hard-excludes
memory and storage names. Render them greyed out with the reason attached rather
than dropping them, otherwise in six months you will not remember why SNDK, the
single strongest name in the market, is missing.

**Survivorship bias will bite any backtest.** `/v3/reference/tickers?active=true`
only returns live tickers. Delisted names are gone, so a naive backtest inherits
a large upward bias. Pass `active=false` as well and store the full historical
universe from day one, because you cannot reconstruct it later.

**Percentile ranks need the full universe.** Rank against all 2,200 liquid names,
then filter to the theme. Ranking inside the theme alone makes the RS percentile
mean something entirely different, and the tier cutoffs in section 5 would no
longer apply.

**The 67% tier match is your baseline.** If a change to the ruleset moves it
meaningfully, you have learned something. If it does not, you are curve-fitting.
