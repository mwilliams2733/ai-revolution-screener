# Plan 002: Make loader warnings per-request so a failed loader can never report a clean run

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4b70edf..HEAD -- lib/screen-service.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. **Plan 001 depends on THIS one** and must not run in
  parallel with it — 001 adds a helper that pushes to `loadWarnings`, which this
  plan deletes. The two branches would merge cleanly and produce code that does
  not compile. Land this first.
- **Category**: bug
- **Planned at**: commit `4b70edf`, 2026-09-16 (rebaselined; `lib/screen-service.ts` itself is unchanged since `4fd256c`, so every excerpt and line number below is still exact)

## Why this matters

`loadWarnings` is a module-level array that is **cleared in the middle of the
pipeline**. Four loaders push warnings before that reset, so their failures are
erased before anyone reads them; the loaders that run after the reset push into
an array that is never cleared between requests, so their warnings accumulate
and duplicate across every call served by the same warm instance, and two
concurrent screen builds interleave into each other's list.

The concrete cost: if `medianDollarVolume` throws — plausible, it is a
50-session scan against a database with a documented 64MB response cap — every
name silently falls back to same-day dollar volume. That **changes the ranked
universe**, which changes every percentile and therefore every tier. The
warning recording it is wiped at line 583 and `meta.warnings` comes back empty,
so the screen reports a clean run and the audit reports no errors.

This defeats the exact purpose the array was created for. Its own docstring:
"A swallowed error here previously made every row fall back to the proxy while
the audit reported 'needs the backfill' — which was false, the backfill had
run."

After this plan, warnings are owned by one request, survive the whole pipeline,
and never leak between requests.

## Current state

One file: `lib/screen-service.ts`.

The global, at `lib/screen-service.ts:85-92`:

```ts
/**
 * Loader failures must not look like "no database".
 *
 * A swallowed error here previously made every row fall back to the proxy while
 * the audit reported "needs the backfill" -- which was false, the backfill had
 * run. Failures are recorded and surfaced in meta.warnings instead.
 */
const loadWarnings: string[] = [];
```

The mid-pipeline reset, at `lib/screen-service.ts:583`:

```ts
  loadWarnings.length = 0;
```

Every push, by line (from `grep -n "loadWarnings" lib/screen-service.ts`):

| Line | Where | Relative to the reset at 583 |
|---|---|---|
| 99  | `loadHistory()` — close history        | helper, called at 585 (after) |
| 110 | `loadHistorySummary()` — tier history  | helper, called at 669 (after) |
| 121 | `loadTrendBars()` — trend history      | helper, called at 592 (after) |
| 132 | `loadVolumeBars()` — volume history    | helper, called at 627 (after) |
| 442 | `resolveReference()` — sectors         | **before — erased** |
| 536 | `medianDollarVolume` — median volume   | **before — erased** |
| 561 | `previousMomentumTiers` — prior tiers  | **before — erased** |
| 571 | `previousTiers` — prior final tiers    | **before — erased** |
| 612 | `companyHealth`                        | after — leaks across requests |
| 616 | `splitHistory`                         | after — leaks across requests |
| 650 | `lastRefresh` — refresh log            | after — leaks across requests |
| 708 | `warnings: [...loadWarnings]` (read)   | the payload |

The four helper functions that own their own pushes, `lib/screen-service.ts:94-135`:

```ts
async function loadHistory(tickers: readonly string[]): Promise<Map<string, number[]>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadCloseHistory(MA_WINDOW, tickers);
  } catch (e) {
    loadWarnings.push(`close history: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}
