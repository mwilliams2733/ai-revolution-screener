# Plan 005: Add a mail send ledger so two schedulers cannot deliver the same digest or alert twice

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 230e96f..HEAD -- lib/db.ts app/api/digest/route.ts app/api/refresh/route.ts db/schema.sql`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-mail-failure-reason.md` — **DONE and merged** as commit `230e96f`. Its record-only-on-success rule is load-bearing here — see Step 4.
- **Category**: bug
- **Planned at**: commit `230e96f`, 2026-09-16 (rebaselined after plans 003 and 004 merged; all line numbers below are from `230e96f`)

## Why this matters

Two independent schedulers call the same two endpoints on the same schedule, on
purpose. `vercel.json` declares crons at `0 12` and `0 13`; the GitHub Actions
workflow declares the identical two. The workflow's header explains the
redundancy — a Vercel cron is registered by a *deployment*, so a blocked deploy
silently leaves the old schedule in place, and GitHub Actions runs against
whatever is already deployed.

That reasoning is sound. The claim attached to it is not:

> "Both are declared. Whichever fires, the routes are idempotent … the digest
> only reads and mails."

That is idempotency of **writes**. Delivery is not idempotent, and delivery is
where the duplication lands:

- **The digest** sends unconditionally on every invocation. Two successful
  schedulers on the same weekday deliver two identical emails.
- **The alert** is worse. Its baseline query selects `session < today`, so a
  second refresh on the same day still reads *yesterday* as the baseline,
  recomputes the identical non-empty change set, and fires again. Because the
  GitHub workflow is documented as running up to **nine hours late**, the
  duplicate "3 down" alert can arrive mid-afternoon describing the morning's
  moves as though they were new.

This is the same class of failure as the two junk alerts that motivated the
replay-baseline guard: a reader who receives a second copy learns to distrust
the first, and an alert nobody trusts is worse than no alert.

After this plan, each email is keyed and recorded, a repeat invocation reports
`{sent: false, reason: "already sent…"}` instead of delivering, and the existing
workflow grep surfaces it as a normal skip.

## Current state

**Both schedules are genuinely duplicated.** `vercel.json:3-12`:

```json
  "crons": [
    { "path": "/api/refresh", "schedule": "0 12 * * 1-5" },
    { "path": "/api/digest",  "schedule": "0 13 * * 1-5" }
  ]
```

`.github/workflows/schedule.yml:34-36`:

```yaml
  schedule:
    - cron: "0 12 * * 1-5"   # 05:00 Phoenix - refresh
    - cron: "0 13 * * 1-5"   # 06:00 Phoenix - digest email
```

**The digest sends unconditionally** — `app/api/digest/route.ts:126`:

```ts
  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
```

There is no check of any kind before it.

**The alert's baseline is yesterday, not "last send"** —
`app/api/refresh/route.ts:198-237` (the `else` branch you edit is at `:229-237`):

```ts
    const previous = await previousTiers(screen.asOf);
    const snapshotted = await upsertTierHistory(screen.asOf, tierRows);

    const changes = diffTiers(
      previous?.tiers ?? new Map(),
      screen.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, rsPct: r.rsPct, vsMa: r.vsMa })),
    );
    ...
      const send = shouldSend(changes, ctx);
      if (!send) {
        alert = { sent: false, reason: suppressionReason(changes, ctx), ... };
      } else {
        const { subject, text, html } = formatAlert(changes, screen.asOf);
        // Deliberately still a 200 on failure, unlike /api/digest: this route
        // has already stored bars and snapshotted tiers. A failed email must
        // not mark that work as failed. The reason field now says what went
        // wrong without changing the status.
        const result = await sendMail(mail, subject, text, html);
        alert = { ...result, changes: changes.length, subject };
      }
```

That four-line comment came from plan 004. **Preserve it verbatim** when you
rewrite this block in Step 4.

`previousTiers` selects the newest session **strictly before** `screen.asOf`, so
running it twice on the same `asOf` yields the same `changes` both times.

**There is no send/dedupe table.** `db/schema.sql` declares `tickers`,
`daily_bars`, `sessions` (+ the `stored_sessions` view), `refresh_runs`,
`tier_history` and `split_refetch`. Nothing records an email.

**The DDL convention for tables added after the initial schema** — they are
created inline by the consuming code with `CREATE TABLE IF NOT EXISTS`, and also
documented in `db/schema.sql`. See `scripts/refetch-splits.ts:54`,
`scripts/splits.ts:40`, `scripts/health.ts:162`. Example:

