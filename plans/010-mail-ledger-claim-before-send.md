# Plan 010: The mail ledger claims a key atomically before sending, and releases it on failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Plans 008 and 009 must be merged first (the digest route must already call
> `digestKey(phoenixToday(), screen.asOf)`).
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/db.ts db/schema.sql app/api/digest/route.ts app/api/refresh/route.ts`
> Both routes will have changed (plans 007-009). Re-locate excerpts by
> content. If `lib/db.ts` lines 797-823 differ from the excerpt below, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED — changes delivery semantics; a stranded claim means a missed email
- **Depends on**: plans/009-digest-key-phoenix-day-and-session.md
- **Category**: bug
- **Planned at**: commit `7d56c3f`, 2026-09-23; re-verified against `2265b27` (post-009) 2026-09-23, excerpts unchanged

## Why this matters

Both schedulers (Vercel cron and GitHub Actions) call `/api/digest` at
`0 13 * * 1-5`. Vercel fires anywhere in the 13:00 hour; GitHub fires 24
minutes to nine hours late. When they overlap, each does
`alreadySent(...)` → sees nothing → `sendMail(...)` → `recordMailSend(...)`
(`app/api/digest/route.ts:133-143`). The check and the record are separated by
a network send of several seconds, so two callers inside that window both
deliver. The ledger from plan 005 stops *sequential* duplicates only.

The fix is the standard one: **claim first with an atomic insert, send, and
release the claim if the send fails**. The comment at `lib/db.ts:807-814`
argued against recording first because "a send that then failed would be
permanently marked done". Releasing on failure keeps that property without
the race. The one remaining hole — the process dying between claim and
release — is narrow (`sendMail` has 10 s/10 s/30 s timeouts,
`lib/mailer.ts:133-135`) and is what plan 013's `forget` command is for.

## Current state

- `lib/db.ts:797-823`:

```ts
export async function alreadySent(kind: string, dedupeKey: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  await ensureMailLedger();
  const sql = client();
  const rows = (await sql`
    SELECT 1 FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${dedupeKey} LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}
...
export async function recordMailSend(kind: string, dedupeKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await ensureMailLedger();
  const sql = client();
  await sql`
    INSERT INTO mail_sends (kind, dedupe_key) VALUES (${kind}, ${dedupeKey})
    ON CONFLICT (kind, dedupe_key) DO NOTHING
  `;
}
```

- Callers (only these two files use the ledger):
  - `app/api/digest/route.ts` — `alreadySent("digest", key)` then
    `if (result.sent) await recordMailSend("digest", key);`
  - `app/api/refresh/route.ts:234-247` — `alreadySent("alert", key)` then
    `if (result.sent) await recordMailSend("alert", key);`
- `db/schema.sql:187-214` documents the table; lines 207-208 say
  "Rows are written only AFTER a successful send". That sentence becomes
  false and must be rewritten.
- `sendMail` never throws; it returns `{ sent: false, reason, error }`
  (`lib/mailer.ts:115-155`).
- Convention: `lib/db.ts` functions return early with a safe default when
  `DATABASE_URL` is unset (see `alreadySent`). Keep that: without a database,
  `claimMailSend` returns `true` (send; a duplicate beats a silent morning —
  the same reasoning as the existing comment at `lib/db.ts:792-796`).

## Commands you will need

| Purpose   | Command             | Expected |
|-----------|---------------------|----------|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests     | `npm test`          | pass (count unchanged from after plan 009: 500) |
| Lint      | `npx eslint lib/db.ts app/api/digest/route.ts app/api/refresh/route.ts` | no new problems |

## Scope

**In scope**:
- `lib/db.ts` (mail ledger section only, lines ~770-823)
- `db/schema.sql` (the `mail_sends` comment block only)
- `app/api/digest/route.ts`
- `app/api/refresh/route.ts`

**Out of scope**:
- `lib/mail-ledger.ts` — key choice is settled.
- `lib/mailer.ts`.
- Any other function in `lib/db.ts`.

## Git workflow

- Branch: `advisor/010-ledger-claim`
- One commit: `Claim the mail ledger key before sending so two schedulers cannot both deliver`

## Steps

### Step 1: Replace the two ledger functions

In `lib/db.ts`, delete `alreadySent` and `recordMailSend` (and their doc
comments) and add in their place:

```ts
/**
 * Try to claim a message key. True means this caller owns delivery.
 *
 * The claim is one atomic INSERT, so two schedulers arriving inside the same
 * few seconds cannot both win: the second sees a conflict and skips. The
 * earlier check-then-record design left the whole SMTP round trip as a
 * window in which both callers had checked and neither had recorded.
 *
 * Returns true when there is no database: without one we cannot know, and a
 * possible duplicate is a far smaller harm than suppressing the only email
 * that would have told you the pipeline is alive.
 */
export async function claimMailSend(kind: string, dedupeKey: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return true;
  await ensureMailLedger();
  const sql = client();
  const rows = (await sql`
    INSERT INTO mail_sends (kind, dedupe_key) VALUES (${kind}, ${dedupeKey})
    ON CONFLICT (kind, dedupe_key) DO NOTHING
    RETURNING 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Give a claim back after a failed send, so a later caller can retry.
 *
 * This is what keeps claim-first from being at-most-once delivery: a send
 * that fails releases its key and the next scheduler sends normally. The
 * only way a key stays claimed without an email is the process dying
 * between claim and release; delete that row by hand (a `mail-ledger forget`
 * script is planned for exactly this).
 */
export async function releaseMailSend(kind: string, dedupeKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const sql = client();
  await sql`DELETE FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${dedupeKey}`;
}
```

**Verify**: `npm run typecheck` → errors only in the two route files
(missing exports). Anything else: STOP.

### Step 2: Rewire the digest route

Replace the `alreadySent` / `recordMailSend` block with:

```ts
  const key = digestKey(phoenixToday(), screen.asOf);
  if (!(await claimMailSend("digest", key))) {
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "digest already sent today for this session",
      subject: digest.subject,
    });
  }

  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  // A failed send hands the key back, so the other scheduler can still
  // deliver this morning instead of finding the day already marked done.
  if (!result.sent) await releaseMailSend("digest", key);
