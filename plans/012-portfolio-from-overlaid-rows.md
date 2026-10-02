# Plan 012: Build the portfolio and its risk panel from the overlaid rows, not the raw momentum tiers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/screen-service.ts lib/index.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — changes only the `portfolio` and `risk` fields of the payload
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7d56c3f`, 2026-09-23; re-verified against `a35ce45` 2026-09-30, no drift

## Why this matters

`runScreen` (`lib/index.ts:38-58`) builds `portfolio` with
`buildPortfolio(themed, params)` where `themed` has only the raw
`assignTier` tiers. `computeScreen` (`lib/screen-service.ts:602-606`) takes
that `portfolio` straight from `runScreen` and, after running six overlays
that re-decide tiers (true MA, hysteresis, stage rule, fundamental gate,
balance-sheet guardrails, top-10 cap), returns it unchanged as
`portfolio` and measures `risk: portfolioRisk(portfolio, history)` over it
(`lib/screen-service.ts:718-724`). The comment there says "Risk is measured
over the SELECTED BOOK". It is not: the book it measures can contain a
stage-4 name the screen shows as Hold, and can omit a name the cap promoted.
The risk panel on the page (`app/page.tsx:168-195`: holdings, effective
bets, mean correlation, top-three sector share) therefore describes a
portfolio the screen's own rules reject.

Fix: build the book from the final rows, after the cap.

## Current state

- `lib/screen-service.ts:602-606`:

```ts
  const { ranked, themed, portfolio, universeSize } = runScreen({
    snapshots: snapshots as unknown as Snapshots,
    names: liquid,
    params: SCREEN_PARAMS,
  });
```

- `lib/screen-service.ts:673` — `const limited = capStrongBuy(guarded, STRONG_BUY_LIMIT, undefined, incumbents);`
  is the last tier-changing step. `capStrongBuy` (`lib/strong-buy-cap.ts:85-110`)
  uses `rows.map(...)`, so **order is preserved** from `themed`, which is
  ranked strongest-first by `rankRows`. `buildPortfolio`
  (`lib/tiers.ts:65-79`) requires exactly that ordering.
- `lib/screen-service.ts:704-724`:

```ts
  return {
    asOf: dates.now as string,
    ...
    portfolio,
    ...
    // Risk is measured over the SELECTED BOOK -- buildPortfolio's 7/7/5 shape
    // -- not over every buy-side candidate. ...
    risk: portfolioRisk(portfolio, history),
```

- `ScreenPayload.portfolio` is `readonly ScreenRow[]`
  (`lib/screen-service.ts:216`); `buildPortfolio` returns `ScreenRow[]` and
  accepts `readonly ScreenRow[]`, and every overlaid row type extends
  `ScreenRow`, so `buildPortfolio(limited, SCREEN_PARAMS)` typechecks.
- `buildPortfolio` is already imported into `lib/index.ts` from `./tiers`;
  `lib/screen-service.ts` will need its own import from `./tiers`.
- `SCREEN_PARAMS` is the params object used for `runScreen` in this file;
  use the same one so the tier caps match.

## Commands you will need

| Purpose   | Command | Expected |
|-----------|---------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests     | `npm test` | pass, count unchanged |
| Lint      | `npx eslint lib/screen-service.ts` | no NEW problems (this file has 1 pre-existing warning) |
| Live check| `npm run verify:screen` | exit 0 (needs POLYGON_API_KEY in `.env.local`) |

## Scope

**In scope**:
- `lib/screen-service.ts`

**Out of scope**:
- `lib/index.ts` — `runScreen` still returns its pre-overlay `portfolio` for
  `scripts/verify-screen.ts` and the no-database path; leave it.
- `lib/tiers.ts`, `lib/portfolio-overlay.ts`.
- `app/page.tsx`.

## Git workflow

- Branch: `advisor/012-portfolio-post-overlay`
- One commit: `Build the portfolio and risk panel from the overlaid rows`

## Steps

### Step 1: Stop taking `portfolio` from `runScreen`

Change the destructuring at line 602 to
`const { ranked, themed, universeSize } = runScreen({`.

**Verify**: `npm run typecheck` → errors only at the two later uses of
`portfolio` in this file. Anything else: STOP.

### Step 2: Build the book after the cap

Immediately after `const limited = capStrongBuy(...)` add:

```ts
  // The book is selected from the FINAL tiers. runScreen also returns a
  // portfolio, but it is built from the raw momentum tiers before the six
  // overlays above re-decide them, so it can hold a stage-4 name the screen
  // shows as Hold and omit one the cap just promoted. Measuring risk over
  // that book described a portfolio the screen's own rules reject.
  const portfolio = buildPortfolio(limited, SCREEN_PARAMS);
```

Add `import { buildPortfolio } from "./tiers";` alongside the other `./tiers`
imports (if the file already imports from `./tiers`, extend that line).

**Verify**: `npm run typecheck` → 0.

### Step 3: Gates and a live sanity check

`npm test` → pass. `npx eslint lib/screen-service.ts` → 1 warning (pre-existing).

If `.env.local` has `DATABASE_URL` and `POLYGON_API_KEY`, run
`npx tsx --env-file=.env.local -e "import('./lib/screen-service').then(async m => { const s = await m.getScreen(true); const p = s.portfolio; console.log(p.length, p.map(r => r.ticker + ':' + r.tier).join(' ')); const bad = p.filter(r => !s.themed.find(t => t.ticker === r.ticker && t.tier === r.tier)); console.log('mismatches', bad.length); })"`
→ prints the book and `mismatches 0`. (Every book row's tier must equal the
same ticker's final tier in `themed`.) If the environment lacks the keys,
say so and skip; do not fake the check.

## Test plan

`buildPortfolio` is unit-tested (`lib/tiers.test.ts:177-199`) and
`computeScreen` has no harness. The live check above is the verification;
report its output verbatim.

## Done criteria

- [ ] `grep -n "buildPortfolio(limited, SCREEN_PARAMS)" lib/screen-service.ts` → 1
- [ ] `grep -n "themed, portfolio, universeSize" lib/screen-service.ts` → none
- [ ] `npm run typecheck` 0; `npm test` 0
- [ ] Live check run and reported, or stated as skipped for lack of keys
- [ ] Only `lib/screen-service.ts` (and the index) modified

## STOP conditions

- `capStrongBuy` (or any overlay between `themed` and `limited`) sorts or
  filters rows — `buildPortfolio` would then see the wrong order or set.
- `ScreenPayload.portfolio` is typed as something other than `readonly ScreenRow[]`.

## Maintenance notes

- If a new overlay is added after `capStrongBuy`, move the `buildPortfolio`
  call below it. The comment in Step 2 says why.
- Reviewer: compare `risk.holdings` on the page before and after; it should
  now equal the count of Strong Buy + Buy + Hold names within the 7/7/5 caps
  **among the final tiers**.
