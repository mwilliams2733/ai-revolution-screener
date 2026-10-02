# Plan 011: Store the band tier (before stage/gate/health/cap) as `momentum_tier`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Plan 007 must be merged (the refresh route must read `getScreen(true)`).
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/hysteresis.ts lib/hysteresis.test.ts lib/stage-overlay.test.ts app/api/refresh/route.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED — changes which tier tomorrow's hysteresis compares against; self-heals after one live session
- **Depends on**: plans/007-refresh-snapshots-fresh-screen.md (same file)
- **Category**: bug
- **Planned at**: commit `7d56c3f`, 2026-09-23; re-verified against `4d6bad9` (post-010) 2026-09-23

## Why this matters

`db/schema.sql:123-127` defines `momentum_tier` as "the tier before the stage,
fundamental and cap overlays … comparing a capped tier to a fresh momentum
tier would read every cap as a change and defeat the band." The code does not
store that. The value is captured inside `applyFundamentalOverlay`
(`lib/fundamental-gate.ts:94`, `momentumTier: r.tier`), whose input is
`stageRuled` (`lib/screen-service.ts:644-648`) — i.e. **after** the Weinstein
stage cap. A Strong Buy that the stage rule caps to Buy is stored as Buy, and
tomorrow `applyHysteresis` treats it as a Buy incumbent that must clear
`strongRs + band` to re-enter Strong Buy — exactly the "cap read as a change"
the schema comment says the column exists to prevent. The drift is between
the documented decision and the code; the documented decision wins.

The `momentumTier` field on `GateFields` must **not** be moved: `demotedCount`
(`lib/fundamental-gate.ts:106-108`) counts gate demotions relative to the
post-stage tier, which is correct for that count. Instead, hysteresis records
its own output and the refresh stores that.

## Current state

- `lib/hysteresis.ts:36-39`:

```ts
export interface HysteresisFields {
  /** True when the band changed the outcome. */
  readonly held: boolean;
}
```

- `lib/hysteresis.ts:85-101` — `applyHysteresis` returns
  `{ ...r, held: false }` or `{ ...r, tier: sticky, weight: …, held: true }`.
- Pipeline order in `lib/screen-service.ts:636-648`:
  `applyTrueMa → applyHysteresis → applyTrend → applyStageRule → applyFundamentalOverlay → applyHealth → capStrongBuy → applyVolume`.
  Each overlay uses `rows.map((r) => ({ ...r, … }))`, so a field added by
  hysteresis survives to the final rows.
- `app/api/refresh/route.ts:190-198`:

```ts
    const tierRows = screen.themed.map((r) => ({
      ticker: r.ticker,
      rsPct: r.rsPct,
      vsMa: r.vsMa,
      tier: r.tier,
      // The pre-overlay tier, so tomorrow's hysteresis compares like with like.
      momentumTier: r.momentumTier,
      weight: r.weight,
    }));
```

- **Replay already does this correctly.** `scripts/replay-tiers.ts:219-236`
  stores `momentum_tier` from `trended` (post-hysteresis, pre-stage) with the
  comment "feeding it the capped tier would read every cap as a change". So
  `tier_history.momentum_tier` currently means pre-stage on `source='replay'`
  rows and post-stage on `source='live'` rows. This plan makes live match replay.
- `lib/db.ts:754-770` `previousMomentumTiers` reads
  `COALESCE(momentum_tier, tier)` — unchanged by this plan.
- Test conventions: `lib/hysteresis.test.ts` builds rows with small helpers
  and asserts on tiers; `lib/stage-overlay.test.ts` exists. Model new tests
  on those files.

## Commands you will need

| Purpose   | Command | Expected |
|-----------|---------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests     | `npx vitest run lib/hysteresis.test.ts lib/stage-overlay.test.ts` | pass |
| All tests | `npm test` | pass, +2 |
| Lint      | `npx eslint lib/hysteresis.ts app/api/refresh/route.ts` | no new problems |

## Scope

**In scope**:
- `lib/hysteresis.ts`, `lib/hysteresis.test.ts`
- `lib/stage-overlay.test.ts` (add one test)
- `app/api/refresh/route.ts` (one line + comment)

**Out of scope**:
- `lib/fundamental-gate.ts` — `momentumTier` there feeds `demotedCount`; leave it.
- `lib/db.ts`, `db/schema.sql` — the column and its comment are already right.
- `lib/screen-service.ts` — no pipeline change is needed.
- `scripts/replay-tiers.ts` — replayed rows write their own `momentum_tier`;
  check whether it uses `bandTier` after this lands, but do not change it here.

