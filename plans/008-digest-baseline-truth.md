# Plan 008: The digest says exactly why tier changes are or are not shown

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
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/digest.ts lib/digest.test.ts app/api/digest/route.ts`
> If any in-scope file changed since this plan was written, compare the
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

The morning digest exists to tell the reader, truthfully, what state the
pipeline is in. Today it collapses three different situations into one false
sentence. `app/api/digest/route.ts:83` swallows any database error from
`previousTiers` into `null`, and line 98 turns `null` into
`changesComparable: false`. `lib/digest.ts:93-95` then prints
**"Tier changes not comparable: the previous session was reconstructed, not
live."** That sentence is a lie when (a) there is no previous session at all,
and (b) the database query failed. Case (b) is the worse one: a broken
database is reported as an ordinary replay artefact, in the one email whose
job is to surface broken infrastructure. The subject line
(`lib/digest.ts:84-88`) has the same collapse.

After this plan the digest carries a four-way baseline state, each with its
own honest wording, and a database failure is called a failure.

## Current state

- `lib/digest.ts:26-49` — `DigestInput`, currently with
  `readonly changesComparable: boolean;` at line 40.
- `lib/digest.ts:78-90` — `digestSubject`:

```ts
  const moved = !d.changesComparable
    ? "baseline not comparable"
    : d.changes.length > 0
      ? `${d.changes.length} moved`
      : "no tier changes";
```

- `lib/digest.ts:92-102` — `changeLines`:

```ts
function changeLines(d: DigestInput): string[] {
  if (!d.changesComparable) {
    return ["Tier changes not comparable: the previous session was reconstructed, not live."];
  }
  if (d.changes.length === 0) return ["No tier changes."];
```

- `app/api/digest/route.ts:83-98`:

```ts
  const previous = await previousTiers(screen.asOf).catch(() => null);
  const changes = diffTiers(
    previous?.tiers ?? new Map(),
    screen.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, rsPct: r.rsPct, vsMa: r.vsMa })),
  );
  ...
    changesComparable: previous?.source === "live",
```

- `lib/db.ts:724-745` — `previousTiers(session)` returns
  `{ session, source: "live" | "replay", tiers }` or `null` when no earlier
  session exists. It throws on a query failure.

- `lib/digest.test.ts:4-24` — the `base` fixture uses `changesComparable: true`;
  lines 98-107 and 188-193 test the "not comparable" wording. These must be
  updated, not deleted.

Conventions: pure formatting in `lib/digest.ts`, no I/O; tests in
`lib/digest.test.ts` use a `base` fixture and spread overrides. Comments
explain why. Match both.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `npm run typecheck`              | exit 0 |
| Tests     | `npx vitest run lib/digest.test.ts` | all pass |
| All tests | `npm test`                       | 492 + new tests pass |
| Lint      | `npx eslint lib/digest.ts app/api/digest/route.ts` | no new problems |

## Scope

**In scope**:
- `lib/digest.ts`
- `lib/digest.test.ts`
- `app/api/digest/route.ts`

**Out of scope**:
- `lib/alerts.ts` — the alert's `SendContext`/`suppressionReason` already
  distinguish these states correctly; leave them.
- `lib/db.ts` — do not change `previousTiers`.
- Any other field of `DigestInput` (plan 014 adds content; keep this one to
  the baseline state).

## Git workflow

- Branch: `advisor/008-digest-baseline-truth`
- One commit: `Make the digest name the real reason tier changes are missing`

## Steps

### Step 1: Replace the boolean with a four-way state

In `lib/digest.ts`, replace line 39-40 (`/** Whether the baseline … */` and
`readonly changesComparable: boolean;`) with:

```ts
  /**
   * What the tier changes were measured against.
   *
   *   live        -- a real previous session; `changes` is meaningful
   *   replay      -- a reconstructed session; diffing it reports ruleset
   *                  differences as market moves, so `changes` is withheld
   *   none        -- no earlier session exists (first run)
   *   unavailable -- the lookup itself failed; this is an infrastructure
   *                  fault and the email must say so, not dress it as a replay
   */
  readonly baseline: "live" | "replay" | "none" | "unavailable";
```

Export the type for the route: add above `DigestInput`:

```ts
export type BaselineState = "live" | "replay" | "none" | "unavailable";
```

and use `readonly baseline: BaselineState;`.

**Verify**: `grep -n "changesComparable" lib/digest.ts` → no matches.

### Step 2: Word the subject per state

Replace the `moved` expression in `digestSubject` with:

```ts
  const moved =
    d.baseline === "live"
      ? d.changes.length > 0
        ? `${d.changes.length} moved`
        : "no tier changes"
      : d.baseline === "replay"
        ? "baseline not comparable"
        : d.baseline === "none"
          ? "no baseline yet"
          : "BASELINE UNAVAILABLE";
