#!/usr/bin/env python3
"""
AI Revolution strategy screener.

Reproduces the reverse-engineered selection and position-sizing logic decoded from
the AI Revolution Portfolio board meeting and position-size calculator.

Pipeline:
  theme gate -> liquidity gate -> crowding veto -> RS rank -> trend gate -> tier

Data: Polygon-compatible REST API (polygon.io or massive.com). Only two endpoint
families are required, both available on entry-level plans:
    /v3/reference/tickers
    /v2/aggs/grouped/locale/us/market/stocks/{date}

Usage:
    export POLYGON_API_KEY=...
    python screener.py --run
    python screener.py --selftest          # validates math, no network needed
    python screener.py --run --no-theme    # unfiltered universe, for comparison
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional

try:
    import requests
except ImportError:
    requests = None

API_BASE = os.environ.get("POLYGON_BASE", "https://api.polygon.io")
API_KEY = os.environ.get("POLYGON_API_KEY", "")
CACHE = Path(os.environ.get("SCREENER_CACHE", "./.cache"))

# ---------------------------------------------------------------------------
# Tunable parameters. These are the decoded strategy constants.
# ---------------------------------------------------------------------------

@dataclass
class Params:
    # Liquidity gate
    min_price: float = 5.0
    min_dollar_volume: float = 10_000_000.0

    # Relative strength blend. Weights sum to 1.0.
    w_r3m: float = 0.40
    w_r6m: float = 0.30
    w_r12m: float = 0.30

    # Tier cutoffs, expressed as RS percentile against the ranked universe.
    strong_rs: float = 80.0
    buy_rs: float = 55.0

    # Trend gate. Price relative to the moving-average proxy, in percent.
    strong_trend: float = 0.0
    buy_trend: float = 0.0

    # Tier weights as a fraction of the sleeve.
    w_strong: float = 0.0743
    w_buy: float = 0.0500
    w_hold: float = 0.0260

    # Target position counts per tier.
    n_strong: int = 7
    n_buy: int = 7
    n_hold: int = 5

    # Trading-day offsets used as return anchors.
    lookbacks: Dict[str, int] = field(
        default_factory=lambda: {"r1m": 21, "r3m": 63, "r6m": 126, "r12m": 252}
    )


# ---------------------------------------------------------------------------
# Theme universe: the CapEx-taker gate.
#
# This is the discretionary layer and it does most of the selection work. Edit
# freely. The rule that defines membership: the company should be a net
# beneficiary of AI infrastructure spending, not a net spender. Hyperscalers are
# excluded by design.
# ---------------------------------------------------------------------------

THEME = {
    "compute_gpu_cpu": ["NVDA", "AMD", "ARM", "AVGO", "MRVL", "INTC", "QCOM", "MU", "SMCI"],
    "semicap_equipment": ["AMAT", "LRCX", "KLAC", "ASML", "TER", "ONTO", "ACMR", "AEHR",
                          "UCTT", "ICHR", "CAMT", "NVMI", "AXTI", "COHU", "FORM"],
    "foundry_packaging": ["TSM", "GFS", "AMKR", "UMC", "ASX"],
    "optics_networking": ["LITE", "COHR", "AAOI", "FN", "CIEN", "ANET", "CRDO", "ALAB",
                          "MTSI", "SITM", "POET", "INFN", "EXTR", "JNPR"],
    "power_thermal_datacenter": ["VRT", "ETN", "PWR", "AGX", "MOD", "GEV", "PH", "HUBB",
                                 "NVT", "AAON", "CARR", "JCI", "ATKR", "EMR", "ROK"],
    "materials_specialty": ["CRS", "ATI", "HAYN", "MTRN", "ENTG", "CBT", "IIVI"],
    "security_identity": ["FTNT", "PANW", "CRWD", "ZS", "OKTA", "S", "CYBR", "TENB",
                          "QLYS", "RPD", "VRNS", "EVLV", "FFIV"],
    "data_infra_software": ["PLTR", "SNOW", "MDB", "DDOG", "CFLT", "ESTC", "NTNX",
                            "PSTG", "NTAP", "DELL", "HPE", "IOT", "TOST"],
    "robotics_automation": ["SYM", "FANUY", "OMRNY", "TMRAY", "ROK", "TER", "ZBRA",
                            "CGNX", "NDSN", "IRBT"],
    "defense_space_autonomy": ["KTOS", "AVAV", "RDW", "LHX", "LMT", "RTX", "NOC",
                               "PLTR", "RKLB", "LUNR", "BWXT", "LDOS"],
    "ai_appliers": ["LLY", "TOST", "ISRG", "VEEV", "TTD", "APP", "DUOL", "HOOD",
                    "SHOP", "NOW", "CRM", "ADBE"],
}

# Excluded by rule: net AI CapEx spenders.
CAPEX_SPENDERS = {"MSFT", "GOOGL", "GOOG", "META", "AMZN", "AAPL", "ORCL", "IBM", "TSLA"}

# Crowding veto. Cohorts judged too crowded or speculative regardless of score.
# Decoded from the transcript's explicit rejection of the memory/storage trade.
CROWDING_VETO = {"SNDK", "MU", "WDC", "STX", "SK", "MRAM"}


def theme_universe(include_veto: bool = False) -> Dict[str, str]:
    """Return {ticker: sector} for the theme universe."""
    out: Dict[str, str] = {}
    for sector, names in THEME.items():
        for t in names:
            if t in CAPEX_SPENDERS:
                continue
            if not include_veto and t in CROWDING_VETO:
                continue
            out.setdefault(t, sector)
    return out


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------

def _get(path: str, params: Optional[dict] = None, retries: int = 4) -> dict:
    if requests is None:
        raise RuntimeError("requests not installed: pip install requests")
    if not API_KEY:
        raise RuntimeError("POLYGON_API_KEY is not set")
    params = dict(params or {})
    params["apiKey"] = API_KEY
    url = f"{API_BASE}{path}"
    for attempt in range(retries):
        r = requests.get(url, params=params, timeout=60)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            time.sleep(2 ** attempt * 2)
            continue
        if r.status_code == 403:
            raise PermissionError(
                f"403 on {path}. Your plan does not include this endpoint."
            )
        r.raise_for_status()
    raise RuntimeError(f"exhausted retries on {path}")


def trading_days_back(end: date, n: int) -> date:
    """Approximate a trading-day offset by walking back over weekdays.

    Ignores exchange holidays. The screener tolerates this because a missing
    grouped-daily response falls back to the nearest prior available session.
    """
    d, remaining = end, n
    while remaining > 0:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            remaining -= 1
    return d


def grouped_daily(day: date, use_cache: bool = True) -> Dict[str, dict]:
    """All US stock bars for one session, keyed by ticker."""
    CACHE.mkdir(parents=True, exist_ok=True)
    fp = CACHE / f"grouped_{day.isoformat()}.json"
    if use_cache and fp.exists():
        return json.loads(fp.read_text())
    js = _get(
        f"/v2/aggs/grouped/locale/us/market/stocks/{day.isoformat()}",
        {"adjusted": "true"},
    )
    rows = {r["T"]: r for r in js.get("results", []) or []}
    fp.write_text(json.dumps(rows))
    return rows


def grouped_with_fallback(day: date, max_back: int = 6) -> Dict[str, dict]:
    """Walk backwards past holidays until a session with data is found."""
    d = day
    for _ in range(max_back):
        rows = grouped_daily(d)
        if rows:
            return rows
        d -= timedelta(days=1)
        while d.weekday() >= 5:
            d -= timedelta(days=1)
    return {}


def common_stock_universe(use_cache: bool = True) -> Dict[str, str]:
    """{ticker: name} for active US common stocks on major exchanges."""
    CACHE.mkdir(parents=True, exist_ok=True)
    fp = CACHE / "ref_cs.json"
    if use_cache and fp.exists():
        return json.loads(fp.read_text())
    out: Dict[str, str] = {}
    cursor = None
    while True:
        params = {"market": "stocks", "active": "true", "type": "CS", "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        js = _get("/v3/reference/tickers", params)
        for r in js.get("results", []) or []:
            if r.get("primary_exchange") in ("XNYS", "XNAS", "XASE"):
                out[r["ticker"]] = r.get("name", "")
        nxt = js.get("next_url")
        if not nxt:
            break
        cursor = nxt.split("cursor=")[-1].split("&")[0]
        time.sleep(0.2)
    fp.write_text(json.dumps(out))
    return out


# ---------------------------------------------------------------------------
# Factor math
# ---------------------------------------------------------------------------

def pct_change(now: float, then: float) -> Optional[float]:
    if not then or then <= 0 or not now or now <= 0:
        return None
    return 100.0 * (now / then - 1.0)


def rs_score(r3m: float, r6m: float, r12m: float, p: Params) -> float:
    return p.w_r3m * r3m + p.w_r6m * r6m + p.w_r12m * r12m


def percentile_ranks(values: List[float]) -> List[float]:
    """Percentile rank, 0-100, higher value gets a higher percentile.

    Tied values share the average of their ranks. Kept in sync with
    percentileRanks() in ts/lib/factors.ts.
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [100.0]
    order = sorted(range(n), key=lambda i: values[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        pct = 100.0 * ((i + j) / 2.0) / (n - 1)
        for k in range(i, j + 1):
            out[order[k]] = pct
        i = j + 1
    return out


@dataclass
class Row:
    ticker: str
    name: str = ""
    sector: str = ""
    price: float = 0.0
    dollar_volume: float = 0.0
    r1m: Optional[float] = None
    r3m: Optional[float] = None
    r6m: Optional[float] = None
    r12m: Optional[float] = None
    ma_proxy: Optional[float] = None
    vs_ma: Optional[float] = None
    rs_raw: Optional[float] = None
    rs_pct: Optional[float] = None
    tier: str = ""
    weight: float = 0.0


def assign_tier(rs_pct: float, vs_ma: float, p: Params) -> str:
    if rs_pct >= p.strong_rs and vs_ma > p.strong_trend:
        return "Strong Buy"
    if rs_pct >= p.buy_rs and vs_ma >= p.buy_trend:
        return "Buy"
    return "Hold"


def build_rows(
    snapshots: Dict[str, Dict[str, dict]],
    universe: Dict[str, str],
    names: Dict[str, str],
    p: Params,
) -> List[Row]:
    """snapshots maps anchor label -> {ticker: bar}. 'now' is required."""
    now = snapshots["now"]
    rows: List[Row] = []
    for tk, sector in universe.items():
        bar = now.get(tk)
        if not bar:
            continue
        px = bar.get("c", 0.0)
        dv = bar.get("v", 0.0) * bar.get("vw", bar.get("c", 0.0) or 0.0)
        if px < p.min_price or dv < p.min_dollar_volume:
            continue
        anchors = {}
        for label in ("r1m", "r3m", "r6m", "r12m"):
            b = snapshots.get(label, {}).get(tk)
            anchors[label] = b.get("c") if b else None
        if not all(anchors.get(k) for k in ("r3m", "r6m", "r12m")):
            continue
        r = Row(ticker=tk, name=names.get(tk, ""), sector=sector, price=px, dollar_volume=dv)
        r.r1m = pct_change(px, anchors["r1m"]) if anchors["r1m"] else None
        r.r3m = pct_change(px, anchors["r3m"])
        r.r6m = pct_change(px, anchors["r6m"])
        r.r12m = pct_change(px, anchors["r12m"])
        pts = [px] + [v for v in anchors.values() if v]
        r.ma_proxy = sum(pts) / len(pts)
        r.vs_ma = pct_change(px, r.ma_proxy)
        r.rs_raw = rs_score(r.r3m, r.r6m, r.r12m, p)
        rows.append(r)
    if rows:
        pcts = percentile_ranks([r.rs_raw for r in rows])
        for r, q in zip(rows, pcts):
            r.rs_pct = q
            r.tier = assign_tier(q, r.vs_ma or 0.0, p)
            r.weight = {"Strong Buy": p.w_strong, "Buy": p.w_buy, "Hold": p.w_hold}[r.tier]
    rows.sort(key=lambda r: r.rs_raw, reverse=True)
    return rows


def build_portfolio(rows: List[Row], p: Params) -> List[Row]:
    """Take the top N of each tier, matching the delivered portfolio shape."""
    caps = {"Strong Buy": p.n_strong, "Buy": p.n_buy, "Hold": p.n_hold}
    seen = {k: 0 for k in caps}
    out: List[Row] = []
    for r in rows:
        if seen[r.tier] < caps[r.tier]:
            out.append(r)
            seen[r.tier] += 1
    return out


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def fmt(v: Optional[float], nd: int = 1, suffix: str = "") -> str:
    return "n/a" if v is None else f"{v:,.{nd}f}{suffix}"


def print_table(rows: List[Row], title: str, limit: int = 60) -> None:
    print(f"\n{title}")
    print("-" * 108)
    print(f"{'#':>3} {'TICKER':<7} {'SECTOR':<24} {'PRICE':>10} "
          f"{'3M':>8} {'6M':>8} {'12M':>9} {'vsMA':>7} {'RS':>5} {'TIER':<11} {'WT':>6}")
    print("-" * 108)
    for i, r in enumerate(rows[:limit], 1):
        print(f"{i:>3} {r.ticker:<7} {r.sector[:24]:<24} {fmt(r.price, 2):>10} "
              f"{fmt(r.r3m):>8} {fmt(r.r6m):>8} {fmt(r.r12m):>9} {fmt(r.vs_ma):>7} "
              f"{fmt(r.rs_pct, 0):>5} {r.tier:<11} {r.weight * 100:>5.2f}%")
    print("-" * 108)


def write_csv(rows: List[Row], path: Path) -> None:
    import csv
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ticker", "name", "sector", "price", "dollar_volume",
                    "r1m", "r3m", "r6m", "r12m", "vs_ma", "rs_raw", "rs_pct",
                    "tier", "weight"])
        for r in rows:
            w.writerow([r.ticker, r.name, r.sector, round(r.price, 4),
                        round(r.dollar_volume, 0),
                        fmt(r.r1m, 2), fmt(r.r3m, 2), fmt(r.r6m, 2), fmt(r.r12m, 2),
                        fmt(r.vs_ma, 2), fmt(r.rs_raw, 3), fmt(r.rs_pct, 1),
                        r.tier, round(r.weight, 4)])


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------

