#!/usr/bin/env python3
"""
find_best_signal.py — which indicator / catalyst (or combo) actually forecasts
stock movement, and over what window?

This is a measurement tool, not a promise machine. The honest question is not
"what correlates in-sample" but "what survives out-of-sample after accounting
for how many things were tried." So the design is:

  1. Download daily bars (Yahoo Finance, free, no key; or --source csv to feed
     it your own data, e.g. Polygon aggregates you already pull).
  2. Compute candidate indicators + catalyst proxies using only data known at
     the close (no look-ahead).
  3. Chronological train/test split per ticker (default 70/30). Signal rule
     cutoffs (e.g. decile thresholds) are fit on TRAIN only.
  4. Rank candidate signals on TRAIN by t-stat of forward return, then report
     honest TEST-set stats: n, hit rate, mean forward return, bootstrap CI.
  5. Combos: pairwise intersections of the top-K train signals plus a
     sign-aligned z-score composite — same train/test discipline.
  6. Optional --events CSV (ticker,date) tests catalyst windows such as
     earnings proximity (pre-earnings drift / post-earnings drift).

Outputs: console summary, results/*.csv, results/REPORT.md.

Dependencies: pandas, numpy. No sklearn needed.

Example:
  python3 find_best_signal.py --tickers SPY,QQQ,AAPL,MSFT,NVDA,TSLA --years 5
  python3 find_best_signal.py --source csv --csv-dir ./my_polygon_bars --events earnings.csv
"""

import argparse
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------
# Data
# ----------------------------------------------------------------------------

UA = {"User-Agent": "Mozilla/5.0 (research backtest tool)"}