```

Update the import from `@/lib/db` to `previousTiers, claimMailSend, releaseMailSend`.

### Step 3: Rewire the refresh route

Replace the alert block (`if (await alreadySent("alert", key)) { … } else { … }`) with:

```ts
        const key = alertKey(screen.asOf);
        if (!(await claimMailSend("alert", key))) {
          alert = {
            sent: false,
            reason: "alert already sent for this session",
            changes: changes.length,
          };
        } else {
          const { subject, text, html } = formatAlert(changes, screen.asOf);
          // Deliberately still a 200 on failure, unlike /api/digest: this route
          // has already stored bars and snapshotted tiers. A failed email must
          // not mark that work as failed. The reason field says what went
          // wrong without changing the status.
          const result = await sendMail(mail, subject, text, html);
          if (!result.sent) await releaseMailSend("alert", key);
          alert = { ...result, changes: changes.length, subject };
        }
```

Update the import list from `@/lib/db`: remove `alreadySent, recordMailSend`,
add `claimMailSend, releaseMailSend`.

**Verify**: `npm run typecheck` → 0.
`grep -rn "alreadySent\|recordMailSend" app lib scripts` → no matches.

### Step 4: Fix the schema comment

In `db/schema.sql`, replace the two lines
`-- Rows are written only AFTER a successful send: recording first would be`
`-- at-most-once delivery, permanently marking a failed send as done.` with:

```sql
-- A row is CLAIMED before the send (one atomic INSERT, so two schedulers
-- inside the same seconds cannot both win) and DELETED again if the send
-- fails, so a failed delivery never marks the day as done. See
-- claimMailSend / releaseMailSend in lib/db.ts.
```

**Verify**: `grep -n "CLAIMED before the send" db/schema.sql` → 1 match.

### Step 5: Gates

`npm run typecheck` → 0. `npm test` → 500 pass.
`npx eslint lib/db.ts app/api/digest/route.ts app/api/refresh/route.ts` → no new problems.

## Test plan

The ledger functions need a database and the routes have no harness, so this
plan's verification is typecheck + grep. State that plainly in your report.
Do **not** write a test that mocks `neon` — it would test the mock. The pure
key logic is already covered by `lib/mail-ledger.test.ts`.

## Done criteria

- [ ] `grep -rn "alreadySent\|recordMailSend" app lib scripts db` → none
- [ ] `grep -c "claimMailSend"` on each route → 2 (import + call); corrected at dispatch, the original "1 each" miscounted the import
- [ ] `grep -c "releaseMailSend"` on each route → 2 (import + call); corrected at dispatch
- [ ] `npm run typecheck` 0; `npm test` 0
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `sendMail` has been changed to throw instead of returning `{ sent: false }`
  (the release would then be skipped by an exception).
- `@neondatabase/serverless` tagged-template queries no longer return rows
  for `RETURNING` (they do at `^1.1.0`; check `node_modules/@neondatabase/serverless/README.md` if unsure).
- Plan 013 has already moved the digest send into `lib/digest-service.ts`
  — then apply Steps 2's logic there instead and report the deviation.

## Maintenance notes

- Reviewer: the `if (!result.sent) await releaseMailSend(...)` must be the
  line immediately after `sendMail`, with nothing that can throw between.
- If a future change makes the refresh route return non-200 on a failed
  alert, the release must still run first.
- Semantics of `sent_at` in `mail_sends` are now "claimed at"; the column
  name is kept to avoid a migration on a table created with
  `CREATE TABLE IF NOT EXISTS`.