```

Keep the existing order: warnings first, staleness second, then this.

### Step 3: Word the body per state

Replace the `if (!d.changesComparable)` branch in `changeLines` with:

```ts
  if (d.baseline === "replay") {
    return ["Tier changes not comparable: the previous session was reconstructed, not live."];
  }
  if (d.baseline === "none") {
    return ["No previous session to compare against yet."];
  }
  if (d.baseline === "unavailable") {
    return ["Tier changes unavailable: the previous session could not be read from the database."];
  }
```

**Verify**: `npm run typecheck` → errors ONLY in `lib/digest.test.ts` and
`app/api/digest/route.ts` (the callers you fix next). If it reports errors
elsewhere, STOP.

### Step 4: Fix the route

In `app/api/digest/route.ts` replace lines 83-87 and the
`changesComparable` line with:

```ts
  // Diff against the previous session, exactly as the alert does. Three
  // non-live outcomes are kept apart on purpose: "no earlier session",
  // "earlier session is a replay" and "the lookup failed" are different
  // facts, and the last one is the kind of failure this email exists to
  // surface, so it must not be reported as one of the other two.
  let baseline: BaselineState;
  let previousTierMap: ReadonlyMap<string, string> = new Map();
  try {
    const previous = await previousTiers(screen.asOf);
    if (!previous) baseline = "none";
    else {
      baseline = previous.source;
      previousTierMap = previous.tiers;
    }
  } catch {
    baseline = "unavailable";
  }
  const changes =
    baseline === "live"
      ? diffTiers(
          previousTierMap,
          screen.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, rsPct: r.rsPct, vsMa: r.vsMa })),
        )
      : [];
```

and pass `baseline,` where `changesComparable: previous?.source === "live",`
was. Import the type: `import { buildDigest, tierCounts, type BaselineState } from "@/lib/digest";`.

**Verify**: `npm run typecheck` → errors only in `lib/digest.test.ts`.

### Step 5: Update and extend the tests

In `lib/digest.test.ts`:

1. In `base`, replace `changesComparable: true,` with `baseline: "live",`.
2. Wherever a test sets `changesComparable: false`, set `baseline: "replay"`.
3. Add, inside `describe("digestSubject")`:

```ts
  it("names each non-live baseline state differently", () => {
    expect(digestSubject({ ...base, baseline: "replay" })).toMatch(/baseline not comparable/);
    expect(digestSubject({ ...base, baseline: "none" })).toMatch(/no baseline yet/);
    expect(digestSubject({ ...base, baseline: "unavailable" })).toMatch(/BASELINE UNAVAILABLE/);
  });
```

4. Add, inside `describe("buildDigest")`:

```ts
  /**
   * A failed database read used to be reported as "the previous session was
   * reconstructed" -- a plausible-sounding sentence that hid an outage inside
   * the one email built to reveal outages.
   */
  it("calls a failed baseline lookup a failure, not a replay", () => {
    const { text } = buildDigest({ ...base, baseline: "unavailable" });
    expect(text).toMatch(/could not be read from the database/);
    expect(text).not.toMatch(/reconstructed/);
  });

  it("does not blame a replay when there simply is no earlier session", () => {
    const { text } = buildDigest({ ...base, baseline: "none" });
    expect(text).toMatch(/No previous session/);
    expect(text).not.toMatch(/reconstructed/);
  });
```

**Verify**: `npx vitest run lib/digest.test.ts` → all pass, count is the
previous count + 3.

### Step 6: Mutation check (mandatory)

Temporarily change the `"unavailable"` branch in `changeLines` to return the
replay sentence. Run `npx vitest run lib/digest.test.ts` → the new
"calls a failed baseline lookup a failure" test MUST fail. Restore the code
and re-run → all pass. Report the observed failure in your summary.

### Step 7: Full gates

**Verify**: `npm run typecheck` → 0. `npm test` → 495 pass.
`npx eslint lib/digest.ts lib/digest.test.ts app/api/digest/route.ts` → no new problems.

## Done criteria

- [ ] `grep -rn "changesComparable" lib app` → no matches
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; 3 new tests present and passing
- [ ] Mutation check performed and reported
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `previousTiers` no longer returns a `source` field of exactly
  `"live" | "replay"`.
- A test outside `lib/digest.test.ts` references `changesComparable`
  (grep first; none does at `7d56c3f`).
- The mutation check does not fail the new test.

## Maintenance notes

- Plan 013 moves this route's compose logic into `lib/digest-service.ts`;
  it must carry the four-way `baseline` across unchanged.
- Plan 010 adds a claim/release ledger to this route; the two touch different
  lines but the same file, so land this one first.
- Reviewer: confirm the subject still leads with `DATA WARNING`, then
  `STALE`, then the baseline wording — the priority order is a documented
  choice (`lib/digest.ts:71-77`).