def yahoo_bars(ticker, start, end):
    """Daily bars from Yahoo Finance v8 chart API (split/dividend adjusted)."""
    p1 = int(datetime(start.year, start.month, start.day).timestamp())
    p2 = int((datetime(end.year, end.month, end.day) + timedelta(days=1)).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = json.loads(r.read().decode())
    res = payload["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    adj = res["indicators"].get("adjclose", [{}])[0].get("adjclose")
    idx = pd.to_datetime(ts, unit="s", utc=True).tz_convert(None).normalize()
    df = pd.DataFrame({
        "date": idx,
        "open": q["open"], "high": q["high"], "low": q["low"],
        "close": adj if adj is not None else q["close"],
        "volume": q["volume"],
    }).dropna(subset=["close"])
    return df.sort_values("date").reset_index(drop=True)


def stooq_bars(ticker, start, end):
    sym = ticker if "." in ticker else ticker + ".us"
    url = (f"https://stooq.com/q/d/l/?s={sym}"
           f"&d1={start:%Y%m%d}&d2={end:%Y%m%d}&i=d")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        df = pd.read_csv(io.StringIO(r.read().decode()))
    df = df.rename(columns={"Date": "date", "Open": "open", "High": "high",
                            "Low": "low", "Close": "close", "Volume": "volume"})
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def load_universe(tickers, start, end, source, csv_dir, data_dir):
    os.makedirs(data_dir, exist_ok=True)
    frames = []
    for t in tickers:
        t = t.strip().upper()
        cache = os.path.join(data_dir, f"{t}.csv")
        try:
            if source == "csv":
                path = os.path.join(csv_dir, f"{t}.csv")
                df = pd.read_csv(path, parse_dates=["date"])
            elif os.path.exists(cache):
                df = pd.read_csv(cache, parse_dates=["date"])
            else:
                df = yahoo_bars(t, start, end) if source == "yahoo" else stooq_bars(t, start, end)
                df.to_csv(cache, index=False)
        except Exception as e:  # noqa: BLE001 - one bad ticker must not kill the run
            print(f"  [warn] {t}: could not load ({e}); skipping", file=sys.stderr)
            continue
        df = df[(df["date"] >= pd.Timestamp(start)) & (df["date"] <= pd.Timestamp(end))]
        if len(df) < 300:
            print(f"  [warn] {t}: only {len(df)} bars; skipping", file=sys.stderr)
            continue
        df["ticker"] = t
        frames.append(df)
    if not frames:
        raise SystemExit("No usable ticker data. Check --tickers / --source.")
    panel = pd.concat(frames, ignore_index=True)
    print(f"Loaded {panel['ticker'].nunique()} tickers, {len(panel):,} bars "
          f"({panel['date'].min().date()} → {panel['date'].max().date()})")
    return panel


# ----------------------------------------------------------------------------
# Indicators (all computable at the close; no look-ahead)
# ----------------------------------------------------------------------------

def rsi(close, n=14):
    d = close.diff()
    ag = d.clip(lower=0).ewm(alpha=1 / n, min_periods=n, adjust=False).mean()
    al = (-d.clip(upper=0)).ewm(alpha=1 / n, min_periods=n, adjust=False).mean()
    return 100 - 100 / (1 + ag / al.replace(0, np.nan))


def atr_pct(high, low, close, n=14):
    pc = close.shift(1)
    tr = pd.concat([high - low, (high - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, min_periods=n, adjust=False).mean() / close


def add_features(df):
    c, o, h, l, v = df["close"], df["open"], df["high"], df["low"], df["volume"]
    f = pd.DataFrame(index=df.index)
    f["mom_20"] = c / c.shift(20) - 1          # 20-day momentum
    f["mom_60"] = c / c.shift(60) - 1          # 60-day momentum
    f["ma_cross"] = c.rolling(20).mean() / c.rolling(50).mean() - 1  # trend filter
    f["rsi_14"] = rsi(c)
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    f["macd_hist"] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
    bb_mid = c.rolling(20).mean()
    bb_sd = c.rolling(20).std()
    f["bb_pctb"] = (c - (bb_mid - 2 * bb_sd)) / (4 * bb_sd.replace(0, np.nan))
    f["atr_pct"] = atr_pct(h, l, c)
    f["vol_z"] = (v - v.rolling(20).mean()) / v.rolling(20).std().replace(0, np.nan)
    f["ret_5"] = c / c.shift(5) - 1            # short-term reversal leg
    f["gap"] = o / c.shift(1) - 1              # overnight news repricing
    f["intraday"] = c / o - 1
    roll_max_20 = c.shift(1).rolling(20).max()
    f["dist_20d_high"] = c / roll_max_20 - 1   # breakout proximity (prior window only)
    roll_max_252 = c.shift(1).rolling(252).max()
    roll_min_252 = c.shift(1).rolling(252).min()
    f["dist_52w_high"] = c / roll_max_252 - 1
    f["dist_52w_low"] = c / roll_min_252 - 1
    # catalyst proxies (binary, evaluated as-is)
    f["vol_spike"] = (f["vol_z"] > 2.0)
    f["gap_big"] = f["gap"].abs() > 1.5 * f["atr_pct"]
    f["breakout_vol"] = (f["dist_20d_high"] >= -0.002) & (f["vol_z"] > 1.0)
    return f


CONTINUOUS = ["mom_20", "mom_60", "ma_cross", "rsi_14", "macd_hist", "bb_pctb",
              "atr_pct", "vol_z", "ret_5", "gap", "intraday",
              "dist_20d_high", "dist_52w_high", "dist_52w_low"]
BINARY = ["vol_spike", "gap_big", "breakout_vol"]

MECHANISM = {
    "mom_20": "Trend persistence: slow information diffusion + herding; winners keep drifting (Jegadeesh–Titman intuition).",
    "mom_60": "Longer-horizon trend; separates sustained moves from 1-month noise.",
    "ma_cross": "Lagging trend filter; 20d above 50d = regime is up. Slow, so it misses turns.",
    "rsi_14": "Crowding gauge: extreme RSI = overbought/oversold → short-term mean reversion (liquidity provision).",
    "macd_hist": "Momentum acceleration; histogram flipping sign often leads price turns.",
    "bb_pctb": "Position within volatility envelope; tags outside the bands = stretch, fade candidate.",
    "atr_pct": "Volatility regime; predicts magnitude better than direction (volatility clustering).",
    "vol_z": "Abnormal volume = information arrival; informed trading shows in volume before price fully adjusts.",
    "ret_5": "1-week reversal leg: sharp up weeks tend to give back (overreaction).",
    "gap": "Overnight repricing on news; gaps often partially fill intraday, then resume.",
    "intraday": "Day-session strength vs overnight; persistent intraday drift = institutional accumulation.",
    "dist_20d_high": "Breakout proximity; new highs on volume = momentum ignition.",
    "dist_52w_high": "Anchoring: investors underreact near 52w highs (George–Hwang).",
    "dist_52w_low": "Capitulation/reversal zone; washed-out names bounce hardest — or keep falling.",
    "vol_spike": "CATALYST proxy: volume >2σ = something happened; trade the aftermath, not the spike.",
    "gap_big": "CATALYST proxy: gap >1.5× ATR = real overnight news, not noise.",
    "breakout_vol": "CATALYST proxy: 20-day high + confirming volume = conviction breakout.",
}


# ----------------------------------------------------------------------------
# Evaluation machinery
# ----------------------------------------------------------------------------

def dedupe_mask(mask, tickers, spacing):
    """Keep occurrences spaced >= `spacing` bars apart per ticker, so forward
    windows don't overlap and the t-stat isn't inflated by clustered signals."""
    keep = np.zeros(len(mask), dtype=bool)
    last = {}
    idx = np.flatnonzero(mask)
    for i in idx:
        t = tickers[i]
        if t not in last or i - last[t] >= spacing:
            keep[i] = True
            last[t] = i
    return keep


def tstat(x):
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n < 2:
        return 0.0
    se = x.std(ddof=1) / np.sqrt(n)
    return x.mean() / se if se > 0 else 0.0


def boot_ci(x, reps=500, seed=7):
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n < 2:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, n, size=(reps, n))].mean(axis=1)
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def evaluate(mask, fwd, base_hit):
    """Stats for one signal mask vs one forward-return horizon."""
    x = fwd[mask]
    n = int(mask.sum())
    if n == 0:
        return dict(n=0, mean=np.nan, std=np.nan, hit=np.nan, t=np.nan,
                    ci=(np.nan, np.nan), base_hit=float(base_hit))
    mean = float(x.mean())
    return dict(n=n, mean=mean, std=float(x.std(ddof=1)) if n > 1 else np.nan,
                hit=float((x > 0).mean()), t=tstat(x),
                ci=boot_ci(x), base_hit=float(base_hit))


def main():
    ap = argparse.ArgumentParser(description="Find the indicator/catalyst combo that actually forecasts moves.")
    ap.add_argument("--tickers", default="SPY,QQQ,AAPL,MSFT,NVDA,TSLA,AMD,META,AMZN,GOOGL,JPM,XOM")
    ap.add_argument("--years", type=float, default=5)
    ap.add_argument("--horizons", default="1,3,5,10,20")
    ap.add_argument("--train-frac", type=float, default=0.7)
    ap.add_argument("--min-n", type=int, default=30, help="min train occurrences to consider a signal")
    ap.add_argument("--min-test-n", type=int, default=20)
    ap.add_argument("--top-k", type=int, default=8, help="singles carried to combo stage")
    ap.add_argument("--source", choices=["yahoo", "stooq", "csv"], default="yahoo")
    ap.add_argument("--csv-dir", default="./bars")
    ap.add_argument("--data-dir", default="./data")
    ap.add_argument("--out", default="./results")
    ap.add_argument("--events", default=None, help="CSV with ticker,date for catalyst-window test")
    args = ap.parse_args()

    horizons = [int(h) for h in args.horizons.split(",")]
    end = datetime.now().date()
    start = end - timedelta(days=int(args.years * 365.25) + 400)  # pad for indicator warmup
    tickers = [t for t in args.tickers.split(",") if t.strip()]

    print("== 1. data ==")
    panel = load_universe(tickers, start, end, args.source, args.csv_dir, args.data_dir)

    print("== 2. indicators ==")
    parts = []
    for t, g in panel.groupby("ticker"):
        g = g.sort_values("date").reset_index(drop=True)
        f = add_features(g)
        f["ticker"] = t
        f["date"] = g["date"].values
        f["close"] = g["close"].values
        parts.append(f)
    feats = pd.concat(parts, ignore_index=True)
    for H in horizons:
        feats[f"fwd_{H}"] = feats.groupby("ticker")["close"].transform(
            lambda c: c.shift(-H) / c - 1)
    feats = feats.dropna(subset=[f"fwd_{horizons[-1]}"]).reset_index(drop=True)
    feats = feats.sort_values(["ticker", "date"]).reset_index(drop=True)
    tickers_arr = feats["ticker"].values

    # chronological train/test split per ticker
    feats["is_train"] = False
    for t, g in feats.groupby("ticker"):
        cut = int(len(g) * args.train_frac)
        feats.loc[g.index[np.arange(len(g)) < cut], "is_train"] = True
    tr = feats[feats["is_train"]].reset_index(drop=True)
    te = feats[~feats["is_train"]].reset_index(drop=True)
    tr_tickers = tr["ticker"].values
    te_tickers = te["ticker"].values
    print(f"train bars: {len(tr):,}   test bars: {len(te):,} "
          f"(test from {te['date'].min().date()})")

    base = {H: (float((feats[f'fwd_{H}'] > 0).mean()), float(feats[f'fwd_{H}'].mean()))
            for H in horizons}

    # ---- 3. single signals: cutoffs fit on TRAIN only ----
    print("== 3. single signals (ranked on train, judged on test) ==")
    signals = {}  # name -> dict(side -> boolean masks on tr/te)
    for col in CONTINUOUS:
        x = tr[col].dropna()
        if len(x) < 100:
            continue
        lo, hi = x.quantile(0.10), x.quantile(0.90)
        signals[f"{col}__long"] = ("long",
            tr[col].ge(hi).fillna(False).values, te[col].ge(hi).fillna(False).values)
        signals[f"{col}__short"] = ("short",
            tr[col].le(lo).fillna(False).values, te[col].le(lo).fillna(False).values)
    for col in BINARY:
        m_tr = tr[col].fillna(False).values.astype(bool)
        m_te = te[col].fillna(False).values.astype(bool)
        if m_tr.sum() >= args.min_n:
            signals[f"{col}"] = ("long", m_tr, m_te)

    n_tests = len(signals) * len(horizons)
    rows = []
    for name, (side, m_tr, m_te) in signals.items():
        for H in horizons:
            dm_tr = dedupe_mask(m_tr, tr_tickers, H)
            dm_te = dedupe_mask(m_te, te_tickers, H)
            s_tr = evaluate(dm_tr, tr[f"fwd_{H}"].values, base[H][0])
            s_te = evaluate(dm_te, te[f"fwd_{H}"].values, base[H][0])
            if s_tr.get("n", 0) < args.min_n:
                continue
            score_tr = s_tr["t"] if side == "long" else -s_tr["t"]
            score_te = s_te["t"] if side == "long" else -s_te["t"]
            rows.append(dict(signal=name, side=side, H=H,
                             n_tr=s_tr["n"], mean_tr=s_tr["mean"], t_tr=score_tr,
                             n_te=s_te.get("n", 0), mean_te=s_te.get("mean", np.nan),
                             hit_te=s_te.get("hit", np.nan), t_te=score_te,
                             ci_te=s_te.get("ci", (np.nan, np.nan)),
                             base_hit=base[H][0], base_mean=base[H][1]))
    singles = pd.DataFrame(rows)
    if singles.empty:
        raise SystemExit("No signals met min-n. Lower --min-n or widen universe.")

    # top-K by train t-stat for the combo stage (keep side+H identity)
    topk = (singles.sort_values("t_tr", ascending=False)
            .groupby("signal").first().reset_index()
            .sort_values("t_tr", ascending=False).head(args.top_k))

    # ---- 4. combos: pairwise intersections + z-composite ----
    print("== 4. combos ==")
    combo_masks_tr, combo_masks_te, combo_meta = {}, {}, {}
    names = topk["signal"].tolist()
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            sa, ma_tr, ma_te = signals[a][0], signals[a][1], signals[a][2]
            sb, mb_tr, mb_te = signals[b][0], signals[b][1], signals[b][2]
            if sa == sb:  # agreement combo
                key = f"({a})&({b})"
                combo_masks_tr[key] = ma_tr & mb_tr
                combo_masks_te[key] = ma_te & mb_te
                combo_meta[key] = sa
    # z-score composite of sign-aligned top-K features
    z_tr = np.zeros(len(tr))
    z_te = np.zeros(len(te))
    for _, r in topk.iterrows():
        col = r["signal"].rsplit("__", 1)[0]
        if col not in CONTINUOUS:
            continue
        mu, sd = tr[col].mean(), tr[col].std()
        if not np.isfinite(sd) or sd == 0:
            continue
        align = 1.0 if (r["mean_tr"] > 0) == (r["side"] == "long") else -1.0
        z_tr += align * ((tr[col] - mu) / sd).fillna(0).values
        z_te += align * ((te[col] - mu) / sd).fillna(0).values
    z_cut = np.nanquantile(z_tr, 0.90)
    combo_masks_tr["z_composite__long"] = z_tr >= z_cut
    combo_masks_te["z_composite__long"] = z_te >= z_cut
    combo_meta["z_composite__long"] = "long"

    crows = []
    for key, m_tr in combo_masks_tr.items():
        side = combo_meta[key]
        m_te = combo_masks_te[key]
        for H in horizons:
            dm_tr = dedupe_mask(m_tr, tr_tickers, H)
            dm_te = dedupe_mask(m_te, te_tickers, H)
            s_tr = evaluate(dm_tr, tr[f"fwd_{H}"].values, base[H][0])
            s_te = evaluate(dm_te, te[f"fwd_{H}"].values, base[H][0])
            if s_tr.get("n", 0) < args.min_n:
                continue
            score_tr = s_tr["t"] if side == "long" else -s_tr["t"]
            score_te = s_te["t"] if side == "long" else -s_te["t"]
            crows.append(dict(signal=key, side=side, H=H,
                              n_tr=s_tr["n"], mean_tr=s_tr["mean"], t_tr=score_tr,
                              n_te=s_te.get("n", 0), mean_te=s_te.get("mean", np.nan),
                              hit_te=s_te.get("hit", np.nan), t_te=score_te,
                              ci_te=s_te.get("ci", (np.nan, np.nan)),
                              base_hit=base[H][0], base_mean=base[H][1]))
    combos = pd.DataFrame(crows)

    # ---- 5. pick the winner on TEST data only ----
    def pick(df):
        ok = df[df["n_te"] >= args.min_test_n]
        if ok.empty:
            return None
        return ok.sort_values("t_te", ascending=False).iloc[0]

    best_single = pick(singles)
    best_combo = pick(combos) if not combos.empty else None
    bonf_alpha = 0.05 / max(n_tests, 1)

    os.makedirs(args.out, exist_ok=True)
    singles.to_csv(f"{args.out}/singles.csv", index=False)
    if not combos.empty:
        combos.to_csv(f"{args.out}/combos.csv", index=False)

    # ---- 6. optional catalyst event windows ----
    event_txt = ""
    if args.events and os.path.exists(args.events):
        print("== 5. catalyst event windows ==")
        ev = pd.read_csv(args.events, parse_dates=["date"])
        close_map = {t: g.set_index("date")["close"] for t, g in feats.groupby("ticker")}
        wins = {"pre_20_6": (-20, -6), "runup_5_1": (-5, -1),
                "event_0_2": (0, 2), "drift_3_20": (3, 20)}
        erows = []
        for _, e in ev.iterrows():
            s = close_map.get(str(e["ticker"]).upper())
            if s is None:
                continue
            d0 = pd.Timestamp(e["date"]).normalize()
            if d0 not in s.index:
                continue
            i0 = s.index.get_loc(d0)
            for wname, (a, b) in wins.items():
                ia, ib = i0 + a - 1, i0 + b
                if ia < 0 or ib >= len(s):
                    continue
                erows.append(dict(window=wname,
                                  ret=float(s.iloc[ib] / s.iloc[ia] - 1)))
        evdf = pd.DataFrame(erows)
        if not evdf.empty:
            event_txt = "\n### Catalyst event windows (from --events)\n\n"
            event_txt += "| window (days rel. event) | n | mean return | t-stat |\n|---|---:|---:|---:|\n"
            for w, g in evdf.groupby("window"):
                event_txt += (f"| {w} | {len(g)} | {g['ret'].mean():+.2%} | "
                              f"{tstat(g['ret'].values):+.2f} |\n")

    # ---- report ----
    def fmt_row(r):
        lo, hi = r["ci_te"]
        return (f"| {r['signal']} | {r['side']} | {r['H']}d | {r['n_te']} | "
                f"{r['mean_te']:+.2%} [{lo:+.2%}, {hi:+.2%}] | {r['hit_te']:.0%} "
                f"(base {r['base_hit']:.0%}) | {r['t_te']:+.2f} |")

    header = "| signal | side | horizon | n (test) | mean fwd return [95% CI] | hit rate | t-stat |"
    sep = "|---|---|---|---:|---|---|---:|"

    def table(df, k=10):
        ok = df[df["n_te"] >= args.min_test_n].sort_values("t_te", ascending=False).head(k)
        return "\n".join([header, sep] + [fmt_row(r) for _, r in ok.iterrows()])

    def verdict(r, kind):
        if r is None:
            return f"No {kind} survived the test-set size filter."
        lo, hi = r["ci_te"]
        excess = r["mean_te"] - r["base_mean"]
        sig = "yes" if (lo > 0 and r["side"] == "long") or (hi < 0 and r["side"] == "short") else "no"
        return (f"**{r['signal']}** ({r['side']}), **{r['H']}-trading-day window**, "
                f"expected move **{r['mean_te']:+.2%}** (95% CI [{lo:+.2%}, {hi:+.2%}], "
                f"n={r['n_te']}, hit rate {r['hit_te']:.0%} vs base {r['base_hit']:.0%}, "
                f"excess over base {excess:+.2%}). CI excludes zero: {sig}.")

    report = f"""# Signal lab report — {datetime.now():%Y-%m-%d}

Universe: {', '.join(sorted(feats['ticker'].unique()))} · bars {feats['date'].min().date()} → {feats['date'].max().date()} ·
train {len(tr):,} bars / test {len(te):,} bars (test from {te['date'].min().date()}) ·
{n_tests} signal×horizon tests (Bonferroni α ≈ {bonf_alpha:.2e}).

## The reasoning

Forecasting returns is a signal-extraction problem with a terrible signal-to-noise
ratio. The failure mode is not "no ideas" but "too many ideas, all backfit."
Hence: chronological split, rule cutoffs fit on train only, ranking on train,
judgment on test, and an explicit multiple-comparison budget.

Why these candidates — each maps to a market mechanism, not a squiggle:

| indicator | mechanism |
|---|---|
"""
    for col in CONTINUOUS + BINARY:
        report += f"| `{col}` | {MECHANISM[col]} |\n"
    report += f"""
Combinations are intersections (both signals must agree), which cut false
positives by demanding confirmation, plus one sign-aligned z-score composite.
Kitchen-sink regressions were deliberately avoided: with this SNR they
memorize noise.

## Best single indicator

{verdict(best_single, "single signal")}

### Top singles on the test set

{table(singles)}

## Best combo

{verdict(best_combo, "combo")}

### Top combos on the test set

{table(combos) if not combos.empty else "_No combos met the size filter._"}

{event_txt}
## Caveats

- These are close-to-close, frictionless numbers. Spreads, slippage, borrow
  cost and taxes eat a large share of small edges — especially 1-day horizons.
- The test set is one historical regime. A signal that worked 2021–2026 may
  not work 2026–2030. Re-run quarterly; distrust any edge with n < 50.
- With {n_tests} tests, expect ~{n_tests * 0.05:.0f} "significant" (p<0.05)
  winners by pure luck. The Bonferroni bar above is the honest one.
- Signal occurrences are de-duplicated so forward windows don't overlap
  (spacing = horizon); without this, a signal that fires 20 days in a row
  during one crash would count as 20 "independent" wins.
- Yahoo bars are split/dividend adjusted; corporate-action handling differs
  across vendors, so cross-check any live candidate against your Polygon feed.
"""
    with open(f"{args.out}/REPORT.md", "w") as f:
        f.write(report)

    # ---- console ----
    print("\n================ RESULT ================")
    print(f"Base rates: " + ", ".join(f"{H}d: {base[H][1]:+.2%} avg, {base[H][0]:.0%} up" for H in horizons))
    print(f"\nBest SINGLE: {verdict(best_single, 'single signal')}")
    print(f"\nBest COMBO:  {verdict(best_combo, 'combo')}")
    print(f"\nFull tables: {args.out}/singles.csv, {args.out}/combos.csv, {args.out}/REPORT.md")


if __name__ == "__main__":
    main()