```

`loadHistorySummary()`, `loadTrendBars()` and `loadVolumeBars()` follow the
identical shape at `:105`, `:116` and `:127`.

The complication — `resolveReference()` is **cached for 6 hours**
(`lib/screen-service.ts:400-448`):

```ts
const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveReference(): Promise<Reference> {
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) {
    return referenceCache.value;
  }
  ...
    } catch (e) {
      loadWarnings.push(`sectors: ${e instanceof Error ? e.message : String(e)}`);
    }
  ...
  const value: Reference = { names, ciks, sectors, source };
  referenceCache = { at: Date.now(), value };
  return value;
}
```

It is called from two places: `lib/screen-service.ts:524` (inside
`computeScreen`) and `lib/screen-service.ts:800` (inside `getScreenRanked`).
Simply passing an array in would mean a sectors failure is reported on the
request that missed the cache and silently omitted for the next six hours of
cache hits. Step 2 handles this by storing the warnings **in the cached value**
so they replay on every hit — the failure is a property of the cached
reference data, so it belongs with it.

The `Reference` interface is declared at `lib/screen-service.ts:391`.

Repo conventions that apply here:

- **Derive, don't duplicate**: when two code paths must agree, make one call the
  other rather than keeping two copies in sync. That is why the cached warnings
  replay from the cache entry instead of being re-pushed by each caller.
- Warning strings follow `` `<source>: ${message}` `` — keep the existing
  prefixes (`close history:`, `sectors:`, `median volume:`) exactly as they are.
  `npm run audit:data` may match on them.
- `computeScreen` is the single request-scoped orchestrator; anything
  request-scoped belongs as a local inside it.

## Commands you will need

| Purpose    | Command                | Expected on success |
|------------|------------------------|---------------------|
| Typecheck  | `npm run typecheck`    | exit 0, no errors   |
| Tests      | `npm test`             | all pass (489 at `4b70edf`) |
| Lint       | `npm run lint`         | 6 pre-existing problems; add none |

## Scope

**In scope** (the only file you should modify):

- `lib/screen-service.ts`

**Out of scope** (do NOT touch):

- `lib/db.ts` — the loaders themselves are fine; only who owns their warnings changes.
- Any change to warning **text**. Prefixes and messages stay byte-identical.
- The `ScreenPayload.meta.warnings` field type — it is already `string[]`; the
  payload shape must not change.
- `getScreenRanked()` at `lib/screen-service.ts:785-812` — it calls
  `resolveReference()` but builds no `meta.warnings`. Give it a throwaway array
  (see Step 3); do not refactor it. It is the subject of a separate finding.
- The four loader helpers' `catch`-and-return-empty behaviour. Only the
  destination of the push changes.

## Git workflow

- Branch: `advisor/002-per-request-load-warnings`
- One commit; imperative subject with a prose body, matching `git log`.
- Plan 001 has NOT landed and must not; it is sequenced after this one.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Give the four loader helpers a `warnings` parameter

For each of `loadHistory` (`:94`), `loadHistorySummary` (`:105`),
`loadTrendBars` (`:116`) and `loadVolumeBars` (`:127`), add a final required
parameter `warnings: string[]` and push to it instead of the global.

Example, for `loadHistory`:

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

Apply the same change to the other three. `loadHistorySummary` and
`loadVolumeBars` currently take no parameters, so `warnings` becomes their only one.

Do not update the call sites yet — typecheck will fail after this step, which is
expected.

**Verify**: `npm run typecheck` → fails with "Expected 2 arguments, but got 1"
(or similar) at lines 585, 592, 627 and 669. That confirms you found every call site.

### Step 2: Carry reference warnings inside the cached `Reference`

Add a `warnings` field to the `Reference` interface at `lib/screen-service.ts:391`:

```ts
  /**
   * Failures from building THIS reference snapshot.
   *
   * Stored with the value rather than pushed to the caller, because the value
   * is cached for six hours: a caller that hits the cache must still learn
   * that its sectors are missing. Replaying from the cache entry keeps the one
   * fact in one place instead of two that must agree.
   */
  readonly warnings: readonly string[];