```ts
    CREATE TABLE IF NOT EXISTS split_refetch (
      ticker         TEXT NOT NULL,
      execution_date DATE NOT NULL,
      done_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, execution_date)
    );
```

`db/schema.sql`'s own header states the invariant: "Safe to re-run; every
statement is IF NOT EXISTS."

**Database access** — `lib/db.ts:18-24`:

```ts
function client() {
  if (typeof window !== "undefined") {
    throw new Error("lib/db.ts is server-only.");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}
```

Queries are tagged templates (`` sql`SELECT …` ``) with parameterised
interpolation. **Never build SQL by string concatenation.**

`lib/dates.ts:14-18` supplies the UTC date helper you will need:

```ts
/** ISO yyyy-mm-dd for `n` days before now, in UTC. */
export function isoDaysAgo(n: number): string {
```

Repo conventions that apply here:

- **A ledger, never a watermark.** `db/schema.sql`'s `split_refetch` comment
  states the rule: "A ledger rather than a watermark on purpose: a high-water
  date assumes every split before it was handled, so one failed repair in the
  middle is skipped forever." Ask whether *this specific unit* was done — never
  how far the work got.
- **Every non-send path returns a machine-readable `reason`** (see plan 004).
- Dates are UTC throughout (`lib/dates.ts:9-11`).

## Commands you will need

| Purpose    | Command                                  | Expected on success |
|------------|------------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                      | exit 0, no errors   |
| Tests      | `npm test`                               | all pass (478 on `230e96f`) |
| One file   | `npx vitest run lib/mail-ledger.test.ts` | all pass            |
| Lint       | `npm run lint`                           | 6 pre-existing problems, none in in-scope files |

## Scope

**In scope** (the only files you should modify or create):

- `lib/mail-ledger.ts` (**create**) — pure key derivation
- `lib/mail-ledger.test.ts` (**create**)
- `lib/db.ts` — ledger table + two functions
- `app/api/digest/route.ts` — check before send, record after
- `app/api/refresh/route.ts` — same, on the alert path
- `db/schema.sql` — document the new table

**Out of scope** (do NOT touch, even though they look related):

- `vercel.json` and `.github/workflows/schedule.yml` — the duplicate scheduling
  is **deliberate redundancy** and must stay. This plan makes it safe, it does
  not remove it. Deleting either scheduler defeats the purpose.
- `lib/alerts.ts` — `shouldSend` / `suppressionReason` stay exactly as they are.
  The ledger is a second, independent gate layered *after* them, not a
  replacement. Do not add a ledger concept to `SendContext`.
- `previousTiers` in `lib/db.ts` — its `session < asOf` semantics are correct
  for diffing. Do not change it to dedupe.
- `lib/mailer.ts` — `sendMail` knows nothing about the ledger; the routes own
  the check. (Plan 004's `SEND_FAILED` / `sendFailure` are unchanged.)
- Any retry, backoff, or queue.

## Git workflow

- Branch: `advisor/005-mail-send-ledger`
- Commit per logical unit is fine here (ledger module, db layer, routes), or one
  commit; imperative subject with a prose body, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `lib/mail-ledger.ts` — the dedupe keys, pure

The key choice is the whole design, and the two emails need **different** keys.
Read the docstrings carefully; they encode reasoning that is easy to get wrong.

```ts
/**
 * Dedupe keys for the two outbound emails.
 *
 * Pure and separate from lib/db.ts so the KEY CHOICE -- the part that is easy
 * to get wrong and impossible to notice once wrong -- is testable without a
 * database.
 */

/** What kind of message a ledger row records. */
export type MailKind = "digest" | "alert";

/**
 * The digest is keyed by the DAY IT IS SENT, not by the session it describes.
 *
 * This looks wrong and is not. The digest is a heartbeat: it must arrive every
 * weekday even when the data has not moved, because "4 sessions behind" is
 * precisely the message that tells you the refresh died. Keying on asOf would
 * mean a stalled pipeline -- the one case the digest exists for -- sends ONE
 * email and then goes silent, which is the exact failure it was built to
 * prevent.
 *
 * `today` is a UTC yyyy-mm-dd string, from isoDaysAgo(0).
 */
export function digestKey(today: string): string {
  return `digest:${today}`;
}

/**
 * The alert is keyed by the SESSION it reports on.
 *
 * The opposite choice from the digest, for the opposite reason. The alert is
 * exception-driven: it fires because tier changes were computed by diffing
 * against the previous session. Re-running the refresh on the same asOf
 * recomputes an identical diff -- previousTiers selects `session < asOf`, so
 * the baseline does not move -- and re-firing would report the morning's moves
 * again in the afternoon as though they were new.
 *
 * One alert per session is therefore the correct unit. A genuinely new session
 * carries a new asOf and sends normally.
 */
export function alertKey(asOf: string): string {
  return `alert:${asOf}`;
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the ledger table and access functions to `lib/db.ts`

Append a new section at the end of `lib/db.ts`, matching the file's existing
section-comment style (`// ---…---` banners).

```ts
// ---------------------------------------------------------------------------
// Mail send ledger
// ---------------------------------------------------------------------------

/**
 * Create the ledger if absent. Cheap and idempotent, matching how splits,
 * split_refetch and company_health are created by their consumers.
 */
async function ensureMailLedger(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS mail_sends (
      kind       TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, dedupe_key)
    )
  `;
}

