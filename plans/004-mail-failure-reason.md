# Plan 004: Give SMTP failures a machine-readable `reason` and make a failed digest fail loudly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat aa21e08..HEAD -- lib/mailer.ts app/api/digest/route.ts app/api/refresh/route.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/003-separate-digest-enable-flag.md` — **DONE and merged** as commit `aa21e08`. It created `lib/mailer.test.ts` (6 tests), which this plan extends.
- **Category**: bug
- **Planned at**: commit `aa21e08`, 2026-09-15 (rebaselined after plan 003 merged; excerpts and line numbers below are from `aa21e08`, not the original `4fd256c`)

## Why this matters

Every **deliberate** suppression path in this app returns a `reason` string:
`"no mail config"`, `"ALERTS_ENABLED is not true"`, `"no tier changes"`,
`"baseline is a replayed session…"`. The GitHub Actions workflow depends on
that shape — it greps the response for `"sent":false`, then extracts
`"reason":"…"` and surfaces it as an annotation.

The one path that means *the mail server actually rejected us* is the one path
with **no `reason` field**. `sendMail` returns `{sent, recipients, error}` on a
throw, so a genuine delivery failure is annotated as
`::warning::No email sent - "reason":"unstated"` — a non-failing warning with no
diagnosis. On the Vercel Cron path there is no grep at all: the route answers
200 and the failure is completely silent.

So the pipeline is **more informative when it decides not to send than when it
tries and fails.**

A second, compounding problem is in scope here because it makes the first
guarantee void: the SMTP transport has **no timeouts**. Nodemailer defaults to a
10-minute socket timeout, well past the route's `maxDuration = 300`. A hung
Gmail socket therefore kills the function before `sendMail`'s `catch` can run —
no JSON is emitted at all, so no `reason` exists to read. Adding the `reason`
field without bounding the socket would deliver a contract that silently does
not hold.

After this plan: an SMTP failure carries `reason: "smtp send failed"`, the
digest route answers **500** so both GitHub Actions and Vercel's own cron log
record a failure, and a stalled connection fails in seconds rather than
outliving the function.

## Current state

**`lib/mailer.ts:62-101`** — the result type and the untimed transport:

```ts
export interface SendResult {
  readonly sent: boolean;
  readonly recipients: number;
  readonly error?: string;
}

/** Send one message. Never throws: a failed alert must not fail the refresh. */
export async function sendMail(
  cfg: MailConfig,
  subject: string,
  text: string,
  html: string,
): Promise<SendResult> {
  try {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
    });

    await transport.sendMail({
      from: `AI Revolution Screener <${cfg.user}>`,
      to: cfg.to.join(", "),
      subject,
      text,
      html,
    });

    return { sent: true, recipients: cfg.to.length };
  } catch (e) {
    // The nightly job's real work is storing bars. Losing an email is an
    // annoyance; losing the refresh because an email failed is a data gap.
    return {
      sent: false,
      recipients: cfg.to.length,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
```

Note there is **no `reason`** in either return.

**`app/api/digest/route.ts:126-127`** — the result is spread straight into a 200:

```ts
  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  return NextResponse.json({ ok: true, ...result, subject: digest.subject, asOf: screen.asOf });
```

**`app/api/refresh/route.ts:229-233`** (the `sendMail` call is at `:231`) — same spread on the alert path:

```ts
      } else {
        const { subject, text, html } = formatAlert(changes, screen.asOf);
        const result = await sendMail(mail, subject, text, html);
        alert = { ...result, changes: changes.length, subject };
      }
```

**`.github/workflows/schedule.yml:96-104`** — the consumer of the contract:

```yaml
          if [ "$code" != "200" ]; then
            echo "::error::${path} returned $code"
            exit 1
          fi

          if grep -q '"sent":false' response.json; then
            reason=$(grep -o '"reason":"[^"]*"' response.json || echo '"reason":"unstated"')
            echo "::warning::No email sent - ${reason}"
          fi
```

Note the ordering: a non-200 **fails the job** before the grep runs. That is why
Step 3 returns 500 for a failed digest send — it upgrades a silent warning into
a red run.

Both routes declare `export const maxDuration = 300;`
(`app/api/digest/route.ts:41`, `app/api/refresh/route.ts:39`).

Repo conventions that apply here:

- **Every non-send path reports a machine-readable `reason`.** See
  `lib/alerts.ts:116-127` (`suppressionReason`) for the canonical list of strings.
- **`sendMail` must never throw.** Its docstring and the comment in its `catch`
  both state why: "losing the refresh because an email failed is a data gap."
  That property is load-bearing for `/api/refresh` and must survive this plan.
- Tests are vitest, pure, colocated. Plan 003 created `lib/mailer.test.ts`;
  extend it rather than creating a second file.

## Commands you will need

| Purpose    | Command                             | Expected on success |
|------------|-------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                 | exit 0, no errors   |
| Tests      | `npm test`                          | all pass (475 on `aa21e08`) |
| One file   | `npx vitest run lib/mailer.test.ts` | all pass            |
| Lint       | `npm run lint`                      | 1 pre-existing error + 5 warnings, none in in-scope files |

