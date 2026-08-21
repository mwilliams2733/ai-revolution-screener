# AI Revolution Portfolio: Reverse-Engineered Strategy

Validated against the actual 19-position portfolio and position-size calculator,
using full US equity data as of 2026-08-19.

---

## 1. The portfolio as delivered

Nineteen positions, three tiers, equal weight within each tier.

| Tier | Count | Weight each | Tier total | Positions |
|---|---|---|---|---|
| Strong Buy | 7 | 7.43% | 52% | AGX, ARM, ISLMF, LITE, LLY, MRVL, TOST |
| Buy | 7 | 5.00% | 35% | CRS, FFIV, FTNT, RDW, SYM, TMRAY, VRT |
| Hold | 5 | 2.60% | 13% | EVLV, FANUY, KTOS, NVDA, PLTR |

The first thing this kills: there is no continuous optimizer. The board meeting
describes a model that "overweights the most conservative ones with the most
relentless institutional volume pressure" and progressively trims positions as
volatility rises. What actually ships is a three-bucket classification with
strictly equal weights inside each bucket. Weight ratios are 2.86 : 1.92 : 1.00.

---

## 2. What actually drives the tiers

I computed 12 factors for all 19 names over 306 trading days and compared tier means.

| Factor | Strong Buy | Buy | Hold | Monotonic? |
|---|---|---|---|---|
| **RS percentile (2,204-name universe)** | **86** | **63** | **36** | **Yes** |
| **12-month return** | **+180%** | **+44%** | **+1%** | **Yes** |
| **Price vs 200d MA** | **+22.6%** | **+12.0%** | **-0.8%** | **Yes** |
| Annualized volatility | 71.5% | 61.8% | 52.0% | Yes, but inverted |
| Trend R² (log-linear fit) | 0.64 | 0.59 | 0.50 | Weakly |
| Max drawdown | -44.7% | -43.0% | -41.3% | No |
| Distance from 52w high | -27.6% | -29.6% | -28.9% | No |

**The finding that matters: tier assignment tracks relative strength, not risk.**

Volatility runs the wrong way. The Strong Buy tier is the *most* volatile bucket
at 71.5% annualized, and the Hold tier is the *least* volatile at 52.0%. If the
calculator were doing what Navellier describes, that relationship would be
inverted. It is not. The two lowest-volatility names in the entire portfolio,
NVDA at 35.0% and FANUY at 46.4%, both sit in the Hold tier at minimum weight.

The stated volatility-scaling story is marketing. The actual rule is closer to:
rank by trailing relative strength, cut into thirds, assign 7.43 / 5.00 / 2.60.