/**
 * Has this exact message already gone out?
 *
 * Returns false when there is no database: without one we cannot know, and a
 * possible duplicate is a far smaller harm than suppressing the only email
 * that would have told you the pipeline is alive.
 */
export async function alreadySent(kind: string, dedupeKey: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  await ensureMailLedger();
  const sql = client();
  const rows = (await sql`
    SELECT 1 FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${dedupeKey} LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Record a message that was actually delivered.
 *
 * Called only AFTER a successful send, never before. Recording first would be
 * at-most-once delivery: a send that then failed would be permanently marked
 * done and the email would never arrive. A duplicate is recoverable; a
 * silently missing digest is not.
 */
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

Both must use tagged-template parameters, never string concatenation.

**Verify**: `npm run typecheck` → exit 0, and
`grep -n "mail_sends" lib/db.ts` → three matches (create, select, insert).

### Step 3: Gate the digest

In `app/api/digest/route.ts`, adjust the imports. Line 17 already reads
`import { previousTiers } from "@/lib/db";` — **merge into it**, do not add a
second import from the same module. Then add two new import lines:

```ts
import { previousTiers, alreadySent, recordMailSend } from "@/lib/db";
import { digestKey } from "@/lib/mail-ledger";
import { isoDaysAgo } from "@/lib/dates";
```

Then, **after** the `mail.digestEnabled` guard from plan 003 and **before** the
`sendMail` call:

```ts
  // Both vercel.json and the GitHub workflow call this route on the same
  // schedule, deliberately -- either scheduler alone can silently stop. The
  // routes are idempotent in what they WRITE, but delivery is not, so the
  // second caller must skip rather than send a second identical email.
  const key = digestKey(isoDaysAgo(0));
  if (await alreadySent("digest", key)) {
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "digest already sent today",
      subject: digest.subject,
    });
  }

  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  if (result.sent) await recordMailSend("digest", key);
```

Keep plan 004's status-code return immediately after. The final return is
unchanged from plan 004:

```ts
  return NextResponse.json(
    { ok: result.sent, ...result, subject: digest.subject, asOf: screen.asOf },
    { status: result.sent ? 200 : 500 },
  );
```

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "recordMailSend" app/api/digest/route.ts` → one match, guarded by
  `if (result.sent)`

### Step 4: Gate the alert

In `app/api/refresh/route.ts`, add the same imports: merge `alreadySent` and
`recordMailSend` into the existing multi-line `@/lib/db` import block that starts
at line 16, and add one new line importing `alertKey` from `@/lib/mail-ledger`.
`isoDaysAgo` is already imported here (line 35) but this route does not need it —
the alert keys on `screen.asOf`, not on today.

Replace the `else` branch at `:229-237`:

```ts
      } else {
        const key = alertKey(screen.asOf);
        if (await alreadySent("alert", key)) {
          alert = {
            sent: false,
            reason: "alert already sent for this session",
            changes: changes.length,
          };
        } else {
          const { subject, text, html } = formatAlert(changes, screen.asOf);
          // Deliberately still a 200 on failure, unlike /api/digest: this route
          // has already stored bars and snapshotted tiers. A failed email must
          // not mark that work as failed. The reason field now says what went
          // wrong without changing the status.
          const result = await sendMail(mail, subject, text, html);
          if (result.sent) await recordMailSend("alert", key);
          alert = { ...result, changes: changes.length, subject };
        }
      }
```

