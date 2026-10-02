# Plan 015: Correct the documentation that is actively wrong

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Best run last: it describes behaviour that plans 009, 010 and 014 change.
> If any of those is not merged, leave its bullet out and say so.
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- README.md lib/db.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — prose only
- **Depends on**: plans/009, 010, 014 (for the bullets that describe them)
- **Category**: docs
- **Planned at**: commit `7d56c3f`, 2026-09-23; rewritten as exact replacement text against `23592eb` at dispatch 2026-09-30, widened to cover README freshness, replay caveat and rebuild note, the two new scripts, and the DEPLOY.md cron section

## Why this matters

Wrong docs cost more than missing ones. Three statements in the repo are
false today and one becomes false after this batch:

1. `README.md:166-178` documents a **3:00 PM Phoenix refresh** and argues it
   is load-bearing. Commit `21592e3` removed it ("Cut to two cron jobs");
   `vercel.json` and `.github/workflows/schedule.yml` declare two schedules.
2. `README.md:148-149` says the screen is "cached for 15 minutes". The
   server memo is 15 minutes (`lib/screen-service.ts:523`) but the page is
   ISR-revalidated hourly (`app/page.tsx:10`, `revalidate = 3600`), so a
   reader can see up to an hour of staleness.
3. `lib/db.ts:308-314` — the docstring on `loadVolumeHistory` says the query
   is "SCOPED to the tickers that need it" and "only the themed rows are
   ever scored". The function takes no ticker list and loads every ticker;
   that is **intentional** — `lib/screen-service.ts:676-678` grades volume
   "against the FULL ranked universe, never the theme". The comment
   describes a design that was replaced.
4. `README.md:156-161` says the digest lists "the ten strongest names";
   after plan 014 it lists the Strong Buy book. And after plan 009 a day can
   legitimately carry two digests.

## Current state

- `README.md:147-149`:

```
**Why is the first load slow?**
A cold instance rebuilds the screen from scratch, around 10 seconds. It is
cached for 15 minutes after that.
```

- `README.md:166-178` — the schedule table with three rows and the paragraph
  beginning "The afternoon refresh is kept because…".
- `lib/db.ts:308-314`:

```ts
/**
 * Close and volume per ticker over the last `window` stored sessions.
 *
 * One query, but SCOPED to the tickers that need it. Neon's HTTP driver caps a
 * response at 64MB, and 200 sessions across ~12,000 tickers is 2.4M rows, which
 * returns HTTP 507. Scoping is also correct on its own terms: only the themed
 * rows are ever scored.
 */
```

`VOLUME_WINDOW` is 50 (`lib/volume.ts:25`); the loader is called with 51.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 (a comment change cannot break it, but run it) |
| Tests | `npm test` | unchanged |

## Scope

**In scope**: `README.md`, `lib/db.ts` (one doc comment only).

**Out of scope**: `docs/DEPLOY.md` "Cron" section — check it; if it also
lists three crons, report that rather than editing (it is a deploy runbook
with its own history). `.github/workflows/schedule.yml` header comments are
accurate; leave them.

## Git workflow

- Branch: `advisor/015-docs-drift`
- One commit: `Correct the README schedule and cache claims, and one stale loader docstring`

## Steps

### Step 1: The cache claim

Replace the "Why is the first load slow?" answer with:

```
A cold instance rebuilds the screen from scratch, around 10 seconds. The
server memoises the result for 15 minutes, and the page itself is
revalidated hourly, so what you see can be up to an hour behind the last
refresh. Bars are end-of-day, so that costs nothing in practice.
```

### Step 2: The schedule

Delete the `| 3:00 PM | 22:00 | refresh … |` row and the whole paragraph
"The afternoon refresh is kept because … show Thursday." Replace the
paragraph with:

```
There is deliberately no afternoon refresh: with three crons declared, two
deployments hung at UNKNOWN (see commit 21592e3), and the plan allows two.
The cost is that a weekend shows Thursday's close until Monday's 5 AM run
stores Friday. Both schedules are declared twice — in `vercel.json` and in
`.github/workflows/schedule.yml` — because a Vercel cron is registered by a
deployment, not by the project, and a blocked deploy registers nothing. The
routes are idempotent and the mail ledger stops a second caller from sending
a second email.
```

### Step 3: The digest description (only if plans 009 and 014 are merged)

In the "When do emails arrive?" answer, change "and the ten strongest names"
to "the last refresh's outcome, and the Strong Buy book". Append:

```
Normally one digest a day. If the 6 AM digest fires before the 5 AM refresh
has landed (Hobby cron precision is the whole hour), it reports one session
behind, and the backup scheduler sends one corrected digest later that day
once the new session exists — never more than two.
```

### Step 4: The loader docstring

Replace the `loadVolumeHistory` comment with:

```ts
/**
 * Close and volume for EVERY ticker over the last `window` stored sessions.
 *
 * Deliberately unscoped: volume metrics grade a name against the full ranked
 * universe, not the theme (see applyVolume's call in lib/screen-service.ts),
 * so every ticker's bars are needed. The size is bounded by `window`, not by
 * a ticker list: 51 sessions across ~12,000 names is ~600k rows, well under
 * Neon's 64MB HTTP response cap. Widening `window` toward 200 would cross it
 * (2.4M rows returned HTTP 507 when it was tried) -- scope by ticker before
 * doing that.
 */
```

**Verify**: `grep -n "SCOPED to the tickers" lib/db.ts` → none.

### Step 5: Gates

`npm run typecheck` 0; `npm test` unchanged.
`grep -n "3:00 PM" README.md` → none. `grep -n "cached for 15 minutes" README.md` → none.

## Done criteria

- [ ] The three greps above return nothing
- [ ] `git diff --stat` touches only `README.md` and `lib/db.ts`
- [ ] Report says which of Step 3's bullets were applied or skipped
- [ ] `plans/README.md` updated

## STOP conditions

- `vercel.json` declares more than two crons (the README would then be right
  and this plan wrong).
- `app/page.tsx` no longer sets `revalidate = 3600`.

## Maintenance notes

- Per the user's global rules, `CLAUDE.md` files stay short; this README is
  the product doc and the right home for these paragraphs.
- If a third cron is ever added back, update the README table, `vercel.json`,
  `schedule.yml` and `proxy.ts` `CRON_PATHS` together.