Trend smoothness (R² of log price against time, the closest computable proxy for
Navellier's "goes up steeply but doesn't wiggle") is only weakly monotonic and is
not doing meaningful work at these sample sizes.

### Individual RS percentiles

| Ticker | Tier | RS %ile | 12m | vs MA |
|---|---|---|---|---|
| LITE | Strong | 99 | +602% | +29.2% |
| MRVL | Strong | 98 | +229% | +56.2% |
| FTNT | Buy | 89 | +96% | +27.2% |
| CRS | Buy | 87 | +111% | +22.1% |
| AGX | Strong | 84 | +147% | +10.4% |
| LLY | Strong | 82 | +82% | +23.4% |
| VRT | Buy | 69 | +102% | +4.6% |
| PLTR | Hold | 68 | +11% | +19.0% |
| RDW | Buy | 68 | +40% | +19.8% |
| TOST | Strong | 67 | -16% | +10.6% |
| FFIV | Buy | 59 | +21% | +8.4% |
| NVDA | Hold | 47 | +24% | +8.6% |
| KTOS | Hold | 15 | -5% | -4.2% |
| EVLV | Hold | 12 | -28% | -7.3% |
| SYM | Buy | 8 | -10% | -9.3% |

One clear anomaly: SYM sits in the 8th percentile of the entire liquid universe
yet carries a Buy-tier 5% weight. That is the single largest inconsistency in the
book, and notably it is the exact name Lango volunteered as most at risk of being
dropped. Treat it as a known override rather than as evidence against the rule.

---

## 3. The buy-up-to price is a separate mechanism

Buy-up-to headroom does not track tier, so it is not a conviction measure.

| Tier | Mean headroom |
|---|---|
| Strong Buy | +22.3% |
| Buy | +32.0% |
| Hold | -0.2% |

The Buy tier has *more* headroom than Strong Buy. And the Hold tier averages
zero, with two names, EVLV at -30.9% and FANUY at -6.6%, priced *above* their own
buy-up-to limits.

This reframes what "Hold" means. It is not low conviction. It is a position that
has either broken down or run past its price limit, so no new money goes in. The
tier is doing two jobs at once: momentum ranking and a do-not-add flag.

---

## 4. The theme filter does more work than the quant screen

I ran the momentum ruleset against all 2,204 liquid US common stocks (price >= $5,
dollar volume >= $10M). The top 45 is dominated by small-cap biotech: ERAS, SLS,
ANRO, FBRX, CLYM, ORKA, SYRE, AMLX, TXG, TWST, PRAX, RLAY, ABCL, ABSI, RVMD, MBX
and more. Roughly 60% of the top 45 are clinical-stage biotech running on binary
trial outcomes.

Only eleven AI-relevant names surface unaided: SNDK, AXTI, WOLF, MU, AEHR, LITE,
DELL, AAOI, WDC, MXL, STX.

**So the momentum screen alone would never reproduce this portfolio.** The theme
filter is not a refinement on top of the quant work, it is the primary selection
mechanism, and momentum only ranks within it. Any implementation that skips the
theme gate produces a biotech portfolio.

There is a second, sharper observation buried in this. The single strongest
AI-adjacent momentum cohort right now is memory and storage: SNDK ranks #1 in the
entire universe, MU #15, WDC #40, STX #45. The portfolio owns none of them. That
is deliberate, and Navellier says why in the transcript: "if you had all your money
in memory stocks, you probably have indigestion right now... a lot of that might be
Korean speculation, leverage ETFs." They are explicitly declining the highest
momentum names in their own theme on crowding grounds.

That is a discretionary overlay no screen will reproduce.

---

## 5. The decoded ruleset

What the evidence supports, in the order the decisions are actually made:

**Gate 1, theme membership (discretionary, dominant).**
AI supply chain and AI appliers. Exclude the hyperscalers by rule: if the company
is a net AI CapEx *spender* rather than a *taker*, it is out. This single rule
explains the absence of MSFT, GOOGL, META and AMZN. Roughly 200 to 400 names.

**Gate 2, liquidity and tradability.**
Loose, and looser than most systematic screens. The portfolio includes ISLMF,
which trades roughly 300 shares a day on the OTC market as a Reg S share class,
and TMRAY at under 1,000 shares a day. Both are effectively untradeable at any
size. If you apply a real liquidity floor, you drop two of nineteen positions.

**Gate 3, crowding veto (discretionary).**
Exclude cohorts they judge to be crowded or speculative, currently memory and
storage, regardless of how well those names score.

**Gate 4, rank by relative strength.**
RS = 0.4 x r3m + 0.3 x r6m + 0.3 x r12m, percentile-ranked against the full
liquid universe. Confirmed monotonic across all three tiers.

**Gate 5, trend position.**
Price relative to the 200-day moving average. Also monotonic across tiers, and
the cleanest single separator between Buy and Hold, since Hold averages below
the line at -0.8%.

**Tier assignment.**
- Strong Buy, 7.43%: RS percentile roughly >= 80 and above the 200d MA
- Buy, 5.00%: RS percentile roughly 55 to 80, at or above the 200d MA
- Hold, 2.60%: RS percentile < 55, or below the 200d MA, or price above buy-up-to

**Sell triggers** (stated in the transcript, not verifiable from price data alone):
margin compression, negative estimate revisions, falling quant grade,
thesis-invalidating competition, and relative opportunity cost against better ideas.

### How well the rule reproduces the actual tiers

Applying the decoded thresholds to the 15 portfolio names with usable liquid data:

| Ticker | RS %ile | vs MA | Model says | They say | Match |
|---|---|---|---|---|---|
| LITE | 99 | +29.2 | Strong Buy | Strong Buy | yes |
| MRVL | 98 | +56.2 | Strong Buy | Strong Buy | yes |
| FTNT | 89 | +27.2 | Strong Buy | Buy | no |
| CRS | 87 | +22.1 | Strong Buy | Buy | no |
| AGX | 84 | +10.4 | Strong Buy | Strong Buy | yes |
| LLY | 82 | +23.4 | Strong Buy | Strong Buy | yes |
| VRT | 69 | +4.6 | Buy | Buy | yes |
| PLTR | 68 | +19.0 | Buy | Hold | no |
| RDW | 68 | +19.8 | Buy | Buy | yes |
| TOST | 67 | +10.6 | Buy | Strong Buy | no |
| FFIV | 59 | +8.4 | Buy | Buy | yes |
| NVDA | 47 | +8.6 | Hold | Hold | yes |
| KTOS | 15 | -4.2 | Hold | Hold | yes |
| EVLV | 12 | -7.3 | Hold | Hold | yes |
| SYM | 8 | -9.3 | Hold | Buy | no |

**Exact tier match: 10 of 15, or 67%. Within one tier: 15 of 15, or 100%.**

Every miss is a single-tier error, and the errors are not random. FTNT and CRS
score into Strong Buy on price data but are held at Buy, while TOST is promoted to
Strong Buy despite a negative 12-month return. Those three look like the analysts'
fundamental overlay pulling against the momentum rank, which is exactly where the
unverifiable earnings and margin criteria would bite. PLTR at Hold despite decent
momentum is consistent with the buy-up-to mechanism from section 3 rather than
with a momentum failure.

That 67% is the honest ceiling for a price-only reconstruction. Closing the gap
requires the fundamentals data described in section 6.

---

## 6. What could not be validated, and why

Three of the stated criteria depend on fundamentals and forward estimates:
accelerating revenue and EPS growth, operating margin expansion, and positive
earnings surprise history with a forward P/E below the growth rate.

Your Massive subscription returns HTTP 403 on both the Benzinga partner endpoints
(`/benzinga/v1/earnings`, which carries `eps_surprise_percent`, and the ratings
and consensus endpoints) and the financials endpoints
(`/stocks/financials/v1/income-statements`, `/stocks/financials/v1/ratios`).
Price aggregates and the reference ticker universe both work.

So the fundamental half of the strategy is currently unverified. Section 8 of the
handoff covers how to close that gap for free.

---

## 7. Honest assessment

**What holds up.** The CapEx-taker thesis is a real, articulable edge and it is
consistently applied. The momentum ranking is genuine and reproducible. The
three-tier sizing is simple and defensible. The sell discipline is coherent.

**What does not.** The position-size calculator is sold as a risk model and is not
one, it is a momentum ranking with equal weights inside buckets. Volatility runs
opposite to the stated direction. The theme membership test is undefined enough
that Eli Lilly qualifies as an AI stock on the grounds that it uses AI in drug
discovery, which is a rationalization, not a criterion. Two positions are
functionally untradeable. And the portfolio carries genuine single-theme
correlation risk, which the team acknowledges: the whole book drew down hard in
July 2026, and Fry concedes it is "diversified within a narrow focus."

**The transcript is promotional.** Bearish headlines are dismissed as "false
narratives" and "fake news," short sellers are called "truly stupid," and the
stated goal is 1,000% winners. Weight the reasoning, discount the framing.