The `if (result.sent)` guard is **mandatory** and is the reason this plan
depends on 004: recording before or regardless of success would make a failed
send permanent.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "recordMailSend" app/api/refresh/route.ts` → one match, guarded by
  `if (result.sent)`
- `grep -c "if (result.sent) await recordMailSend" app/api/digest/route.ts app/api/refresh/route.ts`
  → `1` in each

### Step 5: Document the table in `db/schema.sql`

Append at the end of the file, matching the surrounding comment voice (the
`split_refetch` block is the closest model — it explains the *why*, not the
*what*):

```sql
-- ---------------------------------------------------------------------------

-- Emails actually delivered, so a second caller skips instead of re-sending.
--
-- vercel.json and .github/workflows/schedule.yml declare the SAME two
-- schedules on purpose: a Vercel cron is registered by a deployment, so a
-- blocked deploy silently leaves the old schedule live, and GitHub Actions runs
-- against whatever is already deployed. That redundancy is wanted. What it
-- costs, without this table, is duplicate delivery -- the routes are idempotent
-- in what they WRITE, but sending an email twice is not a write.
--
-- The two kinds key differently, and the asymmetry is the point:
--   digest:<utc-date>  -- one per DAY. The digest is a heartbeat and must
--                         arrive even when the data has not moved; keying it
--                         on the session would make a stalled pipeline send
--                         once and then go quiet, which is the exact failure
--                         the digest exists to reveal.
--   alert:<asOf>       -- one per SESSION. The alert diffs against the previous
--                         session, so re-running on the same asOf recomputes an
--                         identical change set and would report the morning's
--                         moves again in the afternoon.
--
-- Rows are written only AFTER a successful send: recording first would be
-- at-most-once delivery, permanently marking a failed send as done.
CREATE TABLE IF NOT EXISTS mail_sends (
  kind       TEXT NOT NULL,              -- 'digest' | 'alert'
  dedupe_key TEXT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, dedupe_key)
);
```

**Verify**: `grep -c "mail_sends" db/schema.sql` → `1`.

### Step 6: Create `lib/mail-ledger.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { alertKey, digestKey } from "./mail-ledger";

describe("digestKey", () => {
  /**
   * The bug this guards: keying the digest on the SESSION would mean a stalled
   * pipeline sends one email and then goes silent -- the exact failure the
   * digest exists to make visible. It must key on the send day instead.
   */
  it("changes every day even when the session does not", () => {
    expect(digestKey("2026-09-14")).not.toBe(digestKey("2026-09-15"));
  });

  it("is stable within a day, so a second caller is suppressed", () => {
    expect(digestKey("2026-09-15")).toBe(digestKey("2026-09-15"));
  });

  it("is namespaced so it cannot collide with an alert key", () => {
    expect(digestKey("2026-09-15")).not.toBe(alertKey("2026-09-15"));
  });
});

describe("alertKey", () => {
  /**
   * The opposite rule. previousTiers selects `session < asOf`, so a second
   * refresh on the same asOf recomputes an IDENTICAL diff. Re-sending would
   * report the morning's moves again in the afternoon.
   */
  it("is stable for one session, so a repeat refresh is suppressed", () => {
    expect(alertKey("2026-09-15")).toBe(alertKey("2026-09-15"));
  });

  it("changes when a genuinely new session arrives", () => {
    expect(alertKey("2026-09-15")).not.toBe(alertKey("2026-09-16"));
  });
});
```

**Verify**: `npx vitest run lib/mail-ledger.test.ts` → 5 tests pass.

### Step 7: Prove the guards actually guard

Two mutations, run one at a time:

1. In `lib/mail-ledger.ts`, change `digestKey` to return `` `digest:${today}` ``
   → `` `digest:fixed` `` (a constant).
   **Verify**: `npx vitest run lib/mail-ledger.test.ts` → the "changes every day"
   test **FAILS**.
2. Restore. Then change `alertKey` to ignore its argument and return a constant.
   **Verify**: the "changes when a genuinely new session arrives" test **FAILS**.

Restore both. If either mutation leaves all tests passing, stop and report.

### Step 8: Verify the end-to-end skip by hand

The routes have no automated harness, so confirm the behaviour manually against
a local dev server **only if** `DATABASE_URL` and `CRON_SECRET` are available in
your environment. If they are not, **skip this step and say so in your report** —
do not fabricate a result, and do not point it at production.

```bash
npm run dev
# in another shell, twice:
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/digest
```

Expected: the first call reports `"sent":true`; the second reports
`"sent":false` with `"reason":"digest already sent today"`.

## Test plan

- New file `lib/mail-ledger.test.ts`, 5 tests covering the key-derivation
  contract: the digest key varies by day and is stable within one, the alert key
  is stable per session and varies across sessions, and the two namespaces
  cannot collide.
- Structural pattern: `lib/format.test.ts` — pure, no mocks, no setup.
- Mutation checks in Step 7 are mandatory.
- **Known coverage gap, state it plainly in your report**: the database
  functions (`alreadySent`, `recordMailSend`) and the route wiring are **not**
  covered, because `lib/db.ts` has no test harness and neither route handler is
  testable without one. What is proven automatically is the key choice; what is
  proven manually is Step 8, if runnable. Do not claim the dedupe itself is
  tested.
- Verification: `npm test` → 483 passing (478 + 5).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` reports **no NEW problems in the in-scope files**. It does
      NOT exit 0 and never did: at `230e96f` there are 6 pre-existing problems
      (1 error, 5 warnings) in `app/use-persisted-state.ts`,
      `app/leaders-table.tsx`, `lib/edgar.ts`, `lib/screen-service.ts` and
      `lib/solvency.test.ts`, all out of scope. Do not fix them.
