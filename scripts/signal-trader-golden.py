#!/usr/bin/env python3
"""
Golden file for the Signal Trader port: what the lab ITSELF says.

Runs the lab's own code (research/signal-lab/find_best_signal.py) on its own
CSVs and writes:
  research/signal-lab/golden.json   every long-rule firing per ticker, plus cutoffs
  lib/signal-trader/cutoffs.json    the train-set decile cutoffs the app trades on

The lab derives its start date from "now" (find_best_signal.py lines 258-259),
so running it on a different day silently changes the sample. AS_OF pins it to
the report's run date. The script exits non-zero unless vol_spike's 10-day
test n equals the report's 162, which proves this replication IS the report.

  python scripts/signal-trader-golden.py
"""
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LAB = os.path.join(ROOT, "research", "signal-lab")
sys.path.insert(0, LAB)
import find_best_signal as lab  # noqa: E402

AS_OF = date(2026, 10, 10)
YEARS, HORIZONS, TRAIN_FRAC = 5, [1, 3, 5, 10, 20], 0.7
TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMD", "META",
           "AMZN", "GOOGL", "JPM", "XOM"]
EXPECTED_VOL_SPIKE_10D_TEST_N = 162


def main():
    start = AS_OF - timedelta(days=int(YEARS * 365.25) + 400)
    data = os.path.join(LAB, "data")
    panel = lab.load_universe(TICKERS, start, AS_OF, "csv", data, data)

    parts = []
    for t, g in panel.groupby("ticker"):
        g = g.sort_values("date").reset_index(drop=True)
        f = lab.add_features(g)
        f["ticker"] = t
        f["date"] = g["date"].values
        f["close"] = g["close"].values
        parts.append(f)
    feats_all = pd.concat(parts, ignore_index=True)

    # The lab's main(), lines 274-292: forward returns, drop the rows the
    # longest horizon cannot score, chronological 70/30 split PER TICKER.
    feats = feats_all.copy()
    for H in HORIZONS:
        feats[f"fwd_{H}"] = feats.groupby("ticker")["close"].transform(
            lambda c, H=H: c.shift(-H) / c - 1)
    feats = feats.dropna(subset=[f"fwd_{HORIZONS[-1]}"]).reset_index(drop=True)
    feats = feats.sort_values(["ticker", "date"]).reset_index(drop=True)
    feats["is_train"] = False
    for t, g in feats.groupby("ticker"):
        cut = int(len(g) * TRAIN_FRAC)
        feats.loc[g.index[np.arange(len(g)) < cut], "is_train"] = True
    tr = feats[feats["is_train"]].reset_index(drop=True)
    te = feats[~feats["is_train"]].reset_index(drop=True)

    cutoffs = {}
    for col in lab.CONTINUOUS:
        x = tr[col].dropna()
        cutoffs[col] = {"lo": float(x.quantile(0.10)), "hi": float(x.quantile(0.90))}

    m = te["vol_spike"].fillna(False).values.astype(bool)
    n = int(lab.dedupe_mask(m, te["ticker"].values, 10).sum())
    if n != EXPECTED_VOL_SPIKE_10D_TEST_N:
        sys.exit(f"vol_spike 10d test n = {n}, expected "
                 f"{EXPECTED_VOL_SPIKE_10D_TEST_N}: the replication is wrong")

    def dates(mask):
        out = {}
        for t, g in feats_all[mask].groupby("ticker"):
            out[t] = [pd.Timestamp(d).strftime("%Y-%m-%d") for d in g["date"]]
        return out

    firings = {}
    for col in lab.CONTINUOUS:
        firings[f"{col}__long"] = dates(feats_all[col].ge(cutoffs[col]["hi"]).fillna(False).values)
    for col in lab.BINARY:
        firings[col] = dates(feats_all[col].fillna(False).values.astype(bool))

    golden = {
        "as_of": AS_OF.isoformat(),
        "start": start.isoformat(),
        "tickers": sorted(TICKERS),
        "cutoffs": cutoffs,
        "check": {"vol_spike_10d_test_n": n},
        "firings": firings,
    }
    with open(os.path.join(LAB, "golden.json"), "w") as f:
        json.dump(golden, f, separators=(",", ":"))
    with open(os.path.join(ROOT, "lib", "signal-trader", "cutoffs.json"), "w") as f:
        json.dump({"as_of": AS_OF.isoformat(), "train_frac": TRAIN_FRAC,
                   "source": "research/signal-lab", "cutoffs": cutoffs}, f, indent=2)
        f.write("\n")
    total = sum(len(v) for r in firings.values() for v in r.values())
    print(f"golden.json: {len(firings)} rules, {total} firings; vol_spike 10d test n = {n}")
    print(f"start {start.isoformat()}  as_of {AS_OF.isoformat()}")


if __name__ == "__main__":
    main()
