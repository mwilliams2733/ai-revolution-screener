# Plan 017: The replay never writes into a session that has live rows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `045bdd2`
> or a descendant, run `git merge --ff-only 045bdd2`; if that fails, STOP.
>
> **Drift check (run second)**: `git diff --stat 045bdd2..HEAD -- scripts/replay-tiers.ts README.md`
> must be empty, and `ls lib/replay-guard.ts` must fail (file does not exist yet).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — the replay writes fewer rows, never more
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `045bdd2`, 2026-10-01

## Why this matters

`scripts/replay-tiers.ts` rebuilds `tier_history` from stored bars. Its header
promises live rows are "NEVER OVERWRITTEN", and its upsert enforces that with
`ON CONFLICT (session, ticker) DO UPDATE ... WHERE tier_history.source <> 'live'`.
But that guard only protects rows that **already exist**. The replay's theme
set is not identical to the live one (the two paths filter liquidity
differently), so a ticker the live snapshot lacks is **inserted** as a
`replay` row into that live session.

**Observed, 2026-09-24:** a replay run inserted one `replay` row each into six
live sessions (2026-09-04, 09-08, 09-14, 09-15, 09-16, 09-18). A session
holding both kinds is read as a replay by `previousTiers` in `lib/db.ts`
(`bool_and(source = 'live')`), which suppresses the next session's alert and
makes the digest say "baseline not comparable". `npm run audit` checks for
mixed sessions after the fact; nothing prevents them.

## Current state (verified at 045bdd2)

- `scripts/replay-tiers.ts` (277 lines; last changed `27d5071`):
  - lines 186-266: `for (const session of order) { ... }`. Each iteration computes
    `capped` and `trended`, then updates the stateful chain:
    `prior = new Map(...)` (lines 221-223) and `incumbents = new Set(...)`
    (lines 225-227). It builds `rows` (lines 229-237), then writes them in
    batches of 500 (lines 239-260) and increments `written`. Then `done += 1`
    and a progress log (lines 262-265).
  - The INSERT at lines 243-258:
```ts
      await sql`
        INSERT INTO tier_history (session, ticker, rs_pct, vs_ma, tier, momentum_tier, weight, source)
        SELECT ${session}::date, *, 'replay' FROM UNNEST(
          ${batch.map((r) => r.ticker)}::text[],
          ${batch.map((r) => r.rsPct)}::float8[],
          ${batch.map((r) => r.vsMa)}::float8[],
          ${batch.map((r) => r.tier)}::text[],
          ${batch.map((r) => r.momentumTier)}::text[],
          ${batch.map((r) => r.weight)}::float8[]
        ) AS t(ticker, rs_pct, vs_ma, tier, momentum_tier, weight)
        ON CONFLICT (session, ticker) DO UPDATE SET
          rs_pct = EXCLUDED.rs_pct, vs_ma = EXCLUDED.vs_ma,
          tier = EXCLUDED.tier, momentum_tier = EXCLUDED.momentum_tier,
          weight = EXCLUDED.weight
        WHERE tier_history.source <> 'live'
      `;
```
  - lines 268-271: the final `console.log(\`\ndone: ${done} sessions, ${written...} rows, ...\`)`.
  - lines 23-29: the header paragraph beginning `NEVER OVERWRITTEN: rows the nightly refresh wrote live.`
- The chain (`prior`, `incumbents`) MUST still be updated for live sessions:
  hysteresis and the cap's incumbency carry from one session to the next, so
  skipping the computation would change every later replayed session.
- `README.md` lines 266-272: the bullet beginning
  `- **The replay will not overwrite a live row**, but it can add to a live`.
