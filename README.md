# AI Revolution Screener

Ranks every liquid US stock by relative strength, then narrows to the AI
CapEx-taker theme. Live at **https://screener.williamstradingplatform.com**
(Cloudflare Access, email code, 24-hour session).

The strategy is reverse-engineered from a published newsletter portfolio. See
`STRATEGY_DECODED.md` for the evidence and `REVIEW_LOG.md` for what has been
audited.

---

## What every column means

### Identity

| Column | Meaning |
|---|---|
| **Ticker** | The symbol. Tap the **+** beside it to expand a detail panel. |
| **Company name** | Underlined with dots — hover or tap for a business summary, market cap, next earnings date and the last four earnings surprises. |
| **Sector** | Which slice of the theme map it belongs to. Eleven sectors, editable in `lib/theme.ts`. |

### Tier and weight

| Column | Meaning |
|---|---|
| **Tier** | `Strong Buy`, `Buy` or `Hold`. Assigned from relative strength and trend position, then tightened by three extra rules (below). |
| **Weight** | What the strategy would allocate: 7.43% Strong Buy, 5.00% Buy, 2.60% Hold. Treat it as a *signal grade*, not a position size — see "Known quirks". |

A tier can be **held down** for three reasons, each shown under the row:

- *"Held down — Stage 3 (topping)"* — the 150-day average is flattening or
  rolling over. A late-stage chart caps the tier one step: Strong Buy becomes
  Buy, Buy becomes Hold. Hold already means "no new money", which is what a
  topping chart says.
- *"Momentum Strong Buy, held at Buy"* — it ranked highly on price but its
  revenue growth is decelerating **and** its operating margin is compressing.
- *"Meets every Strong Buy rule, outside the top 10 by rank"* — it passed
  everything, but only the ten highest-ranked names hold the top tier.

The three run in that order, which matters: a topping name is capped **before**
the top-10 cut, so it cannot occupy a Strong Buy slot on its way down. One
consequence worth knowing — a Stage 3 name that was a *momentum* Strong Buy
lands at Buy, while one that was a momentum Buy lands at Hold. The rule caps by
one step; it does not send everything late-stage to Hold.

### Prices and changes

| Column | Meaning |
|---|---|
| **Open** | The session's opening price. |
| **Close** | The session's closing price. This is the price everything else is computed from. |
| **Day** | Close against the **previous session's close** — the conventional daily move, the same number a quote site shows. |
| **Wk** | Close against 5 trading sessions ago. |
| **Mo** | Close against 21 trading sessions ago. |
| **3M / 12M** | 63 and 252 sessions. These two feed the relative-strength score. |
| **Close vs open** *(expander)* | A different number from **Day**: it measures the move *within* the session, ignoring any overnight gap. |

All periods are **trading sessions**, never calendar days. A week is five
sessions, so a holiday week still compares like with like.

### Strength and trend

| Column | Meaning |
|---|---|
| **RS** | Relative-strength percentile, 0–100, against **every liquid US stock** (~2,200), not against the theme. 99 means it out-ran 99% of the market. Blend: 40% 3-month, 30% 6-month, 30% 12-month. |
| **The rail** | The bar under each row. It draws RS from 0 to 100 with tick marks at the two tier cutoffs, 55 and 80, so you can see *why* a name earned its tier. Cool = above its 200-day average, warm = below. |
| **vs MA** | How far the price sits above or below its 200-day moving average. |
| **TT** | Trend template, `n/8`. Eight criteria (Minervini); hover for which ones passed. Below 222 sessions of history it shows nothing rather than a partial score. |
| **Stage** | Weinstein stage from the 150-day average and its slope. **1** base, **2** advance, **3** topping, **4** decline, **T** transitional. A name just above a *rising* average (2) is a different proposition from one above a *rolling-over* average (3). |

### Volume