- [ ] `npm test` exits 0 with 483 passing (478 + 5 new)
- [ ] `grep -n "mail_sends" db/schema.sql` returns one match
- [ ] `grep -n "mail_sends" lib/db.ts` returns three matches
- [ ] `grep -c "if (result.sent) await recordMailSend" app/api/digest/route.ts` returns `1`
- [ ] `grep -c "if (result.sent) await recordMailSend" app/api/refresh/route.ts` returns `1`
- [ ] `grep -rn "recordMailSend" app/ | grep -v "result.sent"` returns **no matches**
      (nothing records a send outside the success guard)
- [ ] `vercel.json` and `.github/workflows/schedule.yml` are **unmodified**
      (`git diff --stat 230e96f..HEAD -- vercel.json .github/` is empty)
- [ ] Step 7's two mutation checks were performed and failed as predicted
- [ ] Step 8 was either performed with both results as expected, or explicitly
      reported as skipped for lack of credentials
- [ ] Only the six in-scope files are modified/created (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Plan 004 has not landed — the `if (result.sent)` guard depends on its
  `SendResult` shape and its record-only-on-success rule. Check
  `grep -c "SEND_FAILED" lib/mailer.ts` first; it must return `2`. If it
  returns 0, your checkout is behind — see SETUP NOTE on the worktree base.
- You conclude the ledger row should be written **before** the send. It must
  not. If you believe otherwise, stop and report rather than inverting it.
- You are tempted to remove one of the two schedulers to "solve" the duplication.
  That redundancy is deliberate and documented; removing it is out of scope.
- `ensureMailLedger()` fails against the live database (a permissions error on
  `CREATE TABLE`). Report it — do not fall back to creating the table by hand in
  production without telling the operator.
- Adding the ledger check causes any existing test to fail.

## Maintenance notes

- **First-run behaviour**: the table is created on first call. The first digest
  after deploy therefore does a `CREATE TABLE IF NOT EXISTS` before sending.
  Confirm the first weekday run returns `sent: true` and the row exists.
- **The two keys must stay asymmetric.** A future reader will notice the digest
  keys on the day and the alert on the session, assume it is an inconsistency,
  and "fix" it. Both docstrings explain why; a reviewer should make sure they
  survive any refactor.
- **Race window, accepted deliberately**: the check and the send are not atomic,
  so two invocations landing within milliseconds could both send. Given the two
  schedulers fire minutes-to-hours apart in practice, and given that the
  alternative (insert-then-send) risks losing an email entirely, check-then-send
  is the right trade. If the window ever matters, the fix is an
  `INSERT … ON CONFLICT DO NOTHING RETURNING` claim-before-send **plus** a
  compensating delete on failure — meaningfully more complex, and not warranted
  today.
- **The table grows unboundedly** — roughly 2 rows per weekday, about 520 a
  year. That is negligible against the `daily_bars` sizing note in
  `db/schema.sql`, so no pruning job is included. Revisit only if the kinds
  multiply.
- **Enables a follow-up**: with delivery now recorded, a weekly line in the
  digest ("5 digests sent, 2 alerts, 1 send failed Wednesday") becomes nearly
  free and would close the loop the whole design is built around — today the
  digest can tell you the *pipeline* is alive but not whether *previous digests
  reached you*. Not in scope here.
