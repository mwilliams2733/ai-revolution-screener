# Plan 007: The refresh snapshots a freshly computed screen, never a cached one

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
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- app/api/refresh/route.ts lib/screen-service.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7d56c3f`, 2026-09-23

## Why this matters

`/api/refresh` stores the newest session's bars and then calls `getScreen()`
to snapshot tiers into `tier_history` and diff them for the alert email. But
`getScreen()` serves a **module-level 15-minute cache**. On a warm Vercel
instance that rendered the page (or answered `/api/screen`) in the previous
15 minutes, the refresh receives the screen computed **before** today's bars
existed. Its `asOf` is yesterday, so `upsertTierHistory(yesterday, …)`
overwrites yesterday's snapshot, today's session gets **no snapshot**, the
alert diff compares yesterday against the day before (and is then suppressed
by the alert ledger as already sent), and the response reports `ok: true`.
Tomorrow's hysteresis and cap incumbency then read a baseline one session too
old. Nothing logs the miss. Vercel's Fluid Compute keeps instances warm across
requests, so a 4:50 AM page view followed by the 5:00 AM cron is enough.

## Current state

- `lib/screen-service.ts:523-534` — the cache and the `force` parameter:

```ts
const SCREEN_TTL_MS = 15 * 60 * 1000;
let screenCache: { at: number; value: ScreenPayload } | null = null;

export async function getScreen(force = false): Promise<ScreenPayload> {
  if (!force && screenCache && Date.now() - screenCache.at < SCREEN_TTL_MS) {
    return screenCache.value;
  }
  const payload = await computeScreen();
  screenCache = { at: Date.now(), value: payload };
  return payload;
}
```

- `app/api/refresh/route.ts:188-202` — the call that must bypass it:

```ts
    // Snapshot the screen so tier changes are diffable tomorrow.
    const screen = await getScreen();
    const tierRows = screen.themed.map((r) => ({
```

- `app/api/screen/route.ts:17-23` already shows the intended pattern: it reads
  a `fresh=1` query flag and passes `getScreen(fresh)`. Match that: pass
  `true` explicitly, with a comment saying why.

- `computeScreen()` derives `asOf` from `resolveCalendar()`
  (`lib/screen-service.ts:285-297`), which reads `storedTradingSessions()`
  from the database first. So a forced recompute after `insertBars` /
  `recordSession` sees the new session. That is the assumption this plan
  rests on.

Repo conventions: comments explain **why**, in full sentences, often citing a
dated incident. Commit messages are one imperative sentence
(e.g. `Fix staleness check comparing the stored calendar against itself`).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `npm run typecheck`  | exit 0 |
| Tests     | `npm test`           | 30 files, 492 tests pass (baseline) |
| Lint      | `npx eslint app/api/refresh/route.ts` | no NEW problems in this file (repo-wide lint has 6 pre-existing problems and never exits 0) |

## Scope

**In scope** (the only files you should modify):
- `app/api/refresh/route.ts`

**Out of scope** (do NOT touch):
- `lib/screen-service.ts` — the cache is correct for the page and `/api/screen`;
  do not shorten or remove it.
- `app/api/digest/route.ts` — it runs an hour after the refresh, outside the
  TTL, and plan 013 restructures it anyway.
- `lib/db.ts` `upsertTierHistory` — overwrite semantics are a separate,
  deferred question (see Maintenance notes).

## Git workflow

- Branch: `advisor/007-refresh-fresh-screen`
- One commit, message: `Force the refresh to recompute the screen instead of reading the 15-minute cache`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Force the recompute

In `app/api/refresh/route.ts`, change line 189 from `await getScreen()` to
`await getScreen(true)` and replace the one-line comment above it with:

```ts
    // Snapshot the screen so tier changes are diffable tomorrow.
    //
    // FORCED. getScreen() memoises for 15 minutes at module level, and a warm
    // instance that served the page just before this cron fired would hand
    // back the screen computed BEFORE today's bars were stored: asOf would be
    // yesterday, yesterday's snapshot would be overwritten, today's would never
    // be written, and the response would still say ok. The recompute costs a
    // few seconds once a day; a missing session in tier_history costs a wrong
    // hysteresis baseline tomorrow.
    const screen = await getScreen(true);
```

**Verify**: `grep -n "getScreen(true)" app/api/refresh/route.ts` → exactly one match.
`grep -n "await getScreen" app/api/refresh/route.ts` → one match, ending in `getScreen(true)`.

### Step 2: Confirm nothing else regressed

**Verify**: `npm run typecheck` → exit 0. `npm test` → 492 passed.
`npx eslint app/api/refresh/route.ts` → 0 problems in this file.

## Test plan

There is no test harness for route handlers in this repo (`vitest.config.ts`
includes only `lib/**/*.test.ts`). The wiring fix is guarded by the `grep`
done-criterion, not by a test. State this gap plainly in your report; do not
build a harness inside this plan.

## Done criteria

- [ ] `grep -c "getScreen(true)" app/api/refresh/route.ts` prints `1`
- [x] ~~`grep -c "getScreen()" … prints 0`~~ — withdrawn at review: the comment text Step 1 dictates contains that substring; the real criterion is that the only CALL is `getScreen(true)` (`grep -n "await getScreen" app/api/refresh/route.ts` → one line, with `true`)
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with 492 tests
- [ ] `git status` shows only `app/api/refresh/route.ts` (and `plans/README.md`) modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `resolveCalendar()` in `lib/screen-service.ts` no longer reads the stored
  sessions from the database first (the assumption that a forced recompute
  sees the new session would then be false).
- `getScreen` no longer accepts a `force` parameter.
- The excerpts above do not match the live code.

## Maintenance notes

- **Deferred, deliberately**: `upsertTierHistory` still overwrites an existing
  *live* snapshot for the same session. The GitHub Actions backup refresh runs
  up to nine hours after the Vercel one and recomputes the same `asOf`; if
  EDGAR facts changed in between, the stored tiers change after the alert went
  out. A "write a live snapshot once" guard (`liveSessions()` in `lib/db.ts:537`
  already answers whether one exists) is the follow-up. It was kept out of this
  plan because it changes what a re-run means and deserves its own decision.
- A reviewer should check that no other caller of `getScreen()` runs
  **after a write** in the same request. Today only the refresh does.