| Column | Meaning |
|---|---|
| **U/D** | Up/down volume ratio over 50 sessions. Above 1.0 means more volume on advancing days than declining ones — accumulation. Above ~1.5 is heavy buying. |
| **Acc** | Accumulation grade, A–E, from the U/D ratio percentile-ranked across the whole liquid universe. A = top 20%. |
| **Vol** | Dollar volume traded, a liquidity measure, not a signal. |
| **OBV slope** *(expander)* | On-balance-volume trend, normalised by average volume so it compares across companies of any size. |
| **Relative volume** *(expander)* | Today's volume against the prior 50-session average. Above 2x is flagged as elevated. |
| **Volume confirms** *(expander)* | Yes when the U/D ratio is above 1 **and** OBV is rising **and** it is a buy-side tier. An *unconfirmed* Strong Buy is rising on weak volume. |

### Portfolio header

| Figure | Meaning |
|---|---|
| **Ranked universe** | How many liquid names were scored. Everything is ranked here *before* the theme filter, which is what makes the tier cutoffs meaningful. |
| **In theme** | How many survived the theme filter. |
| **Stage capped / Gate demoted / Capped out** | How many names each of the three tightening rules moved down. |
| **Effective bets** | How many *independent* positions the book really holds, adjusting for correlation. Compare it to the holding count: 19 holdings at 2.9 effective bets means most of the book moves together. |
| **Mean correlation** | Average pairwise correlation of daily returns across holdings, 60 sessions. Above ~0.6 means you own a handful of bets, not nineteen. |
| **Top 3 sectors** | Share of weight in the three largest sectors. |

### Tier stability

| Figure | Meaning |
|---|---|
| **Annualised turnover** | Tier changes per position per year, from the recorded nights. Above ~200% suggests the cutoffs are chasing noise rather than tracking a regime. |
| **Median time in tier** | How many consecutive sessions a typical name has held its current tier. |
| **Recent moves** | Every tier change in the recorded window, newest first. |
| **Least stable** | The names flipping fastest. A name changing tier every few sessions is a signal-quality problem, not a trading opportunity. |

These need at least **two recorded nights** to say anything, and the refresh
records one per weekday. Until then the section says so rather than showing a
zero, which would read as "perfectly stable".

### Held out

Names the strategy deliberately excludes, shown greyed with a diagonal hatch and
the reason attached — currently the memory and storage cohort. **They are never
silently dropped.** SNDK is the strongest name in the market and is absent on
purpose; six months from now the reason will still be on screen.

---

## FAQ

**Why is a name missing?**
Use the **Check any ticker** box. It applies the full ruleset to any symbol and
tells you *why* it is absent: below $5, under $10M daily dollar volume, less
than 12 months of history, a net AI CapEx spender, or under the crowding veto.

**Why does the tier not match the newsletter?**
It reproduces 10 of 15 published tiers exactly and all 15 within one tier. The
five misses are identified overrides, not noise. 67% is the honest ceiling for a
price-only model.

**What does "not ranked" on the rail mean?**
The percentile was never measured. It is deliberately different from a zero,
which would mean genuinely worst in the market.

**Why is the first load slow?**
A cold instance rebuilds the screen from scratch, around 10 seconds. It is
cached for 15 minutes after that.

**How fresh is the data?**
The price feed is delayed end-of-day, so the newest data is the previous
session's close. The **Session** date says which one. If the app is more than
one session behind, a banner says so.

**When do alerts arrive?**
The refresh runs 22:00 UTC on weekdays. If any tier changed, an email goes out
listing what moved, downgrades first.

---

## Known quirks, deliberately left

- **Ten Strong Buys at 7.43% each is a 74.3% sleeve**, not the published 52%.
  The original weights assume seven. The tier badge is a signal grade, not a
  position size.
- **Moving averages need 200 stored sessions.** Names with less history fall
  back to a five-point approximation and are marked as such in the expander.

## Running it

```bash
npm run dev            # local, no Access gate
npm run audit          # typecheck + tests + live data integrity
npm run backfill       # one-off history load, safe to re-run
```

`npm run audit` is the gate. It asserts the values that caught real bugs:
universe size, LITE at the 99th percentile, tie-averaged ranks, and that
percentiles rank the full universe rather than the theme.
