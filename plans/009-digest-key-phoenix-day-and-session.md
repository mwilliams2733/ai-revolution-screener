# Plan 009: Key the digest ledger on the Phoenix day AND the session it describes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Plan 008 should already be merged; if `grep -c "baseline" app/api/digest/route.ts`
> prints 0, land 008 first.
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/mail-ledger.ts lib/mail-ledger.test.ts lib/dates.ts lib/dates.test.ts app/api/digest/route.ts`
> Line numbers in `app/api/digest/route.ts` will have shifted after plan 008;
> re-locate by content, not by number.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/008-digest-baseline-truth.md (same file; land it first)
- **Category**: bug
- **Planned at**: commit `7d56c3f`, 2026-09-23; re-verified against `a6661d8` (post-008) 2026-09-23, excerpts unchanged

## Why this matters

The digest dedupe key is `digest:<UTC date>` (`lib/mail-ledger.ts:24-26`,
called with `isoDaysAgo(0)` at `app/api/digest/route.ts:132`). Two concrete
failures follow from that choice:

1. **An evening manual run silences the next morning.** Phoenix is UTC-7.
   Any `workflow_dispatch` or `curl` after 17:00 Phoenix claims *tomorrow's*
   UTC key, and the real 6 AM digest is then refused as "already sent today".
2. **The digest can precede the refresh and never be corrected.** Vercel
   Hobby cron fires anywhere inside the scheduled hour, so a 5:59 refresh and
   a 6:00 digest are both on schedule. The digest then reports "One session
   behind"; when the GitHub Actions backup (24 min to 9 h late, measured) calls
   again with the fresh session, it is suppressed by the same day key. The
   reader gets stale numbers and no correction.

Fix: key on the **Phoenix** calendar day and on **`asOf`**. A stalled
pipeline still sends exactly one email per day (same asOf all day), which
preserves the heartbeat argument documented at `lib/mail-ledger.ts:13-21`. A
day where the data advanced after the first digest sends one corrected
digest. Never more than two.

## Current state

- `lib/mail-ledger.ts:24-26`:

```ts
export function digestKey(today: string): string {
  return `digest:${today}`;
}
```

- `lib/dates.ts` — has only `isoDaysAgo(n)`, deliberately UTC (see its header
  comment: Polygon dates are UTC dates; keep that function as it is).
- `app/api/digest/route.ts:128-140` (pre-008 numbering):

```ts
  const key = digestKey(isoDaysAgo(0));
  if (await alreadySent("digest", key)) {
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "digest already sent today",
```

- `lib/mail-ledger.test.ts` — three `digestKey` tests; the comment at lines
  5-9 records the heartbeat rationale and must be kept.
- Phoenix has no DST; `.github/workflows/schedule.yml` and `README.md:170`
  both rely on the fixed UTC-7 offset. Use the same fact here rather than
  pulling in a timezone library.
- There is no `lib/dates.test.ts` at `7d56c3f`; create it.

## Commands you will need

| Purpose   | Command                                | Expected |
|-----------|----------------------------------------|----------|
| Typecheck | `npm run typecheck`                    | exit 0 |
| Tests     | `npx vitest run lib/mail-ledger.test.ts lib/dates.test.ts` | pass |
| All tests | `npm test`                             | pass |
| Lint      | `npx eslint lib/dates.ts lib/mail-ledger.ts app/api/digest/route.ts` | no new problems |

## Scope

**In scope**:
- `lib/dates.ts`, `lib/dates.test.ts` (create)
- `lib/mail-ledger.ts`, `lib/mail-ledger.test.ts`
- `app/api/digest/route.ts`

**Out of scope**:
- `alertKey` — one alert per session is correct as is.
- `isoDaysAgo` — every Polygon caller depends on it being UTC.
- `lib/db.ts` — the ledger table needs no change; old-format rows are
  harmless history.
- `app/api/refresh/route.ts`.

## Git workflow

- Branch: `advisor/009-digest-key`
- One commit: `Key the digest ledger on the Phoenix day and the session it reports`

## Steps

### Step 1: Add a Phoenix-day helper

Append to `lib/dates.ts`:

```ts
/**
 * ISO yyyy-mm-dd for "today" as a reader in Phoenix experiences it.
 *
 * Phoenix is UTC-7 with no daylight saving, so the offset is a constant and
 * needs no timezone database. This exists for one purpose: deciding whether
 * the morning digest has already gone out TODAY. That question is asked by a
 * person waking up in Arizona, not by a server in UTC -- and a manual run at
 * 6 PM Phoenix is still "today" to them, whereas in UTC it is already
 * tomorrow and would silence the next morning's email.
 */
export function phoenixToday(now: Date = new Date()): string {
  // en-CA formats as yyyy-mm-dd. Same approach as dayLabel() in
  // lib/refresh-stamp.ts, which already reasons about Phoenix calendar days.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
```

(`lib/refresh-stamp.ts:115-117` uses exactly this `Intl` call inside
`dayLabel`; matching it keeps the two modules agreeing on what "today" means.)

Create `lib/dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isoDaysAgo, phoenixToday } from "./dates";

describe("phoenixToday", () => {
  /** 23:30 UTC is 16:30 in Phoenix: still the same calendar day. */
  it("agrees with UTC before 07:00 UTC of the next day", () => {
    expect(phoenixToday(new Date("2026-09-23T23:30:00Z"))).toBe("2026-09-23");
  });

  /**
   * 02:00 UTC on the 24th is 19:00 on the 23rd in Phoenix. A manual digest
   * run at that hour must be keyed to the 23rd, or the 24th's real 6 AM
   * digest is refused as already sent.
   */
  it("stays on the Phoenix day after UTC midnight", () => {
    expect(phoenixToday(new Date("2026-09-24T02:00:00Z"))).toBe("2026-09-23");
  });

  it("rolls over at 07:00 UTC", () => {
    expect(phoenixToday(new Date("2026-09-24T06:59:59Z"))).toBe("2026-09-23");
    expect(phoenixToday(new Date("2026-09-24T07:00:00Z"))).toBe("2026-09-24");
  });
});

describe("isoDaysAgo", () => {
  it("returns a yyyy-mm-dd string", () => {
    expect(isoDaysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

**Verify**: `npx vitest run lib/dates.test.ts` → 4 pass.

### Step 2: Extend the key

In `lib/mail-ledger.ts` replace `digestKey` and its doc comment with:

```ts
/**
 * The digest is keyed by the DAY IT IS SENT and the SESSION it describes.
 *
 * Keying on the day alone looks right and is not quite. The digest is a
 * heartbeat: it must arrive every weekday even when the data has not moved,
 * because "4 sessions behind" is precisely the message that tells you the
 * refresh died -- so the day is part of the key, and a stalled pipeline
 * still sends exactly once per day (the session does not change).
 *
 * The session is ALSO part of the key because the 6 AM digest can legally
 * fire before the 5 AM refresh has landed (Hobby cron precision is the whole
 * hour). Without asOf in the key that morning's "one session behind" email
 * is the only one you get; with it, the later backup scheduler sends one
 * corrected digest once the new session exists. Never more than two a day.
 *
 * `today` is the Phoenix calendar day from phoenixToday(), not UTC: a manual
 * run at 6 PM Phoenix is still "today" to the reader, but is already
 * tomorrow in UTC and would silence the next real morning.
 */
export function digestKey(today: string, asOf: string): string {
  return `digest:${today}:${asOf}`;
}
```

Update `lib/mail-ledger.test.ts` `describe("digestKey")` to:

```ts
describe("digestKey", () => {
  /**
   * The bug this guards: keying the digest on the SESSION alone would mean a
   * stalled pipeline sends one email and then goes silent -- the exact
   * failure the digest exists to make visible. The day must be in the key.
   */
  it("changes every day even when the session does not", () => {
    expect(digestKey("2026-09-14", "2026-09-11")).not.toBe(digestKey("2026-09-15", "2026-09-11"));
  });

  it("is stable within a day for the same session, so a second caller is suppressed", () => {
    expect(digestKey("2026-09-15", "2026-09-14")).toBe(digestKey("2026-09-15", "2026-09-14"));
  });

  /**
   * The other bug: the digest fired before the refresh landed, reported one
   * session behind, and the corrected data never got an email that day.
   */
  it("changes within a day when the session advances", () => {
    expect(digestKey("2026-09-15", "2026-09-12")).not.toBe(digestKey("2026-09-15", "2026-09-14"));
  });

  it("is namespaced so it cannot collide with an alert key", () => {
    expect(digestKey("2026-09-15", "2026-09-15")).not.toBe(alertKey("2026-09-15"));
  });
});
```

**Verify**: `npx vitest run lib/mail-ledger.test.ts` → 6 pass.
`npm run typecheck` → exactly one error, in `app/api/digest/route.ts` (wrong
arity). Anything else: STOP.

### Step 3: Fix the route

In `app/api/digest/route.ts`:
- change the import `import { isoDaysAgo } from "@/lib/dates";` to
  `import { phoenixToday } from "@/lib/dates";`
- change `const key = digestKey(isoDaysAgo(0));` to
  `const key = digestKey(phoenixToday(), screen.asOf);`
- change the reason string `"digest already sent today"` to
  `"digest already sent today for this session"`.

**Verify**: `npm run typecheck` → 0. `grep -n "isoDaysAgo" app/api/digest/route.ts` → none.

### Step 4: Mutation check (mandatory)

Temporarily make `digestKey` ignore `asOf` (return `` `digest:${today}` ``).
`npx vitest run lib/mail-ledger.test.ts` → "changes within a day when the
session advances" MUST fail. Restore. Then temporarily make `phoenixToday`
return the UTC date (`now.toISOString().slice(0,10)`); `npx vitest run lib/dates.test.ts`
→ "stays on the Phoenix day after UTC midnight" MUST fail. Restore. Report both.

### Step 5: Full gates

`npm run typecheck` → 0. `npm test` → 492 + 3 (plan 008) + 5 new = 500 pass
(4 in dates.test.ts, 1 net new in mail-ledger.test.ts).

## Done criteria

- [ ] `grep -n "digestKey(" app lib | grep -v test` shows only the two-argument call in the digest route
- [ ] `npm run typecheck` exits 0; `npm test` exits 0 with the new tests
- [ ] Both mutation checks performed and reported
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `screen.asOf` is not available in the digest route at the point where the
  key is built (it is at `7d56c3f`; plan 013 must keep it so).
- Any file other than the digest route calls `digestKey`.
- A mutation check does not fail its test.

## Maintenance notes

- Existing `mail_sends` rows with the old `digest:<date>` shape stay in the
  table and match nothing new. That is fine; plan 013's ledger script can
  list them.
- If the schedule ever moves out of Phoenix, `phoenixToday` is the one place
  to change, and its tests pin the offset.
- After this lands, a day can legitimately produce two digests: the early
  stale one and the corrected one. README's "When do emails arrive?" section
  (plan 015) should say so.
