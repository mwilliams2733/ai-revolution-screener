# Claude Code kickoff

## 1. Set up the directory

```bash
mkdir -p ~/projects/ai-revolution-screener
cd ~/projects/ai-revolution-screener
unzip ~/Downloads/ai_revolution_screener.zip
cd ts && npm install && npm test && cd ..   # expect 52 passing
claude
```

## 2. Paste this

---

I'm building a stock screener that implements a reverse-engineered investment
strategy. The decoded strategy, a tested TypeScript core, and a deployment plan
are already in this directory. Read these three files first, in this order:

1. `STRATEGY_DECODED.md` for what the strategy is and the evidence behind it
2. `HANDOFF.md` for the deployment plan and data sources
3. `ts/README.md` for how the existing code is organized

**The core logic is already written and tested. Do not rewrite it.** `ts/lib/`
contains factors.ts, tiers.ts, theme.ts, types.ts, params.ts and index.ts, with
52 passing tests. Run `cd ts && npm test` to confirm before you touch anything,
then move `lib/` into the Next.js app unchanged. If you think something in it is
wrong, tell me before changing it: `tiers.test.ts` encodes a real 19-position
portfolio as a regression fixture and its expected values are measured, not
guessed.

**Goal:** a Next.js app on Vercel, reachable from my phone and my desktop,
shared with exactly one other person.

**Stack, already decided, please don't re-litigate:**
- Next.js App Router deployed to Vercel
- Cloudflare Access in front for auth, email allowlist, two users
- Neon Postgres for cached daily bars
- Vercel Cron for the nightly refresh
- Resend for tier-change alerts

**Data access:**
- Prices come from a Polygon-compatible API, key in `POLYGON_API_KEY`. Only two
  endpoints work on my plan: `/v3/reference/tickers` and
  `/v2/aggs/grouped/locale/us/market/stocks/{date}`. Everything under
  `/stocks/financials/` and `/benzinga/` returns 403, so don't call them.
- Fundamentals come later from SEC EDGAR XBRL companyfacts, which is free but
  requires a real User-Agent header containing an email address.

**Build in this order, and stop after each step so I can check it:**

1. Scaffold the Next.js app, move `ts/lib` in, get the tests green in their new
   location.
2. `lib/polygon.ts` plus the Postgres schema. Backfill 250 sessions of grouped
   daily bars. One call per session returns about 12,500 bars, so do NOT fetch
   per-ticker histories, that's 2,000+ calls for the same data.
3. `app/api/screen/route.ts` returning ranked JSON. Verify LITE comes out at the
   99th percentile. That single check tells you the pipeline is wired correctly.
4. `app/page.tsx`, a sortable table with tier badges. Design mobile-first, the
   phone is the harder constraint.
5. Cloudflare Access, then the cron refresh route, then the alerts.

**Non-negotiables:**
- The API key never reaches the browser. Nothing secret gets a `NEXT_PUBLIC_`
  prefix. Every data call goes through a route handler.
- Rank RS percentiles against the full liquid universe, then filter to the
  theme. Never the reverse, it changes what a percentile means and invalidates
  the tier cutoffs.
- When you store the ticker universe, also fetch `active=false` and keep
  delisted names. If you skip this, any backtest I write later inherits
  survivorship bias I cannot reconstruct after the fact.
- Crowding-vetoed names, currently memory and storage, render greyed out with
  the reason attached rather than being silently dropped.

Start with step 1.
