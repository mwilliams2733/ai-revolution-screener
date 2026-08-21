# Screener core (TypeScript)

Pure, network-free implementation of the decoded AI Revolution strategy. Drop
`lib/` into a Next.js app as-is and everything here keeps working, because
nothing in it does I/O.

```bash
npm install
npm test          # 52 tests
npm run typecheck # tsc --noEmit, strict
```

## Modules

| File | Contains |
|---|---|
| `types.ts` | `Tier`, `Bar`, `Params`, `ScreenRow`, anchor constants |
| `params.ts` | `DEFAULT_PARAMS`, the decoded strategy constants, plus `withParams()` |
| `factors.ts` | `pctChange`, `rsScore`, `percentileRanks`, `computeMaProxy`, `computeRows`, `rankRows` |
| `tiers.ts` | `assignTier`, `tierWeight`, `applyTiers`, `buildPortfolio`, `tierSummary` |
| `theme.ts` | `THEME`, `CAPEX_SPENDERS`, `CROWDING_VETO`, `themeUniverse()` |
| `index.ts` | `runScreen()`, composes the pipeline in the correct order |

## Wiring it up

Only two things are missing, both I/O, both belong in a route handler where the
API key stays server-side:

```ts
import { barsByTicker, runScreen } from "@/lib/index";

const snapshots = {
  now:  barsByTicker(await groupedDaily(today)),
  r1m:  barsByTicker(await groupedDaily(back(21))),
  r3m:  barsByTicker(await groupedDaily(back(63))),
  r6m:  barsByTicker(await groupedDaily(back(126))),
  r12m: barsByTicker(await groupedDaily(back(252))),
};

const { themed, portfolio, universeSize } = runScreen({ snapshots, names });
```

`groupedDaily` hits `/v2/aggs/grouped/locale/us/market/stocks/{date}` and `names`
comes from `/v3/reference/tickers`. Both are confirmed working on your current
Massive plan. See `HANDOFF.md` for the rest.

## Two things that will silently break the results

**Rank before you filter.** `runScreen` computes percentiles against the full
liquid universe and only then narrows to the theme. If you reorder those steps,
an RS percentile stops meaning what the tier cutoffs assume and the 80/55
thresholds become arbitrary.

**Do not tune against the fixture.** `tiers.test.ts` holds the real 19-position
portfolio with measured RS percentiles. The current ruleset reproduces 10 of 15
tiers exactly and 15 of 15 within one tier. That 67% is the honest ceiling for a
price-only model, and the five misses are identified overrides, not noise. If a
change pushes the match rate well past that without adding fundamental inputs,
you have fit to nineteen data points.

## Parity with screener.py

`screener.py --selftest` and `npm test` cover the same cases with the same
expected values, including tie-averaged percentile ranks. Verified identical on
`[1,2,2,3]`, `[4,4,4]` and `[1,2,3,4,5]`. Keep them in sync when you change the
factor math.