- Test conventions: `lib/*.test.ts`, vitest, `describe`/`it`, comments explain
  the bug a test guards (see `lib/mail-ledger.test.ts`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 (covers `scripts/`) |
| Tests | `npx vitest run lib/replay-guard.test.ts` | pass |
| All tests | `npm test` | 513 + 3 = 516 pass |
| Lint | `npx eslint lib/replay-guard.ts lib/replay-guard.test.ts scripts/replay-tiers.ts` | no NEW problems vs baseline |

## Scope

In scope: `lib/replay-guard.ts` (create), `lib/replay-guard.test.ts` (create),
`scripts/replay-tiers.ts`, `README.md` (the one bullet).
Out of scope: `lib/db.ts`, `scripts/audit.ts`, every other file. Do NOT run
the replay; it writes to the production database.

## Git workflow

- Branch: `advisor/017-replay-guard`
- One commit: `Stop the replay writing into sessions that have live rows`
  with the repository's current co-author trailer.

## Steps

### Step 0: Lint baseline

Run the lint command on `scripts/replay-tiers.ts` before editing. Record it.

### Step 1: The pure guard

Create `lib/replay-guard.ts`:

```ts
/**
 * Which sessions the replay may write.
 *
 * A session with ANY live row is off limits, not just its live rows. The
 * replay's upsert already refuses to overwrite a live row, but a ticker the
 * live snapshot lacks would be INSERTED as a replay row, and a session holding
 * both kinds reads as a replay to previousTiers(). That suppresses the next
 * alert and turns the digest's baseline into "not comparable". On 2026-09-24
 * one replay run did exactly this to six live sessions.
 *
 * Pure so the rule is testable; scripts/replay-tiers.ts applies it.
 */
export function replayMayWrite(session: string, liveSessions: ReadonlySet<string>): boolean {
  return !liveSessions.has(session);
}
```

Create `lib/replay-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { replayMayWrite } from "./replay-guard";

describe("replayMayWrite", () => {
  const live = new Set(["2026-09-23", "2026-09-24"]);

  /**
   * The bug: the replay inserted a row for a ticker the live snapshot lacked,
   * turning a live session into a mixed one. A live session must be skipped
   * entirely, not merely protected row by row.
   */
  it("refuses a session that has live rows", () => {
    expect(replayMayWrite("2026-09-23", live)).toBe(false);
  });

  it("allows a session with no live rows", () => {
    expect(replayMayWrite("2026-09-22", live)).toBe(true);
  });

  it("allows everything when there is no live history yet", () => {
    expect(replayMayWrite("2026-09-23", new Set())).toBe(true);
  });
});
```

**Verify**: `npx vitest run lib/replay-guard.test.ts` → 3 pass.

### Step 2: Mutation check (mandatory)

Temporarily make `replayMayWrite` return `true`. Run the test file →
"refuses a session that has live rows" MUST fail. Restore and re-run → 3 pass.
Record the failure message.

### Step 3: Apply it in the replay

In `scripts/replay-tiers.ts`:

1. Add `import { replayMayWrite } from "../lib/replay-guard";` after the
   `../lib/hysteresis` import.
2. Directly before `const order = [...replayable];`, add:

```ts
  // Sessions the nightly refresh wrote live. The replay still COMPUTES them,
  // because hysteresis and the cap's incumbency carry forward from one
  // session to the next, but it never writes into them. See lib/replay-guard.ts.
  const liveSessions = new Set(
    (
      (await sql`
        SELECT DISTINCT session::text AS session FROM tier_history WHERE source = 'live'
      `) as { session: string }[]
    ).map((r) => r.session),
  );
  console.log(`live sessions (computed, never written): ${liveSessions.size}\n`);
```

3. Next to `let written = 0;` add `let skipped = 0;`.
4. Wrap the whole write block (the `for (let i = 0; i < rows.length; i += 500) { ... }`
   loop, lines 239-260, including its two comment lines above it) in:

```ts
    if (!replayMayWrite(session, liveSessions)) {
      skipped += 1;
    } else {
      // ...the existing write loop, unchanged except for step 5...
    }
```

   The chain updates (`prior`, `incumbents`) stay ABOVE this block, exactly
   where they are, so they still run for live sessions. `done += 1` and the
   progress log stay BELOW it, unchanged.
5. In the INSERT, add a second guard for a refresh that writes a session live
   while the replay is running. Change
   `) AS t(ticker, rs_pct, vs_ma, tier, momentum_tier, weight)` to:

```ts
        ) AS t(ticker, rs_pct, vs_ma, tier, momentum_tier, weight)
        WHERE NOT EXISTS (
          SELECT 1 FROM tier_history live
          WHERE live.session = ${session}::date AND live.source = 'live'
        )
```

   Keep the `ON CONFLICT ... WHERE tier_history.source <> 'live'` clause after it.
6. Change the final summary to include the skips:

```ts
  console.log(
    `\ndone: ${done} sessions, ${written.toLocaleString()} rows, ` +
      `${skipped} live sessions skipped, ` +
      `${((Date.now() - started) / 60_000).toFixed(1)} min`,
  );
```

7. Replace the header paragraph that begins `NEVER OVERWRITTEN: rows the nightly refresh wrote live.`
   (lines 23-29) with:

```
 * NEVER TOUCHED: sessions the nightly refresh wrote live. Those are the only
 * genuinely out-of-sample evidence this project will ever have -- one honest
 * observation per session, accumulating forward -- and a reconstruction of the
 * same day is strictly worse information. A live session is skipped WHOLE, not
 * just row by row: the replay's theme set differs slightly from the live one,
 * and inserting even one extra replay row turns the session into a mixed one
 * that previousTiers() reads as a replay. See lib/replay-guard.ts. The run is
 * therefore safe to repeat as often as you like.
```

**Verify**: `npm run typecheck` → 0. `npx eslint scripts/replay-tiers.ts` → no
new problems vs Step 0. `grep -c "replayMayWrite" scripts/replay-tiers.ts` → 2.
`grep -c "WHERE NOT EXISTS" scripts/replay-tiers.ts` → 1.

### Step 4: README

Replace the bullet in `README.md` that begins
`- **The replay will not overwrite a live row**, but it can add to a live`
(7 lines, ending `replay is safe for gaps, but check the audit afterwards.`) with:

```
- **The replay never writes into a live session.** Live rows are the only
  genuinely out-of-sample evidence this project will ever have, so any session
  holding a live row is skipped whole. Skipping row by row is not enough: the
  replay's theme set differs slightly from the live one, and one extra replay
  row turns a live session into a mixed one, which suppresses the next alert.
  `npm run replay` is therefore safe to re-run, and `npm run audit` still
  checks that no session mixes the two.
```

### Step 5: Gates

`npm run typecheck` → 0. `npm test` → 516 pass. Lint → nothing new.
`git status --porcelain` → only the four in-scope files.

## Test plan

The skip rule is unit-tested with a mutation check. The SQL guard and the
wiring in the script have no harness (the script is not covered by vitest and
writes to production); they are verified by typecheck and grep here, and by
the reviewer's end-to-end check below.

## Done criteria

- [ ] 3 new tests pass; mutation check performed and reported
- [ ] `replayMayWrite` imported and called in `scripts/replay-tiers.ts`; `WHERE NOT EXISTS` present
- [ ] The chain updates (`prior =`, `incumbents =`) are NOT inside the skip branch
- [ ] `npm run typecheck` 0; `npm test` 516 pass
- [ ] Only the four in-scope files changed

## STOP conditions

- Setup or drift check fails.
- The chain updates cannot stay outside the skip branch without restructuring the loop.
- Typecheck fails on the `sql` template with the `WHERE NOT EXISTS` clause.

## Maintenance notes

- **End-to-end check after merge (maintainer runs; it writes to production):**
  record per-session live row counts, run `npm run replay`, and confirm (a)
  the summary reports the live sessions skipped, (b) 0 mixed sessions, (c)
  every live session's row count is unchanged.
- If the replay ever needs to rebuild a live window deliberately (as on
  2026-09-24), delete that window's live rows first; the guard then lets the
  replay fill it.