```

In `resolveReference()`, build a local array and attach it:

```ts
async function resolveReference(): Promise<Reference> {
  if (referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) {
    return referenceCache.value;
  }

  const warnings: string[] = [];
  ...
    } catch (e) {
      warnings.push(`sectors: ${e instanceof Error ? e.message : String(e)}`);
    }
  ...
  const value: Reference = { names, ciks, sectors, source, warnings };
  referenceCache = { at: Date.now(), value };
  return value;
}
```

**Verify**: `npm run typecheck` → the only remaining errors are the loader call
sites from Step 1 (no new errors mentioning `Reference`).

### Step 3: Make `computeScreen` own a request-scoped array

At the top of `computeScreen` (`lib/screen-service.ts:500-501`), declare the local:

```ts
async function computeScreen(): Promise<ScreenPayload> {
  const started = Date.now();
  // Request-scoped: a module-level array was being cleared mid-pipeline, which
  // erased every warning raised before the reset, and leaked the ones raised
  // after it into the next request served by the same warm instance.
  const warnings: string[] = [];
```

Then, in order:

1. **Line 524** — capture the reference warnings:
   ```ts
   const { names, ciks, sectors, source: namesSource, warnings: refWarnings } =
     await resolveReference();
   warnings.push(...refWarnings);
   ```
2. **Lines 536, 561, 571, 612, 616, 650** — replace `loadWarnings.push(` with
   `warnings.push(`. Leave every message string untouched.
3. **Line 583** — **delete** `loadWarnings.length = 0;` entirely, including its
   now-orphaned position. (The comment above it at `:581-582` belongs to the
   `loadHistory` call that follows; keep that comment.)
4. **Lines 585, 592, 627, 669** — pass `warnings` as the new final argument:
   ```ts
   const history = await loadHistory(themedTickers, warnings);
   const trendBars = await loadTrendBars(themedTickers, warnings);
   const volumeBars = await loadVolumeBars(warnings);
   history: await loadHistorySummary(warnings),
   ```
5. **Line 708** — read the local:
   ```ts
   warnings: [...warnings],
   ```
6. **Line 800** — `getScreenRanked()` also destructures `resolveReference()`. It
   does not build `meta`, so it has nothing to report warnings into. Leave its
   destructuring as-is (it only takes `names`); the added field is optional to
   destructure.

Finally, **delete the module-level `const loadWarnings: string[] = [];` at line
92**, keeping the docstring above it — move that docstring to sit above the new
local in `computeScreen`, since it explains why warnings exist at all.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "loadWarnings" lib/screen-service.ts` → **no matches**
- `grep -c "warnings.push" lib/screen-service.ts` → `7` (sectors, median volume,
  prior tiers, prior final tiers, company health, splits, refresh log) plus 4
  inside the loader helpers = confirm the total is `11`

### Step 4: Confirm no behaviour changed for the happy path

**Verify**: `npm test` → all 489 pass, none skipped, no new failures.

Then confirm the warning text is untouched:

`git diff -U0 lib/screen-service.ts | grep -E "^[+-].*(close history|tier history|trend history|volume history|sectors|median volume|prior tiers|prior final tiers|company health|splits|refresh log):"`

Every message must appear as both a `-` and a `+` line with **identical text
after the colon** — only the receiver (`loadWarnings` → `warnings`) differs.

## Test plan

No new unit tests. This is a plumbing change with no pure function to test: the
four loaders' failure paths need a throwing database to exercise, and this repo
has no database test harness (deliberately — see `lib/*.test.ts`, all of which
test pure functions with hand-built fixtures).

The verification is therefore structural, via the greps in Done criteria:
`loadWarnings` no longer exists, and no warning message text changed.

**This is a real coverage gap and you must say so in your report**: after this
change, nothing automatically proves that a failing `medianDollarVolume` reaches
`meta.warnings`. Adding that proof requires an injectable database seam that is
out of scope here (see Maintenance notes).

Verification: `npm test` → all pass, count unchanged at 489.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` reports **no NEW problems**. It does NOT exit 0 and never
      did: at `4b70edf` there are 6 pre-existing problems (1 error, 5 warnings)
      in `app/use-persisted-state.ts`, `app/leaders-table.tsx`, `lib/edgar.ts`,
      `lib/screen-service.ts` and `lib/solvency.test.ts`. The `screen-service.ts`
      one is an unused-import warning you may incidentally fix; that is fine.
      Do not go looking for the others.
- [ ] `npm test` exits 0, **489** passing, count unchanged (this plan adds no tests)
- [ ] `grep -n "loadWarnings" lib/screen-service.ts` returns **no matches**
- [ ] `grep -n "length = 0" lib/screen-service.ts` returns **no matches**
- [ ] `grep -n "warnings: readonly string\[\]" lib/screen-service.ts` returns the
      new `Reference` field
- [ ] No warning message text changed (the `git diff` grep in Step 4)
- [ ] Only `lib/screen-service.ts` is modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code, or
  `grep -n "loadWarnings" lib/screen-service.ts` returns a set of lines
  materially different from the table above.
- You find a `loadWarnings` reference **outside** `lib/screen-service.ts`
  (`grep -rn "loadWarnings" lib/ app/ scripts/`). This plan assumes the global
  is file-local; if it is exported and read elsewhere, the blast radius is
  larger than planned.
- Removing the reset at line 583 causes any test to fail. That would mean a test
  depends on the buggy clearing behaviour and needs a human decision.
- `npm run audit:data` (if you run it) fails on a warning-string match — it
  would mean a message changed when it should not have.

## Maintenance notes

- **The reset at line 583 is the bug; do not reintroduce it.** If a future
  change needs "only warnings from phase two", that is a second array with a
  different name, not a clearing of this one.
- Any new loader added to `computeScreen` must take `warnings` as a parameter.
  Because the global is gone, forgetting to do so is now a typecheck error
  rather than a silent loss — that is the main structural win here.
- `resolveReference`'s warnings replay for up to six hours after the failure
  that produced them. A reviewer should confirm this is understood: a sectors
  failure will keep appearing in `meta.warnings` until the cache expires, which
  is correct (the sectors really are still missing) but will look like a
  repeating error in the digest's warnings block.
- **Deferred**: a database seam that lets a test force a loader to throw and
  assert the warning reaches `meta.warnings`. That is the test that would make
  this guard real, and it needs an injectable `db` module — a larger refactor,
  worth doing before the next loader is added.
- Interacts with plan 001, which adds a `reference calendar:` warning through
  the same mechanism. If 001 lands first, that push must use the local
  `warnings` array, not the global.