def run(asof: Optional[str], use_theme: bool, p: Params, out_csv: Optional[str]) -> int:
    end = datetime.strptime(asof, "%Y-%m-%d").date() if asof else date.today()
    print(f"as of {end.isoformat()}")

    names = common_stock_universe()
    print(f"reference universe: {len(names):,} common stocks")

    snapshots = {"now": grouped_with_fallback(end)}
    for label, back in p.lookbacks.items():
        d = trading_days_back(end, back)
        snapshots[label] = grouped_with_fallback(d)
        print(f"  anchor {label:>4}: {d.isoformat()} ({len(snapshots[label]):,} bars)")

    if use_theme:
        universe = theme_universe()
        universe = {t: s for t, s in universe.items() if t in names}
        label = "theme universe (CapEx takers)"
    else:
        universe = {t: "" for t in names}
        label = "full liquid universe"

    rows = build_rows(snapshots, universe, names, p)
    print(f"\n{label}: {len(rows):,} names passed liquidity")

    print_table(rows, "RANKED BY RELATIVE STRENGTH")

    port = build_portfolio(rows, p)
    print_table(port, f"MODEL PORTFOLIO ({p.n_strong}/{p.n_buy}/{p.n_hold})", limit=99)
    total = sum(r.weight for r in port)
    print(f"total allocation: {total * 100:.1f}%   cash: {(1 - total) * 100:.1f}%")

    if out_csv:
        write_csv(rows, Path(out_csv))
        print(f"wrote {out_csv}")
    return 0


