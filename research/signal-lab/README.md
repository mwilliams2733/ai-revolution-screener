# stock-signal-lab

`find_best_signal.py` — which indicator / catalyst (or combo) actually forecasts
stock movement, and over what window, with what expected % move.

## What it does

1. Downloads daily bars (default: free Yahoo Finance, no key, no credit cost).
2. Computes 14 indicators + 3 catalyst proxies, all knowable at the close.
3. Splits history chronologically (default 70/30 train/test). Rule cutoffs
   (e.g. decile thresholds) are fit on **train only**.
4. Ranks signals on train by t-stat, then reports honest **test-set** stats:
   n, hit rate vs base rate, mean forward return, bootstrap 95% CI, excess
   over base.
5. Tests combos as pairwise intersections of the top-8 train signals plus a
   sign-aligned z-score composite — same train/test discipline.
6. Signal occurrences are de-duplicated (spacing = horizon) so one 20-day
   crash doesn't count as 20 independent wins.
7. Optional `--events ticker,date` CSV tests catalyst windows (earnings
   proximity: pre-run, run-up, event, post-drift).

## Run

```bash
python3 find_best_signal.py --out ./results
python3 find_best_signal.py --tickers AAPL,MSFT,NVDA --years 3 --horizons 1,5,10
python3 find_best_signal.py --source csv --csv-dir ./bars   # your own bars (e.g. Polygon exports)
python3 find_best_signal.py --events earnings.csv
```

Needs: `pandas`, `numpy`. Outputs: console verdict, `results/singles.csv`,
`results/combos.csv`, `results/REPORT.md` (full reasoning + mechanism table).

## Notes

- `--source stooq` also supported if your network reaches stooq.com.
- For Polygon data without extra credit cost: dump the aggregates your
  existing jobs already pull into `--csv-dir` as `<TICKER>.csv` with
  `date,open,high,low,close,volume` columns.
- Events CSV format: header `ticker,date`, one row per catalyst date.
- Re-run quarterly; distrust any edge with n < 50 or that only works in
  one regime. Numbers are frictionless close-to-close — spreads and
  slippage eat small edges.
