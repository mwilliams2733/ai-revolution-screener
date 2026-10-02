# Plan 001: Make `assessStaleness` compare against a real trading calendar so a stalled refresh is actually reported

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat c070570..HEAD -- lib/screen-service.ts lib/staleness.ts lib/staleness.test.ts lib/polygon.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/002-per-request-load-warnings.md` — **DONE and merged**
  as commit `c070570`. This plan is written against the post-002 code: there is
  no module-level `loadWarnings`, only a per-request `warnings` array.
- **Category**: bug
- **Planned at**: commit `c070570`, 2026-09-16 (fully rewritten against the
  merged result of plan 002 — all line numbers below are from `c070570`)

## Why this matters

The app's staleness detector is a tautology and can never fire. It compares the
screen's as-of date against a calendar whose first element **is** that same
date, so `indexOf` always returns 0 and the report is always
`{freshness: "current", sessionsBehind: 0, label: "Latest close"}`.

The concrete cost: if the nightly refresh stops on a Friday, then on the
following Wednesday the site still displays week-old ranks under the label
"Latest close", the staleness banner never renders, and the morning digest's
subject line never escalates to `STALE`. This is the exact failure the module
was written to surface (its own docstring: "a cron outage or an API failure
leaving the screen frozen on a week-old session while looking exactly as it
does when fresh").

**The bug appears TWICE**, once in the main screen and once in the ticker-lookup
path. Both must be fixed; fixing one leaves the other permanently claiming
freshness.

## Current state

Files involved:

- `lib/staleness.ts` — the pure comparison function. **It is correct and must not change.**
- `lib/screen-service.ts` — contains both miswired calls.
- `lib/polygon.ts` — `anchorDates()` and `tradingCalendar()`.
- `lib/dates.ts` — `isoDaysAgo(n)` helper.

### The tautology

`lib/polygon.ts:283-295` — anchor dates are taken from the head of the calendar:

```ts
export function anchorDates(
  calendar: readonly string[],
  lookbacks: Readonly<Record<string, number>>,
): Record<string, string | undefined> {
  return {
    now: calendar[0],
```

**Call site 1** — `computeScreen`, `lib/screen-service.ts:523` and `:678`:

```ts
  const { calendar, source: calendarSource } = await resolveCalendar();
  // Keep the calendar so staleness is measured in sessions, not calendar days.
  const dates = anchorDates(calendar, DEFAULT_PARAMS.lookbacks);
  ...
    staleness: assessStaleness(dates.now as string, calendar),
```

**Call site 2** — `getScreenRanked` (behind `/api/lookup/{ticker}`),
`lib/screen-service.ts:813` and `:831`:

```ts
  const { calendar } = await resolveCalendar();
  const dates = anchorDates(calendar, DEFAULT_PARAMS.lookbacks);
  ...
    staleness: assessStaleness(dates.now as string, calendar),
```

In both, `dates.now === calendar[0]`, so `lib/staleness.ts:33`
(`calendar.indexOf(asOf)`) is always `0` and `:43` returns `current`
unconditionally.

Why the existing tests pass anyway — `lib/staleness.test.ts` hand-feeds an
`asOf` that differs from `calendar[0]`, which production never produces. The
pure function is correct; only the wiring is wrong. **Do not "fix" the tests.**

### Why the stored calendar cannot answer the question

`lib/screen-service.ts:285-297`:

```ts
async function resolveCalendar(): Promise<{ calendar: string[]; source: Source }> {
  const needed = DEFAULT_PARAMS.lookbacks.r12m + 1;
  if (dbConfigured()) {
    try {
      const stored = await storedTradingSessions();
      if (stored.length >= needed) return { calendar: stored, source: "db" };
    } catch {
      // fall through to the API
    }
  }
  const calendar = await tradingCalendar(isoDaysAgo(430), isoDaysAgo(0));
  return { calendar, source: "api" };
}
```

`storedTradingSessions()` returns only sessions **already stored**, newest
first. Correct for anchors, useless as a freshness reference: when the refresh
stalls, the stored ledger stalls with it.

The independent reference you will use, `lib/polygon.ts:246-257`:

```ts
export async function tradingCalendar(
  from: string,
  to: string,
  proxyTicker = "NVDA",
  opts: FetchOptions = {},
): Promise<string[]> {
```

It returns real session dates (newest first) from a proxy ticker's aggregates,
independent of what this app has stored. **It is already imported** in
`lib/screen-service.ts:16`, as is `isoDaysAgo` at `:67`.

### The warnings convention (from plan 002 — read this)

There is **no module-level warnings array**. Plan 002 removed it. Each request
owns a local, declared in `computeScreen` at `lib/screen-service.ts:521`:

```ts
  const warnings: string[] = [];
```

and loaders receive it as a parameter, e.g. `lib/screen-service.ts:88-95`:

```ts
async function loadHistory(
  tickers: readonly string[],
  warnings: string[],
): Promise<Map<string, number[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadCloseHistory(MA_WINDOW, tickers);
  } catch (e) {
    warnings.push(`close history: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}
```

Your new helper must follow that shape exactly. **`getScreenRanked` has no
warnings array** — it builds no `meta`, so it gets a throwaway one (Step 3).

Other conventions:

- **A missing measurement must never render as a real one.** `lib/format.ts:1-10`
  and `lib/staleness.ts:34-41` both encode this. Your failure path must return
  `very-stale`, never `current` — see Step 2.
- Dates are UTC throughout; `lib/dates.ts:9-11` explains why. Do not introduce
  local-time or Phoenix-time reasoning.

## Commands you will need

| Purpose   | Command                                | Expected on success |
|-----------|----------------------------------------|---------------------|
| Typecheck | `npm run typecheck`                    | exit 0, no errors   |
| Tests     | `npm test`                             | all pass (489 at `c070570`) |
| One file  | `npx vitest run lib/staleness.test.ts` | all pass            |
| Lint      | `npm run lint`                         | 6 pre-existing problems; add none |

## Scope

**In scope** (the only files you should modify):

- `lib/screen-service.ts`
- `lib/staleness.test.ts` (add cases)

**Out of scope** (do NOT touch, even though they look related):

- `lib/staleness.ts` — the pure function is correct. Changing it means you have
  misread the bug.
- `lib/polygon.ts` — `anchorDates` returning `calendar[0]` is correct for
  anchors; that is not the defect.
- `resolveCalendar()` — do not repoint anchors at the API calendar. Anchors must
  keep coming from stored sessions.
- `app/page.tsx` — the banner already renders on
  `data.staleness.freshness !== "current"` (`app/page.tsx:79-84`). No UI change.
- `lib/digest.ts` — already escalates on `sessionsBehind >= 2` (`:80`).
- `.env.local` / `.env.example` — never read, create, or print.

## Git workflow

- Branch: `advisor/001-staleness-real-calendar`
- One commit; imperative subject with a prose body, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the reference-calendar helper

Add a module-level function immediately after `resolveCalendar()` (which ends at
`lib/screen-service.ts:297`):

```ts
/**
 * A trading calendar that does NOT come from what we have stored.
 *
 * Staleness asks "is our newest stored session the newest session that exists".
 * Answering it with the stored ledger is circular -- the ledger's head IS our
 * as-of date, so indexOf is always 0 and the check can never fail. The proxy
 * aggregates know about sessions this app has never fetched, which is exactly
 * the gap a stalled refresh opens.
 *
 * Today is excluded: this plan serves delayed end-of-day bars, so the current
 * session is never the expected as-of date, and counting it would report every
 * afternoon as one session behind.
 *
 * Returns null when the reference cannot be fetched. Callers must treat that as
 * "unknown", never as "fresh".
 */
async function referenceCalendar(warnings: string[]): Promise<string[] | null> {
  try {
    const today = isoDaysAgo(0);
    const cal = await tradingCalendar(isoDaysAgo(30), today);
    return cal.filter((d) => d < today);
  } catch (e) {
    warnings.push(`reference calendar: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
```

Notes:

- `tradingCalendar` (`:16`) and `isoDaysAgo` (`:67`) are **already imported**.
  Do not add duplicate imports.
- 30 days yields ~20 sessions — more than the `very-stale` threshold needs, and
  far cheaper than `resolveCalendar`'s 430-day call.
- The `filter` compares ISO `yyyy-mm-dd` strings; lexicographic order equals
  chronological order for this format. Intentional — do not convert to `Date`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Fix call site 1 (`computeScreen`)

`computeScreen` already has a `warnings` local at `lib/screen-service.ts:521`.
Add the fetch alongside the other loaders — immediately before the `medians`
block at `:556` is a good home:

```ts
  const reference = await referenceCalendar(warnings);
```

Then replace the staleness line at `lib/screen-service.ts:678`:

```ts
    staleness: reference
      ? assessStaleness(dates.now as string, reference)
      : {
          freshness: "very-stale" as const,
          sessionsBehind: Number.POSITIVE_INFINITY,
          label: "Freshness could not be checked",
        },
```

The fallback must **not** be changed to `"current"`. If the reference fetch
failed we do not know the data is fresh, and this repo's rule is that an unknown
measurement never renders as a good one. The warning from Step 1 explains it in
`meta.warnings`.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Fix call site 2 (`getScreenRanked`)

`getScreenRanked` starts at `lib/screen-service.ts:806` and builds no
`meta.warnings`, so it has nowhere to report a failed reference fetch. Give it a
throwaway array — this mirrors how plan 002 left its `resolveReference` call
alone for the same reason.

After `const { calendar } = await resolveCalendar();` at `:813`, add:

```ts
  // Throwaway: this path returns no meta.warnings, so a failed reference fetch
  // has nowhere to be reported. The staleness fallback below still refuses to
  // claim freshness, which is the part that matters.
  const refWarnings: string[] = [];
  const reference = await referenceCalendar(refWarnings);
```

Then replace the staleness line at `:831` with the same shape as Step 2:

```ts
    staleness: reference
      ? assessStaleness(dates.now as string, reference)
      : {
          freshness: "very-stale" as const,
          sessionsBehind: Number.POSITIVE_INFINITY,
          label: "Freshness could not be checked",
        },
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "assessStaleness(dates.now as string, calendar)" lib/screen-service.ts`
  → `0` (**both** circular calls are gone)
- `grep -c "referenceCalendar" lib/screen-service.ts` → `3` (definition + two calls)

### Step 4: Add regression tests

Add a new `describe` block to `lib/staleness.test.ts`, modelled on the existing
one (plain vitest `describe`/`it`/`expect`, no mocks, no setup):

```ts
describe("assessStaleness wiring contract", () => {
  /**
   * The bug this guards: production passed the STORED calendar, whose head is
   * the as-of date itself, so indexOf was always 0. Any calendar that starts
   * with asOf reports current by construction -- which is why the reference
   * calendar must come from a source independent of what we stored.
   */
  it("is vacuously current whenever asOf heads the calendar", () => {
    const anyCal = ["2026-08-20", "2026-08-19", "2026-08-18"];
    expect(assessStaleness(anyCal[0], anyCal).freshness).toBe("current");
  });

  it("reports the gap when the stored head trails the real calendar", () => {
    // Refresh stalled after 2026-08-17; the market kept trading.
    const reference = ["2026-08-20", "2026-08-19", "2026-08-18", "2026-08-17"];
    const r = assessStaleness("2026-08-17", reference);
    expect(r.freshness).toBe("very-stale");
    expect(r.sessionsBehind).toBe(3);
  });

  it("calls a weekend one session behind, not stale-alarming", () => {
    // Saturday: newest completed session is Friday, we hold Thursday's close.
    const reference = ["2026-08-21", "2026-08-20", "2026-08-19"];
    const r = assessStaleness("2026-08-20", reference);
    expect(r.sessionsBehind).toBe(1);
    expect(r.freshness).toBe("stale");
  });
});
```

**Verify**: `npx vitest run lib/staleness.test.ts` → 8 tests pass (5 existing + 3 new).

### Step 5: Record honestly what is and is not guarded

These tests exercise the **pure function**, so they would still pass if someone
reverted Steps 2-3 and reintroduced the circular call. That is a real limitation,
not an oversight to paper over.

Confirm it deliberately: temporarily put `calendar` back in place of `reference`
at the Step 2 call site, run `npm test`, observe that everything still passes,
then restore.

In your final report, state plainly that the wiring is guarded by the `grep` in
Done criteria rather than by a test, and that a genuine regression test would
need integration coverage of `computeScreen`. **Do not add such a test here.**

**Verify**: `git diff lib/screen-service.ts` shows both Step 2 and Step 3
changes present, and `npm test` → all pass.

## Test plan

- 3 new cases in `lib/staleness.test.ts` under
  `describe("assessStaleness wiring contract")`.
- Structural pattern: the existing `describe("assessStaleness")` block in the
  same file.
- Do not modify or delete any existing test.
- Verification: `npm test` → **492** passing (489 + 3).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` reports no NEW problems (it does NOT exit 0 — 6 pre-existing)
- [ ] `npm test` exits 0 with **492** passing (489 + 3 new)
- [ ] `grep -c "assessStaleness(dates.now as string, calendar)" lib/screen-service.ts` returns `0`
- [ ] `grep -c "referenceCalendar" lib/screen-service.ts` returns `3`
- [ ] `grep -c "Freshness could not be checked" lib/screen-service.ts` returns `2`
- [ ] `lib/staleness.ts` is unmodified (`git diff --stat c070570..HEAD -- lib/staleness.ts` is empty)
- [ ] Step 5's revert-and-observe was performed and reported
- [ ] Only the two in-scope files are modified (`git status`)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- `grep -c "assessStaleness(dates.now as string, calendar)" lib/screen-service.ts`
  does not return `2` before you start. This plan assumes exactly two call sites.
- `tradingCalendar` needs a `POLYGON_API_KEY` you do not have and you cannot
  typecheck. Do **not** stub the API.
- You find yourself needing to modify `lib/staleness.ts`, `app/page.tsx`, or
  `lib/digest.ts` — the fix is one helper plus two call sites.
- `npm test` shows failures in files you did not touch.

## Maintenance notes

- **Expected behaviour change, flag it in review**: the page will now show a
  staleness banner from Friday evening until the Monday 05:00 Phoenix refresh,
  because the app genuinely holds Thursday's close across the weekend. That is
  the documented cost of dropping the afternoon cron (commit `21592e3`), and the
  banner is now telling the truth rather than hiding it. If it proves noisy, the
  options are (a) restore the 22:00 UTC refresh cron, or (b) suppress the banner
  at `sessionsBehind === 1`. **Both are product decisions — do not make either
  as part of this plan.**
- The digest subject only escalates at `sessionsBehind >= 2` (`lib/digest.ts:80`),
  so weekends will not change email subjects.
- Cost: one extra Polygon call per cold screen build, and one per ticker lookup.
  The screen's is behind the 15-minute memo; `getScreenRanked` is **not**
  memoised, so a user checking five tickers makes five extra calls. Acceptable
  today, but it is the second reason to fix that function's lack of caching (the
  first being that it re-ranks the whole universe per lookup).
- A reviewer should check both fallbacks return `very-stale`, not `current`.
- **Deferred**: integration coverage of `computeScreen` that would catch a
  re-wiring regression. Needs a database and Polygon fixture harness this repo
  does not have.
