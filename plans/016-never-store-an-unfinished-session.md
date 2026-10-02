# Plan 016: Never store a session before it has closed, and re-fetch the ones that were

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `4d6bad9`
> or a descendant, run `git merge --ff-only 4d6bad9`; if that fails, STOP.
>
> **Drift check (run second)**: `git diff --stat 4d6bad9..HEAD -- lib/session-ledger.ts lib/session-ledger.test.ts lib/polygon.ts lib/db.ts app/api/refresh/route.ts`
> Plan 011 (merged or not) touches only the `tierRows` block of the refresh
> route; that is not drift for this plan. Anything else changed: compare
> against the excerpts below and STOP on a mismatch.

## Status

- **Priority**: P0 — every stored session since 2026-08-31 is a mid-morning snapshot
- **Effort**: M
- **Risk**: MED — changes the refresh work list; the repair re-writes 17 sessions of bars (upserts, so reversible by re-fetching)
- **Depends on**: none (independent of 011-015)
- **Category**: bug
- **Planned at**: commit `4d6bad9`, 2026-09-23

## Why this matters

**Measured, not inferred.** Of 522 stored trading sessions, the 17 from
2026-08-31 through 2026-09-23 were each fetched on the same day between
15:24 and 18:23 UTC — 11:24 AM to 2:23 PM Eastern, before the 4:00 PM close.
Every session through 2026-08-28 was fetched after its close. Against
Polygon's final daily bars:

| Ticker, session | Stored close | Final close | Stored volume / final |
|---|---|---|---|
| NVDA 2026-09-18 | 219.495 | 222.27 | 24% |
| AAPL 2026-09-18 | 334.855 | 336.13 | 22% |
| SPY 2026-09-18  | 759.95  | 761.69 | 31% |
| NVDA 2026-09-22 | 228.2525 | 228.87 | 37% |
| AAPL 2026-09-22 | 342.63  | 339.75 | 42% |
| SPY 2026-09-22  | 772.76  | 773.38 | 36% |

Opens match exactly — these are mid-morning snapshots. By contrast, sessions
2026-08-27 and 2026-08-28, fetched about 1.4 hours after the close, match the
final closes exactly and carry 99.3-99.8% of final volume.

**Cause.** `tradingCalendar(from, to)` (`lib/polygon.ts:246-257`) lists every
date on which the proxy ticker has a daily aggregate. During market hours
Polygon already returns an in-progress aggregate for today, so today appears
as a session. `/api/refresh` then fetches `groupedDaily(today)` — partial —
stores it with `insertBars`, records it with `recordSession`, and
`missingSessions` never lists it again because it is in the ledger. The
partial bar is permanent.

**Why it started 2026-08-31.** Commit `21592e3` (2026-08-23) removed the 3 PM
Phoenix refresh. Since then the only refreshes are the 5 AM Vercel cron
(before the open: today has no aggregate, so it adds nothing) and the GitHub
Actions backup of the same schedule, which lands roughly 3.5 hours late —
during market hours. `refresh_runs` shows exactly this: a 12:23Z run adding 0
sessions, then a ~15:45Z run adding 1, every day.

**What it corrupts.** Closes (returns, RS percentiles, moving averages, the
52-week range), volumes (the $10M median dollar-volume liquidity gate, the
volume family), the tier snapshots and alerts derived from them, and the
morning digest. `referenceCalendar` in `lib/screen-service.ts:315-325` already
excludes today with the comment "this plan serves delayed end-of-day bars" —
the same rule never reached the refresh.

## Current state (verified at 4d6bad9)

- `lib/polygon.ts:246-257`:

```ts
export async function tradingCalendar(
  from: string,
  to: string,
  proxyTicker = "NVDA",
  opts: FetchOptions = {},
): Promise<string[]> {
  const res = await get<AggResponse>(
    `/v2/aggs/ticker/${proxyTicker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=50000`,
    opts,
  );
  return (res.results ?? []).map((r) => new Date(r.t).toISOString().slice(0, 10));
}
```

  Callers: `app/api/refresh/route.ts:120`, `lib/screen-service.ts:295`
  (API fallback in `resolveCalendar`), `lib/screen-service.ts:318`
  (`referenceCalendar`), `scripts/backfill.ts:70`, `scripts/verify-screen.ts:35`.
  Fixing it inside `tradingCalendar` fixes all five at once.
  `lib/polygon.ts` currently imports only `type { PolygonBar } from "./factors"`.

- `app/api/refresh/route.ts:118-122` and `:275`:

```ts
    const calendar = await tradingCalendar(isoDaysAgo(CATCHUP_WINDOW * 2), isoDaysAgo(0));
    const recent = calendar.slice(0, CATCHUP_WINDOW);
    const todo = (await missingSessions(recent)).slice(0, MAX_SESSIONS_PER_RUN);
    ...
      remaining: Math.max(0, (await missingSessions(recent)).length),
```

  `MAX_SESSIONS_PER_RUN = 3` (line 52). The loop at lines 128-144 fetches each
  `todo` date with `groupedDaily`, then `insertBars` + `recordSession`.

- `lib/db.ts:167-203` `insertBars` is an UPSERT (`ON CONFLICT (session, ticker)
  DO UPDATE SET open, high, low, close, volume, vwap`). `lib/db.ts:407-420`
  `recordSession` is an UPSERT that sets `fetched_at = now()`. So re-fetching a
  stored session overwrites it cleanly and stamps a new `fetched_at`.
- `lib/db.ts:431-440` `missingSessions(candidates)` returns candidates with no
  row in `sessions`. It is also used by `scripts/backfill.ts`; leave it.
- `db/schema.sql:81-87`: `sessions(session DATE PK, bar_count, is_trading, fetched_at TIMESTAMPTZ)`.
- `lib/session-ledger.ts` holds the pure work-list logic (`classifySession`,
  `sessionsToFetch`) with tests in `lib/session-ledger.test.ts`. The new pure
  functions belong there, with that file's comment style.
- `lib/refresh-stamp.ts:115-117` shows the repo's pattern for time-zone
  calendar maths: `Intl.DateTimeFormat` with an explicit `timeZone`. Match it;
  add no timezone library.

## The settle rule

A session is **settled** at **18:00 America/New_York** on its date: two hours
after the 16:00 close. Evidence above: bars fetched ~1.4 h after the close
matched final closes exactly and held 99.3-99.8% of final volume; 18:00 is
also exactly when the removed afternoon refresh ran, and its data was sound.
New York observes DST, so 18:00 ET is 22:00Z from mid-March to early November
and 23:00Z otherwise. The rule must use the real zone, not a fixed offset.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npx vitest run lib/session-ledger.test.ts` | pass |
| All tests | `npm test` | baseline + new tests pass |
| Lint | `npx eslint lib/session-ledger.ts lib/session-ledger.test.ts lib/polygon.ts lib/db.ts app/api/refresh/route.ts` | no NEW problems (record a baseline first) |

## Scope

In scope:
- `lib/session-ledger.ts`, `lib/session-ledger.test.ts`
- `lib/polygon.ts` (`tradingCalendar` only)
- `lib/db.ts` (add ONE function, `sessionFetchTimes`)
- `app/api/refresh/route.ts` (the work-list lines and the `remaining` line only)

Out of scope:
- `lib/screen-service.ts` — `referenceCalendar` keeps its own `d < today` filter;
  it becomes redundant during market hours but still correct.
- `scripts/backfill.ts`, `scripts/verify-screen.ts` — fixed transitively through `tradingCalendar`.
- `tier_history` — the 17 live snapshots computed from partial bars are NOT
  rewritten by this plan (see Maintenance notes; that is a maintainer decision).
- Any direct write to the database from the executor.

## Git workflow

- Branch: `advisor/016-settled-sessions`
- Commit 1: `Only treat a session as tradeable once it has settled after the close`
- Commit 2: `Re-fetch sessions that were stored before they settled`
- Each message ends with a blank line and the repository's current co-author trailer.

## Steps

### Step 0: Lint baseline

Run the lint command from the table before editing. Record the output.

### Step 1: Pure settle logic

Append to `lib/session-ledger.ts`:

```ts
/**
 * When a session's daily bar can be trusted: 18:00 New York time on its date.
 *
 * Polygon returns an IN-PROGRESS daily aggregate while the market is open, so
 * a session fetched before the close is a mid-morning snapshot -- right open,
 * wrong close, a third of the volume. The refresh used to accept today as a
 * session whenever the proxy ticker had a bar for it, and from 2026-08-31 the
 * late backup scheduler landed during market hours every day, storing 17
 * sessions that were never re-fetched.
 *
 * Two hours after the close: bars fetched ~1.4 h after the close matched the
 * final closes exactly and held >99% of final volume, and 18:00 ET is when
 * the old afternoon refresh ran. New York observes DST, so this resolves the
 * real offset for the date rather than assuming one.
 */
export const SETTLE_HOUR_NY = 18;

/** The UTC instant at which `session` (yyyy-mm-dd) is settled. */
export function settleInstant(session: string, hourNy: number = SETTLE_HOUR_NY): Date {
  // Guess the instant assuming UTC, read back what New York's wall clock says
  // at that instant, and correct by the difference. One correction is exact
  // for any hour away from a DST switch, and 18:00 never is one.
  const guess = new Date(`${session}T${String(hourNy).padStart(2, "0")}:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() + (guess.getTime() - wall));
}

/** Sessions whose bars are final as of `now`. Order is preserved. */
export function settledSessions(calendar: readonly string[], now: Date): string[] {
  return calendar.filter((d) => settleInstant(d).getTime() <= now.getTime());
}

/**
 * Sessions the refresh must (re)fetch, in calendar order (newest first).
 *
 * A session needs fetching when it is missing from the ledger OR was fetched
 * before it settled. Asking "is each session done" rather than "is it present"
 * is what lets the 17 mid-morning snapshots repair themselves, and keeps any
 * future early fetch from becoming permanent.
 *
 * @param calendar   settled sessions, newest first
 * @param fetchedAt  session -> when it was last fetched, for stored sessions
 */
export function sessionsNeedingFetch(
  calendar: readonly string[],
  fetchedAt: ReadonlyMap<string, Date>,
): string[] {
  return calendar.filter((d) => {
    const f = fetchedAt.get(d);
    return f == null || f.getTime() < settleInstant(d).getTime();
  });
}
```

**Verify**: `npm run typecheck` → 0.

### Step 2: Tests for the pure logic

In `lib/session-ledger.test.ts`, extend the import to
`import { classifySession, sessionsNeedingFetch, sessionsToFetch, settledSessions, settleInstant } from "./session-ledger";`
and append:

```ts
describe("settleInstant", () => {
  it("is 22:00 UTC during daylight saving", () => {
    expect(settleInstant("2026-09-22").toISOString()).toBe("2026-09-22T22:00:00.000Z");
  });

  it("is 23:00 UTC in standard time", () => {
    expect(settleInstant("2026-12-01").toISOString()).toBe("2026-12-01T23:00:00.000Z");
  });

  /** DST ended Sunday 2026-11-01; the Monday after is standard time. */
  it("follows the DST switch rather than a fixed offset", () => {
    expect(settleInstant("2026-10-30").toISOString()).toBe("2026-10-30T22:00:00.000Z");
    expect(settleInstant("2026-11-02").toISOString()).toBe("2026-11-02T23:00:00.000Z");
  });
});

describe("settledSessions", () => {
  const cal = ["2026-09-23", "2026-09-22", "2026-09-21"];

  /**
   * The bug this guards. At 15:44 UTC on 2026-09-23 the proxy ticker already
   * had a bar for that day, and the refresh stored a mid-morning snapshot as
   * the session.
   */
  it("drops today while the market is open", () => {
    expect(settledSessions(cal, new Date("2026-09-23T15:44:00Z"))).toEqual(["2026-09-22", "2026-09-21"]);
  });

  it("drops today between the close and the settle time", () => {
    expect(settledSessions(cal, new Date("2026-09-23T21:30:00Z"))).toEqual(["2026-09-22", "2026-09-21"]);
  });

  it("includes today once it has settled", () => {
    expect(settledSessions(cal, new Date("2026-09-23T22:00:00Z"))).toEqual(cal);
  });
});

describe("sessionsNeedingFetch", () => {
  const cal = ["2026-09-22", "2026-09-21", "2026-09-18"];

  it("lists a session that was never fetched", () => {
    const fetched = new Map([["2026-09-21", new Date("2026-09-22T12:00:00Z")], ["2026-09-18", new Date("2026-09-19T12:00:00Z")]]);
    expect(sessionsNeedingFetch(cal, fetched)).toEqual(["2026-09-22"]);
  });

  /** The repair: a session stored mid-morning is not done, however present it is. */
  it("lists a session fetched before it settled", () => {
    const fetched = new Map([
      ["2026-09-22", new Date("2026-09-22T15:55:51Z")],
      ["2026-09-21", new Date("2026-09-22T12:00:00Z")],
      ["2026-09-18", new Date("2026-09-18T15:24:19Z")],
    ]);
    expect(sessionsNeedingFetch(cal, fetched)).toEqual(["2026-09-22", "2026-09-18"]);
  });

  it("leaves alone a session fetched after it settled", () => {
    const fetched = new Map(cal.map((d) => [d, new Date(`${d}T23:30:00Z`)] as const));
    expect(sessionsNeedingFetch(cal, fetched)).toEqual([]);
  });
});
```

**Verify**: `npx vitest run lib/session-ledger.test.ts` → all pass, 9 new tests
(`it` blocks: 3 + 3 + 3).

### Step 3: Mutation checks for Step 2 (mandatory)

1. Replace the body of `settleInstant` with
   `return new Date(\`${session}T22:00:00Z\`);` (a fixed offset). Run the file
   → the standard-time and DST-switch tests MUST fail. Restore.
2. In `sessionsNeedingFetch`, change the condition to `return f == null;`.
   → "lists a session fetched before it settled" MUST fail. Restore.
3. Make `settledSessions` return `[...calendar]`. → "drops today while the
   market is open" MUST fail. Restore.

Record each observed failure message. `git diff lib/session-ledger.ts` must
show only Step 1's additions afterwards.

### Step 4: Filter the calendar at its source

In `lib/polygon.ts` add `import { settledSessions } from "./session-ledger";`
and change the return of `tradingCalendar` to:

```ts
  // Settled sessions only. While the market is open the proxy already has an
  // in-progress bar for today, and every caller that took it as a session
  // stored or ranked a mid-morning snapshot. See settleInstant().
  return settledSessions(
    (res.results ?? []).map((r) => new Date(r.t).toISOString().slice(0, 10)),
    new Date(),
  );
```

Check first that `lib/session-ledger.ts` imports nothing from `lib/polygon.ts`
(`grep -n "import" lib/session-ledger.ts`), so no cycle is created. If it does, STOP.

**Verify**: `npm run typecheck` → 0. `npm test` → pass.

Commit 1.

### Step 5: Fetch times from the ledger

In `lib/db.ts`, directly after `missingSessions`, add:

```ts
/**
 * When each candidate session was last fetched, for those in the ledger.
 *
 * The refresh uses this with sessionsNeedingFetch() to re-fetch any session
 * stored before it settled. Presence alone is not enough: from 2026-08-31 to
 * 2026-09-23 every stored session was a mid-morning snapshot.
 */
export async function sessionFetchTimes(candidates: readonly string[]): Promise<Map<string, Date>> {
  if (candidates.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    SELECT session::text AS session, fetched_at FROM sessions
    WHERE session = ANY(${[...candidates]}::date[]) AND is_trading
  `) as { session: string; fetched_at: string }[];
  return new Map(rows.map((r) => [r.session, new Date(r.fetched_at)]));
}
```

`AND is_trading` matters: a date recorded as a holiday has no bars to repair,
and it can never appear in a settled calendar anyway.

### Step 6: Use it in the refresh

In `app/api/refresh/route.ts`:
- import `sessionFetchTimes` from `@/lib/db` (add it to the existing multi-line
  import) and `sessionsNeedingFetch` from `@/lib/session-ledger` (extend the
  existing `classifySession` import).
- replace line 122 with:

```ts
    // Missing sessions AND sessions stored before they settled. The second
    // set is how mid-morning snapshots stored before this fix get repaired:
    // insertBars and recordSession are upserts, so a re-fetch overwrites the
    // partial bars and stamps a new fetched_at. Newest first, so the sessions
    // the screen reads most are repaired first.
    const needing = sessionsNeedingFetch(recent, await sessionFetchTimes(recent));
    const todo = needing.slice(0, MAX_SESSIONS_PER_RUN);
```

- replace the `remaining:` line with
  `remaining: Math.max(0, needing.length - stored.length),`
  (`stored` is the array the loop fills with sessions it actually wrote). Do
  NOT subtract `retried`: a retried session was not written and is still
  outstanding, exactly as the old post-run `missingSessions` recount counted
  it. Read the loop first and confirm `stored` exists with that name; if not, STOP.
- if `missingSessions` is no longer referenced in the file, remove it from the import.

**Verify**: `npm run typecheck` → 0.
`grep -n "missingSessions" app/api/refresh/route.ts` → none.
`grep -c "sessionsNeedingFetch" app/api/refresh/route.ts` → 2 (import + call).

### Step 7: Gates

`npm run typecheck` → 0. `npm test` → baseline + 9. Lint → nothing beyond Step 0.
Do NOT run the refresh route or any script against the live database.

Commit 2.

## Test plan

The pure functions carry the logic and are tested with real dates from the
incident, including a DST switch. The route wiring (Steps 5-6) has no harness
and is verified by typecheck and grep; say so in the report. The reviewer
verifies against the live data after merge (see Maintenance notes).

## Done criteria

- [ ] 9 new tests in `lib/session-ledger.test.ts`, all passing; three mutation checks performed and reported
- [ ] `tradingCalendar` returns `settledSessions(...)`
- [ ] `grep -n "missingSessions" app/api/refresh/route.ts` → none; `sessionsNeedingFetch` used once
- [ ] `npm run typecheck` 0; `npm test` passes
- [ ] Only in-scope files changed; two commits

## STOP conditions

- `insertBars` or `recordSession` is no longer an upsert (a re-fetch would then fail or duplicate).
- `lib/session-ledger.ts` imports from `lib/polygon.ts` (import cycle).
- The refresh loop does not collect a `stored` array of written sessions.
- Any step would require connecting to the live database.

## Maintenance notes

- **Draining the repair.** Reviewer dry run at 2026-09-24T03:24Z (read-only,
  live data) lists **19** sessions: the 17 intraday ones plus 2026-08-27 and
  2026-08-28, which were fetched at 21:24Z/21:35Z — after the close but before
  the 22:00Z settle. Those two already had exact closes and 99.3-99.8% of
  final volume, so re-fetching them is harmless. With `MAX_SESSIONS_PER_RUN = 3`
  that is seven refreshes after deploy. Triggering the "Screener schedule"
  workflow manually with `task=refresh` seven times drains it in minutes; the
  response's `remaining` falls to 0. Verify afterwards with the read-only
  query in this plan's "Why this matters" section (fetched_at vs 16:00 ET):
  zero sessions should remain fetched before their close.
- **`tier_history` for 2026-08-31..2026-09-23 was computed from partial bars.**
  Those 17 `live` snapshots, and the alerts and digests sent from them, cannot
  be corrected by re-fetching bars. Options: leave them and note the window
  in the backtest; or re-snapshot them through the replay path (which marks
  them `replay` and removes them from live-cohort views). That is a decision
  about the record, not a code fix — do not do it inside this plan.
- **Visible symptom this should also end:** from ~8:45 AM Phoenix until UTC
  midnight the stored head was today's partial session while
  `referenceCalendar` excludes today, so staleness likely read "unrecognised
  session" every afternoon. Not verified on the page.
- If the schedule ever gains an after-close refresh again, this rule still
  holds: it only refuses sessions younger than 18:00 ET.
