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

A tier can be **held down** for four reasons, each shown under the row:

- *"Held down — Stage 3 (topping)"* — the 150-day average is flattening or
  rolling over. A late-stage chart caps the tier one step: Strong Buy becomes
  Buy, Buy becomes Hold. Hold already means "no new money", which is what a
  topping chart says.
- *"Momentum Strong Buy, held at Buy"* — it ranked highly on price but its
  revenue growth is decelerating **and** its operating margin is compressing.
- *"Capped at Hold — shares +42% in a year (limit 30%)"* — a balance-sheet
  guardrail. Applied to **every** name, not just cheap ones: if dilution
  matters at $2 it matters at $20. Three thresholds — share count growing more
  than **30%** a year, under **12 months** of cash at the current burn, or a
  market cap under **$150M**. A failure caps the tier at Hold, because Hold
  already means "no new money", which is what a balance-sheet failure says.
  Nothing is deleted; the row keeps its rank and carries the reason.
- *"Meets every Strong Buy rule, outside the top 10 by rank"* — it passed
  everything, but only the ten highest-ranked names hold the top tier. A
  challenger has to beat the name in the last slot by **2 percentile points**
  to take it; inside that margin the incumbent keeps the slot and both rows say
  so. Without the margin the names at ranks 10 and 11 swapped almost daily,
  which was the single largest source of tier churn in the whole ruleset.

They run in that order, which matters: a topping name and a name failing a
balance-sheet guardrail are both capped **before** the top-10 cut, so neither
occupies a Strong Buy slot on its way down. Ordered the other way the screen
showed eight Strong Buys rather than ten — the cap filled all ten and the
guardrails then emptied two, wasting the slots instead of passing them to the
next healthy name. One
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
| **Annualised turnover** | Tier changes per position per year, from the recorded nights. Above ~200% suggests the cutoffs are chasing noise rather than tracking a regime. Measured over **all** recorded sessions — 248 today — it is **744%**, down from 1,177% before the two stickiness rules. Still well above target, and the remaining churn has not been diagnosed. The window travels with the figure on screen: the same data reads 1303% over the last 30 sessions, which is a statement about one month rather than about the rules. |
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

**When do emails arrive?**
Two different things arrive, and the difference matters.

The **morning digest** lands every weekday at **6:00 AM Phoenix** whether or not
anything moved: session date and staleness first, then the tier split, what
changed, what was held down and why, and the ten strongest names. It is
unconditional on purpose — an alert that goes quiet looks exactly like a
screener that died three weeks ago, so a digest that always arrives is the only
thing that can tell you the pipeline is alive.

The **change alert** is exception-driven and fires from the refresh only when a
tier actually moved, downgrades first.

Schedule, all weekdays (Phoenix is UTC-7 year-round, so none of this drifts):

| Phoenix | UTC | What |
|---|---|---|
| 5:00 AM | 12:00 | refresh — picks up the previous session, repairs split-stranded bars |
| 6:00 AM | 13:00 | digest email |
| 3:00 PM | 22:00 | refresh — captures the same day's close, two hours after it |

The afternoon refresh is kept because the market closes at 1:00 PM Phoenix:
without it, Friday's close would not be stored until Monday morning and the
weekend would show Thursday.

---

## Does it work?

Unknown, and now measured rather than assumed. `npm run backtest` scores the
reconstructed tier history against forward returns.

Over 248 replayed sessions (2025-08-27 to 2026-08-21), at a 21-session horizon:

| | mean | annualised | t | n |
|---|---|---|---|---|
| Strong Buy | +9.02% | +181.9% | 1.46 | 11 |
| Buy | +6.85% | +121.4% | 1.53 | 11 |
| Hold | +3.72% | +55.0% | 1.20 | 11 |
| whole theme, equal weight | +5.24% | +84.5% | 1.48 | 11 |
| SPY | +1.37% | +17.8% | 0.88 | 11 |

**The tier ordering is monotone** — Strong Buy above Buy above Hold — at every
horizon tested, for both the final tier and the price-only momentum tier. Six
out of six. That consistency is the encouraging part.

**Nothing is statistically significant, and the sample cannot make it so.**
`n` is the number of *non-overlapping* windows, because a 21-session return
measured daily shares 20 of its 21 days with the next one. Eleven windows is
what one replayed year actually contains. Worse, the ~104 names inside a window
are one theme moving together — the live screen reports 19 holdings behaving
like 2.9 independent bets — so even eleven is generous. The script prints
`UNDERPOWERED` rather than a t-statistic wherever that is the honest answer.

Three further readings worth knowing:

- **Most of the return is the theme, not the tier.** Owning all 104 names
  equally annualises at +84.5% against SPY's +17.8%. Strong Buy adds +3.78% per
  21 sessions on top of that (t = 0.91) — real if it holds up, but a fraction
  of what the theme itself contributed.
- **The overlays have not been shown to improve selection.** The price-only
  momentum tier returns +8.34% at 21 sessions against the fully-overlaid
  +9.02%. The final tier's Strong Buy bucket averages 10.0 names against the
  momentum tier's 40.5, so it is four times as concentrated for 0.68 points of
  extra mean return. On eleven windows that difference is noise.
- **Every bias in the reconstruction favours the strategy**: today's theme map
  applied to the whole history, a universe pruned using today's knowledge of
  which names stayed liquid, and no fundamental gate. A ruleset that could not
  beat its benchmark even with that help would be dead; clearing it this way
  proves much less.

No transaction costs are modelled. At 744% annualised turnover that omission is
not small.

### Live versus replayed history

Every row in `tier_history` is stamped `live` or `replay`. A **live** row was
computed by the nightly refresh from that day's data and nothing later; a
**replay** row was reconstructed afterwards by `npm run replay`. The
distinction is load-bearing twice:

- **Alerts refuse to fire against a replayed baseline.** A replay runs a
  slightly different ruleset — the fundamental gate is not replayed, because
  applying today's EDGAR filings to a 2025 session is lookahead — so diffing
  live against replayed reports the difference between two *rulesets* as if the
  market had moved. That is exactly how two junk alerts went out.
- **The replay will not overwrite a live row.** Live rows are the only
  genuinely out-of-sample evidence this project will ever have, accumulating one
  session per weekday. `npm run replay` is therefore safe to re-run as often as
  you like; it fills gaps and never erodes the record.

`npm run backtest` prints the split, and `npm run audit` warns while the live
count is still too low to conclude anything. About 20 live sessions at a
21-session horizon is where `UNDERPOWERED` starts to lift.

## Price and liquidity filters

Six layers decide what gets ranked at all:

| Filter | Value | Why |
|---|---|---|
| **Security type** | common stock **and ADRs** | `type=CS` alone hid TSM, ASML and ARM — three of the most important names in the AI supply chain — while their bars sat in the database. |
| **Price** | **≥ $1** | Not $5. That was the Reg T marginability convention and said nothing about a company. $1 is the exchange delisting-deficiency line, so "above $1" means "in compliance with its listing standards". |
| **Liquidity** | **median $10M/day over 50 sessions** | Not today's dollar volume. A single-day gate is exactly what a pump passes, since the whole garbage category is defined by *episodic* volume. Names with no stored history fall back to today's figure — a recent listing is unmeasured, not illiquid. |
| **History** | 12 months | The relative-strength blend needs 3-, 6- and 12-month anchors, so recent IPOs are invisible until they have a year. |
| **Theme map** | `lib/theme.ts` | Only for the theme table. The leaders view ignores it. |
| **Crowding veto** | memory/storage | Shown greyed with the reason, never silently dropped. |

Dropping the price floor from $5 to $1 admitted 46 names and grew the ranked
universe from 2,316 to 2,353. The balance-sheet guardrails above are what
replaced it — each risk the floor stood in for, measured directly.

## Splits

Polygon restates a ticker's **entire** price history when a split executes.
`npm run backfill` computes its work list as a set difference over *sessions*,
so it can never notice that an already-stored session's values changed. Left
alone, a 10-for-1 reverse split leaves every pre-split bar on the old basis: the
twelve-month lookback spans the discontinuity, reads about **+900%**, and puts a
collapsing micro-cap at the top of the screen.

`npm run refetch-splits` repairs it, and the nightly refresh drains 25 tickers a
run so the backlog cannot build. Progress is a per-split ledger
(`split_refetch`), never a high-water date — a watermark assumes everything
older was handled, so one failed repair is skipped forever and a split
discovered late with an older execution date is never done at all. `npm run
audit` fails loudly if anything is outstanding.

The same table de-contaminates the dilution guardrail: cover-page share counts
are never restated either, so an unadjusted 10-for-1 reads as +900% issuance and
condemns whichever companies appreciated enough to split.

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
npm run replay         # rebuild tier_history from stored bars
npm run backtest       # forward return by tier, with honest sample sizes
npm run sectors        # SIC classification from EDGAR, resumable
npm run splits         # cache Polygon split history
npm run health         # balance-sheet facts from EDGAR, then a guardrail report
npm run refetch-splits # repair price history stranded by a split
```

`npm run audit` is the gate. It asserts the values that caught real bugs:
universe size, LITE at the 99th percentile, tie-averaged ranks, and that
percentiles rank the full universe rather than the theme.