def selftest() -> int:
    """Validate the math against values derived from the real portfolio."""
    p = Params()
    ok = True

    def check(label: str, got, want, tol=0.01):
        nonlocal ok
        good = abs(got - want) <= tol
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {label}: got {got:.4f}, want {want:.4f}")

    print("selftest: factor math")
    check("pct_change 110 from 100", pct_change(110, 100), 10.0)
    check("pct_change halved", pct_change(50, 100), -50.0)
    check("rs blend", rs_score(10, 20, 30, p), 0.4 * 10 + 0.3 * 20 + 0.3 * 30)

    print("selftest: percentile ranks")
    pr = percentile_ranks([1.0, 2.0, 3.0, 4.0, 5.0])
    check("min is 0", pr[0], 0.0)
    check("max is 100", pr[-1], 100.0)
    check("median is 50", pr[2], 50.0)

    print("selftest: tier assignment")
    cases = [
        (99.0, 29.2, "Strong Buy", "LITE profile"),
        (98.0, 56.2, "Strong Buy", "MRVL profile"),
        (68.0, 19.0, "Buy", "PLTR profile"),
        (47.0, 8.6, "Hold", "NVDA profile"),
        (15.0, -4.2, "Hold", "KTOS profile"),
        (8.0, -9.3, "Hold", "SYM profile"),
    ]
    for rs, vsma, want, label in cases:
        got = assign_tier(rs, vsma, p)
        good = got == want
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {label}: {got} (want {want})")

    print("selftest: tier weights sum to the delivered book")
    total = p.n_strong * p.w_strong + p.n_buy * p.w_buy + p.n_hold * p.w_hold
    check("total allocation", total * 100, 52.0 + 35.0 + 13.0, tol=0.35)

    print("selftest: theme universe")
    uni = theme_universe()
    for spender in ("MSFT", "GOOGL", "META", "AMZN"):
        good = spender not in uni
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {spender} excluded as CapEx spender")
    for veto in ("SNDK", "MU", "WDC"):
        good = veto not in uni
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {veto} excluded by crowding veto")
    print(f"  theme universe size: {len(uni)} names")

    print("selftest: trading-day walkback")
    d = trading_days_back(date(2026, 8, 19), 21)
    good = d.weekday() < 5
    ok &= good
    print(f"  [{'PASS' if good else 'FAIL'}] 21 days back from 2026-08-19 = {d} (weekday)")

    print(f"\n{'ALL CHECKS PASSED' if ok else 'FAILURES PRESENT'}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="AI Revolution strategy screener")
    ap.add_argument("--run", action="store_true", help="run the screen")
    ap.add_argument("--selftest", action="store_true", help="validate math offline")
    ap.add_argument("--asof", help="YYYY-MM-DD, defaults to today")
    ap.add_argument("--no-theme", action="store_true", help="skip the theme gate")
    ap.add_argument("--csv", help="write full ranked output to this path")
    ap.add_argument("--strong-rs", type=float, help="override Strong Buy RS cutoff")
    ap.add_argument("--buy-rs", type=float, help="override Buy RS cutoff")
    a = ap.parse_args()

    p = Params()
    if a.strong_rs is not None:
        p.strong_rs = a.strong_rs
    if a.buy_rs is not None:
        p.buy_rs = a.buy_rs

    if a.selftest:
        return selftest()
    if a.run:
        return run(a.asof, not a.no_theme, p, a.csv)
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
