# Signal lab report — 2026-10-10

Universe: AAPL, AMD, AMZN, GOOGL, JPM, META, MSFT, NVDA, QQQ, SPY, TSLA, XOM · bars 2020-09-08 → 2026-09-11 ·
train 11,628 bars / test 4,986 bars (test from 2024-11-19) ·
155 signal×horizon tests (Bonferroni α ≈ 3.23e-04).

## The reasoning

Forecasting returns is a signal-extraction problem with a terrible signal-to-noise
ratio. The failure mode is not "no ideas" but "too many ideas, all backfit."
Hence: chronological split, rule cutoffs fit on train only, ranking on train,
judgment on test, and an explicit multiple-comparison budget.

Why these candidates — each maps to a market mechanism, not a squiggle:

| indicator | mechanism |
|---|---|
| `mom_20` | Trend persistence: slow information diffusion + herding; winners keep drifting (Jegadeesh–Titman intuition). |
| `mom_60` | Longer-horizon trend; separates sustained moves from 1-month noise. |
| `ma_cross` | Lagging trend filter; 20d above 50d = regime is up. Slow, so it misses turns. |
| `rsi_14` | Crowding gauge: extreme RSI = overbought/oversold → short-term mean reversion (liquidity provision). |
| `macd_hist` | Momentum acceleration; histogram flipping sign often leads price turns. |
| `bb_pctb` | Position within volatility envelope; tags outside the bands = stretch, fade candidate. |
| `atr_pct` | Volatility regime; predicts magnitude better than direction (volatility clustering). |
| `vol_z` | Abnormal volume = information arrival; informed trading shows in volume before price fully adjusts. |
| `ret_5` | 1-week reversal leg: sharp up weeks tend to give back (overreaction). |
| `gap` | Overnight repricing on news; gaps often partially fill intraday, then resume. |
| `intraday` | Day-session strength vs overnight; persistent intraday drift = institutional accumulation. |
| `dist_20d_high` | Breakout proximity; new highs on volume = momentum ignition. |
| `dist_52w_high` | Anchoring: investors underreact near 52w highs (George–Hwang). |
| `dist_52w_low` | Capitulation/reversal zone; washed-out names bounce hardest — or keep falling. |
| `vol_spike` | CATALYST proxy: volume >2σ = something happened; trade the aftermath, not the spike. |
| `gap_big` | CATALYST proxy: gap >1.5× ATR = real overnight news, not noise. |
| `breakout_vol` | CATALYST proxy: 20-day high + confirming volume = conviction breakout. |

Combinations are intersections (both signals must agree), which cut false
positives by demanding confirmation, plus one sign-aligned z-score composite.
Kitchen-sink regressions were deliberately avoided: with this SNR they
memorize noise.

## Best single indicator

**vol_spike** (long), **10-trading-day window**, expected move **+2.34%** (95% CI [+1.26%, +3.47%], n=162, hit rate 62% vs base 56%, excess over base +1.26%). CI excludes zero: yes.

### Top singles on the test set

| signal | side | horizon | n (test) | mean fwd return [95% CI] | hit rate | t-stat |
|---|---|---|---:|---|---|---:|
| vol_spike | long | 10d | 162 | +2.34% [+1.26%, +3.47%] | 62% (base 56%) | +3.87 |
| vol_z__long | long | 20d | 163 | +3.04% [+1.66%, +4.66%] | 66% (base 59%) | +3.72 |
| vol_spike | long | 20d | 135 | +3.42% [+1.56%, +5.28%] | 66% (base 59%) | +3.67 |
| intraday__long | long | 10d | 223 | +2.02% [+0.91%, +3.08%] | 59% (base 56%) | +3.65 |
| vol_z__long | long | 10d | 222 | +1.81% [+0.83%, +2.81%] | 63% (base 56%) | +3.59 |
| mom_20__long | long | 10d | 87 | +3.16% [+1.51%, +4.95%] | 64% (base 56%) | +3.58 |
| vol_spike | long | 5d | 198 | +1.47% [+0.70%, +2.31%] | 62% (base 55%) | +3.44 |
| bb_pctb__long | long | 3d | 256 | +0.78% [+0.33%, +1.23%] | 61% (base 54%) | +3.26 |
| ret_5__long | long | 10d | 140 | +2.27% [+0.82%, +3.60%] | 63% (base 56%) | +3.24 |
| mom_20__long | long | 5d | 143 | +1.71% [+0.82%, +2.65%] | 58% (base 55%) | +3.24 |

## Best combo

**(vol_z__long)&(vol_spike)** (long), **10-trading-day window**, expected move **+2.34%** (95% CI [+1.26%, +3.47%], n=162, hit rate 62% vs base 56%, excess over base +1.26%). CI excludes zero: yes.

### Top combos on the test set

| signal | side | horizon | n (test) | mean fwd return [95% CI] | hit rate | t-stat |
|---|---|---|---:|---|---|---:|
| (vol_z__long)&(vol_spike) | long | 10d | 162 | +2.34% [+1.26%, +3.47%] | 62% (base 56%) | +3.87 |
| (vol_z__long)&(vol_spike) | long | 20d | 135 | +3.42% [+1.56%, +5.28%] | 66% (base 59%) | +3.67 |
| (vol_z__long)&(vol_spike) | long | 5d | 198 | +1.47% [+0.70%, +2.31%] | 62% (base 55%) | +3.44 |
| (vol_spike)&(mom_20__long) | long | 5d | 25 | +3.60% [+1.64%, +6.04%] | 80% (base 55%) | +3.33 |
| (bb_pctb__long)&(dist_20d_high__long) | long | 20d | 111 | +3.45% [+1.53%, +5.69%] | 59% (base 59%) | +3.31 |
| (bb_pctb__long)&(mom_20__long) | long | 10d | 49 | +3.64% [+1.56%, +6.12%] | 63% (base 56%) | +2.88 |
| (bb_pctb__long)&(dist_20d_high__long) | long | 10d | 141 | +1.90% [+0.73%, +3.11%] | 62% (base 56%) | +2.84 |
| (vol_z__long)&(mom_20__long) | long | 5d | 36 | +3.30% [+1.39%, +5.58%] | 67% (base 55%) | +2.80 |
| (bb_pctb__long)&(dist_20d_high__long) | long | 3d | 209 | +0.78% [+0.24%, +1.31%] | 61% (base 54%) | +2.78 |
| (rsi_14__long)&(breakout_vol) | long | 3d | 64 | +1.35% [+0.43%, +2.39%] | 70% (base 54%) | +2.76 |


## Caveats

- These are close-to-close, frictionless numbers. Spreads, slippage, borrow
  cost and taxes eat a large share of small edges — especially 1-day horizons.
- The test set is one historical regime. A signal that worked 2021–2026 may
  not work 2026–2030. Re-run quarterly; distrust any edge with n < 50.
- With 155 tests, expect ~8 "significant" (p<0.05)
  winners by pure luck. The Bonferroni bar above is the honest one.
- Signal occurrences are de-duplicated so forward windows don't overlap
  (spacing = horizon); without this, a signal that fires 20 days in a row
  during one crash would count as 20 "independent" wins.
- Yahoo bars are split/dividend adjusted; corporate-action handling differs
  across vendors, so cross-check any live candidate against your Polygon feed.