## Scope

**In scope** (the only files you should modify):

- `lib/mailer.ts`
- `app/api/digest/route.ts`
- `app/api/refresh/route.ts` (one-line comment only — see Step 4)
- `lib/mailer.test.ts` (extend; created by plan 003)

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/schedule.yml` — its existing grep already handles this
  correctly once the field exists. Do not edit the workflow.
- `lib/alerts.ts` / `suppressionReason` — the deliberate-suppression reasons are
  correct and their exact strings are asserted in `lib/alerts.test.ts`.
- `lib/digest.ts` — no email content changes.
- **Moving `finishRun` into a `finally`** in `app/api/refresh/route.ts`. A hung
  send currently leaves `refresh_runs.finished_at` null, which renders as
  "running" forever on the masthead. That is a real adjacent finding, but it
  changes the route's control flow and is deliberately deferred.
- Retry logic, dead-letter queues, or a second notification channel. Out of scope.

## Git workflow

- Branch: `advisor/004-mail-failure-reason`
- One commit; imperative subject with a prose body, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `reason` to `SendResult` and a pure failure shaper

In `lib/mailer.ts`, extend the type and add an exported helper. The helper
exists so the failure shape is **testable without a mail server** — `sendMail`
itself cannot be unit-tested here.

```ts
/** The reason string a genuine delivery failure reports. */
export const SEND_FAILED = "smtp send failed";

export interface SendResult {
  readonly sent: boolean;
  readonly recipients: number;
  /**
   * Machine-readable cause, present on every non-send.
   *
   * The GitHub workflow greps for this field; without it a real SMTP rejection
   * degraded to `"reason":"unstated"` while every DELIBERATE suppression
   * reported itself properly. The failure path must be at least as informative
   * as the success-but-skipped path.
   */
  readonly reason?: string;
  readonly error?: string;
}

/** Shape a thrown send into a reportable result. Pure, so it can be tested. */
export function sendFailure(e: unknown, recipients: number): SendResult {
  return {
    sent: false,
    recipients,
    reason: SEND_FAILED,
    error: e instanceof Error ? e.message : String(e),
  };
}
```

Then use it in `sendMail`'s `catch`, replacing the inline object literal:

```ts
  } catch (e) {
    // The nightly job's real work is storing bars. Losing an email is an
    // annoyance; losing the refresh because an email failed is a data gap.
    return sendFailure(e, cfg.to.length);
  }
```

`sendMail` must still never throw.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Bound the SMTP connection

Still in `lib/mailer.ts`, add timeouts to the transport options:

```ts
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass },
      // Nodemailer defaults to a 10-minute socket timeout, which outlives this
      // route's maxDuration of 300s. A hung socket would therefore kill the
      // function before the catch above could return anything at all -- no
      // JSON, no reason, nothing for the workflow to read. Fail in seconds so
      // the failure is reportable.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
```

**Verify**: `npm run typecheck` → exit 0 (nodemailer's types accept all three
options; if any is rejected, that is a STOP condition).

### Step 3: Make a failed digest send return 500

In `app/api/digest/route.ts`, replace the final return at `:126-127`:

```ts
  const result = await sendMail(mail, digest.subject, digest.text, digest.html);

  // A failed send is a failed job, not a 200 with a sad field. This route
  // writes nothing, so answering non-2xx costs no data and is the only way the
  // failure reaches Vercel's own cron log -- the GitHub workflow's grep is not
  // running on that path. The workflow fails on a non-200 before it greps, so
  // this upgrades a silent warning into a red run in both schedulers.
  return NextResponse.json(
    { ok: result.sent, ...result, subject: digest.subject, asOf: screen.asOf },
    { status: result.sent ? 200 : 500 },
  );
```

**Do not** make the equivalent change in `app/api/refresh/route.ts`. That route
stores bars; failing it because an email bounced would turn an annoyance into a
data gap, which is exactly what `sendMail`'s comment forbids.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "status: result.sent" app/api/digest/route.ts` → one match
- `grep -n "status: 500" app/api/refresh/route.ts` → **no matches**

### Step 4: Record why the two routes differ

In `app/api/refresh/route.ts`, immediately above the `sendMail` call at `:231`,
add a comment only — no code change:

```ts
        // Deliberately still a 200 on failure, unlike /api/digest: this route
        // has already stored bars and snapshotted tiers. A failed email must
        // not mark that work as failed. The reason field now says what went
        // wrong without changing the status.
```

**Verify**: `git diff --stat app/api/refresh/route.ts` → 1 file changed, only
insertions, no deletions.

### Step 5: Extend `lib/mailer.test.ts`

Append to the file created by plan 003:

```ts
import { SEND_FAILED, sendFailure } from "./mailer";

describe("sendFailure", () => {
  /**
   * The bug this guards: a genuine SMTP rejection returned {sent,recipients,
   * error} with NO reason, while every deliberate suppression reported one. The
   * workflow greps for "reason", so the real failure was the only one that
   * degraded to "unstated".
   */
  it("always carries a machine-readable reason", () => {
    const r = sendFailure(new Error("535 auth failed"), 3);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe(SEND_FAILED);
    expect(typeof r.reason).toBe("string");
  });

  it("preserves the underlying error text alongside the reason", () => {
    const r = sendFailure(new Error("535 auth failed"), 3);
    expect(r.error).toContain("535");
    expect(r.recipients).toBe(3);
  });

  it("handles a non-Error throw without losing the reason", () => {
    const r = sendFailure("socket hang up", 1);
    expect(r.reason).toBe(SEND_FAILED);
    expect(r.error).toBe("socket hang up");
  });
});
```

**Verify**: `npx vitest run lib/mailer.test.ts` → 9 tests pass (6 from plan
003 + 3 new).

### Step 6: Prove the guard actually guards

Temporarily remove `reason: SEND_FAILED,` from `sendFailure` in `lib/mailer.ts`.

**Verify**: `npx vitest run lib/mailer.test.ts` → **exactly two** of the three
new tests FAIL — "always carries a machine-readable reason" and "handles a
non-Error throw without losing the reason", both with
`AssertionError: expected undefined to be 'smtp send failed'`.

The third, "preserves the underlying error text alongside the reason", asserts
only `r.error` and `r.recipients` and never touches `r.reason`, so it correctly
stays green. That is sound test design, not a weak guard. (An earlier revision
of this plan said all three would fail; that was an authoring error.)

If **fewer than two** fail, the tests are not testing what they claim — stop and
report. Restore the line and re-run: 9 pass.

## Test plan

- Extend `lib/mailer.test.ts` with a `describe("sendFailure")` block, 3 cases:
  the reason is always present, the underlying error survives alongside it, and
  a non-`Error` throw still produces a reason.
- Structural pattern: the blocks plan 003 added to the same file.
- The mutation check in Step 6 is mandatory.
- **Known coverage gap, state it in your report**: nothing here proves the
  *routes* emit the field, because neither route handler has a test harness.
  The `reason` contract is verified at the `sendFailure` boundary only. Closing
  that gap is plan 005's problem (it needs the same harness for its dedupe logic).
- Verification: `npm test` → 478 passing (475 + 3).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` reports **no NEW problems in the three in-scope files**.
      It does NOT exit 0 and never did: at `aa21e08` there is 1 pre-existing
      error (`app/use-persisted-state.ts`, react-hooks/set-state-in-effect) and
      5 pre-existing warnings (`lib/edgar.ts`, `lib/screen-service.ts`,
      `lib/solvency.test.ts`), all outside this plan's scope. Do not fix them.
- [ ] `npm test` exits 0 with 478 passing (475 + 3 new)
- [ ] `grep -n "SEND_FAILED" lib/mailer.ts` returns the constant, its use in
      `sendFailure`, and nothing else
- [ ] `grep -n "socketTimeout" lib/mailer.ts` returns one match
- [ ] `grep -n "status: result.sent" app/api/digest/route.ts` returns one match
- [x] `grep -rn "status: 500" app/api/refresh/route.ts` returns **exactly one
      match, the pre-existing catch-all at `:258`** (an outer error handler that
      predates this plan and has nothing to do with the mail path). The original
      criterion said "no matches" and was simply wrong — it was written without
      checking. The real constraint: **no 500 is added on the sendMail/alert
      path** of this route.
- [ ] `sendMail` still has no `throw` in its body
      (`grep -n "throw" lib/mailer.ts` returns only the server-only guard at the top)
- [ ] Step 6's mutation check was performed and **exactly two** tests failed, as predicted
- [ ] Only the four in-scope files are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Nodemailer's TypeScript types reject `connectionTimeout`, `greetingTimeout`
  or `socketTimeout`. Do not cast to `any` to force it — report the version.
- Step 6's mutation check does **not** produce failures.
- You conclude `/api/refresh` should also return 500 on a mail failure. It must
  not — see Step 4. If you believe otherwise, stop and report.
- Any existing test fails, particularly in `lib/alerts.test.ts` or
  `lib/digest.test.ts`.

## Maintenance notes

- **Operator action after deploy**: the next digest run will now return 500 if
  Gmail rejects the message, which will show as a **failed** GitHub Actions run
  and a failed Vercel cron invocation. That is the intended behaviour — do not
  treat the first red run as a regression without reading the `reason` field.
- **Interaction with plan 005 (send ledger)**: when the dedupe ledger lands, the
  ledger row must be written **only on a successful send**, or a 500 followed by
  a retry would be suppressed as a duplicate and the digest would never arrive.
  Plan 005 must account for this explicitly.
- Vercel may retry a non-2xx cron invocation. Until plan 005 lands, a retried
  digest sends a second copy. That is the correct trade-off in this order:
  a duplicate email is recoverable, a silently missing one is not.
- A reviewer should confirm `sendMail` still cannot throw, and that the 500 was
  added to the digest route only.
- The three timeout values are judgement calls, not measurements. If Gmail
  proves slower than 30s under load, raise `socketTimeout` — but keep it well
  under `maxDuration` (300s) or the guarantee in Step 1 stops holding.