## Git workflow

- Branch: `advisor/011-band-tier`
- One commit: `Store the band tier in momentum_tier, before the stage cap, as the schema says`

## Steps

### Step 1: Record the band's output

In `lib/hysteresis.ts` extend `HysteresisFields`:

```ts
export interface HysteresisFields {
  /** True when the band changed the outcome. */
  readonly held: boolean;
  /**
   * The tier after the band and BEFORE every demoting overlay. This is what
   * tier_history.momentum_tier stores and what tomorrow's band compares
   * against. Capturing it later -- after the stage rule -- made a name that
   * was merely capped look like it had lost the tier, which defeated the band.
   */
  readonly bandTier: Tier | null;
}
```

and in `applyHysteresis` set it on every return:

```ts
    if (before == null || r.rsPct == null) return { ...r, held: false, bandTier: r.tier };
    const sticky = hysteresisTier(r.rsPct, r.vsMa, before, p, band);
    if (sticky === r.tier) return { ...r, held: false, bandTier: r.tier };
    return { ...r, tier: sticky, weight: tierWeight(sticky, p), held: true, bandTier: sticky };
```

**Verify**: `npm run typecheck` → 0 (the new field is additive).

### Step 2: Store it

In `app/api/refresh/route.ts` change `momentumTier: r.momentumTier,` to
`momentumTier: r.bandTier,` and the comment above it to:

```ts
      // The tier after the hysteresis band and BEFORE the stage, fundamental,
      // health and cap overlays, so tomorrow's band compares like with like.
      // r.momentumTier (from the fundamental gate) is post-stage and must not
      // be used here; see db/schema.sql on momentum_tier.
```

**Verify**: `grep -n "momentumTier: r.bandTier" app/api/refresh/route.ts` → 1 match.
`npm run typecheck` → 0.

### Step 3: Tests

Append to `lib/hysteresis.test.ts` (inside an existing `describe("applyHysteresis")`
if one exists, otherwise a new one; use the file's existing row helper):

```ts
  it("reports the band tier it decided on, before any overlay", () => {
    // CORRECTED AT DISPATCH: the helper is row(over: Partial<ScreenRow>), ticker "T".
    const rows = applyHysteresis([row({ rsPct: 78, tier: "Buy" })], new Map([["T", "Strong Buy"]]));
    expect(rows[0].tier).toBe("Strong Buy");
    expect(rows[0].bandTier).toBe("Strong Buy");
  });
```

Append to `lib/stage-overlay.test.ts` a test that runs
`applyStageRule(applyHysteresis(...))` on a late-stage (stage 3) Strong Buy
and asserts:

```ts
    expect(out[0].tier).toBe("Buy");          // capped by the stage rule
    expect(out[0].bandTier).toBe("Strong Buy"); // what hysteresis must see tomorrow
```

Build the row the same way that file already builds stage-3 rows.

**Verify**: `npx vitest run lib/hysteresis.test.ts lib/stage-overlay.test.ts` → pass, +2.

### Step 4: Mutation check (mandatory)

Temporarily change `applyStageRule` in `lib/stage-overlay.ts` to also set
`bandTier: capped` on the capped branch. The stage-overlay test MUST fail.
Restore and re-run. Report the observed failure.

### Step 5: Gates

`npm run typecheck` → 0; `npm test` → previous count + 2.

## Done criteria

- [ ] `grep -n "bandTier" lib/hysteresis.ts` ≥ 3 matches; `grep -n "momentumTier: r.bandTier" app/api/refresh/route.ts` → 1
- [ ] `grep -n "momentumTier: r.momentumTier" app/api/refresh/route.ts` → none
- [ ] `npm test` passes with 2 new tests; mutation check reported
- [ ] Only in-scope files modified; `plans/README.md` updated

## STOP conditions

- `applyHysteresis` is no longer the step immediately before `applyTrend` /
  `applyStageRule` in `lib/screen-service.ts` (order at `7d56c3f`: lines 636-644).
- `scripts/replay-tiers.ts` writes `momentum_tier` from a field that no
  longer exists after this change (typecheck will say; report it rather than
  patching the script).

## Maintenance notes

- Rows already in `tier_history` keep their post-stage values; the first
  live refresh after this lands writes correct ones, and the band uses only
  the previous session, so the effect is gone after one session.
- Reviewer: confirm no overlay after hysteresis spreads a *new* `bandTier`.
- Follow-up worth considering: `previousMomentumTiers` falls back to `tier`
  when `momentum_tier` is null (`lib/db.ts:764`); that fallback now means
  "post-overlay" and only applies to pre-column rows.
