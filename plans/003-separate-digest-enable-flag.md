# Plan 003: Stop `ALERTS_ENABLED` from silencing the morning digest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4fd256c..HEAD -- lib/mailer.ts app/api/digest/route.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4fd256c`, 2026-09-15

## Why this matters

This app sends two emails with **opposite contracts**:

- The **change alert** is exception-driven. It should be silent when nothing
  moved, and turning it off for a week is a reasonable thing to want.
- The **morning digest** is unconditional *by design*. Its entire justification
  is that silence must be diagnostic. From `README.md`: "an alert that goes
  quiet looks exactly like a screener that died three weeks ago, so a digest
  that always arrives is the only thing that can tell you the pipeline is
  alive."

Both are gated by the **same** `ALERTS_ENABLED` flag. So the one action a user
would reasonably take — "mute the noisy alerts for a week" — also removes the
only signal that the pipeline is alive, producing exactly the silence the
digest exists to prevent. The digest route's own comment names this risk and
then does it anyway.

After this plan, `ALERTS_ENABLED` governs only the alert, and the digest is
controlled by `DIGEST_ENABLED`, which **defaults to on**. Muting alerts no
longer mutes the heartbeat.

This plan also creates `lib/mailer.test.ts`, the first test file covering the
email configuration layer. Plans 004 and 005 extend it.

## Current state

Three files.

**`lib/mailer.ts:14-19`** — one flag on the config object:

```ts
export interface MailConfig {
  readonly user: string;
  readonly pass: string;
  readonly to: readonly string[];
  readonly enabled: boolean;
}
```

**`lib/mailer.ts:29-44`** — where it is read:

```ts
export function readMailConfig(): MailConfig | null {
  if (typeof window !== "undefined") throw new Error("lib/mailer.ts is server-only.");

  const user = process.env.GMAIL_USER?.trim();
  // Two spellings exist in the shared secrets; accept either.
  const pass = (process.env.GMAIL_APP_PW ?? process.env.GMAIL_APP_PASSWORD)?.trim();
  if (!user || !pass) return null;

  const to = (process.env.ALERT_TO ?? user)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (to.length === 0) return null;

  return { user, pass, to, enabled: process.env.ALERTS_ENABLED === "true" };
}
```

**`app/api/digest/route.ts:108-125`** — the digest refuses to send on it:

```ts
  const mail = readMailConfig();
  if (!mail) {
    return NextResponse.json({ ok: true, sent: false, reason: "no mail config", subject: digest.subject });
  }
  if (!mail.enabled) {
    // Reported, not silent: a digest that stops arriving because a flag is off
    // is indistinguishable from one that stops because the cron broke.
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "ALERTS_ENABLED is not true",
      subject: digest.subject,
    });
  }

  const result = await sendMail(mail, digest.subject, digest.text, digest.html);
  return NextResponse.json({ ok: true, ...result, subject: digest.subject, asOf: screen.asOf });
```

**The alert path, which must keep using `enabled`** —
`lib/alerts.ts:108-127` consumes it through a `SendContext`:

```ts
export function shouldSend(changes: readonly TierChange[], ctx: SendContext): boolean {
  if (!ctx.enabled) return false;
  ...
}

export function suppressionReason(changes: readonly TierChange[], ctx: SendContext): string | null {
  if (!ctx.enabled) return "ALERTS_ENABLED is not true";
  ...
}
```

`app/api/refresh/route.ts:214-218` builds that context with `enabled: mail.enabled`.
**None of this changes.**

**`.env.example`** documents the existing flags — but note it is **untracked and
will not exist in your worktree** (see Step 3). It is reproduced here only so you
understand the naming convention the new flag follows. Do not try to open it.

```
# Recipients, comma separated. Defaults to GMAIL_USER when unset.
# Deliberately NOT named EMAIL_TO: that variable belongs to another project in
# the shared secrets, and inheriting its value would surprise both apps.
ALERT_TO=

# Alerts only send when this is exactly "true". Same reasoning: EMAIL_ENABLED
# already exists for another project and is currently false.
ALERTS_ENABLED=
```

Repo conventions that apply here:

- **Env flags are screener-specific and explicit** — see the `.env.example`
  comment above explaining why `EMAIL_TO`/`EMAIL_ENABLED` are avoided. Your new
  variable must carry a comment in the same voice explaining its default.
- **Suppression is reported, never silent.** Every non-send path returns
  `{sent: false, reason: <string>}` so the GitHub workflow can surface it
  (`.github/workflows/schedule.yml:101-104` greps for exactly that shape).
- Tests are vitest, colocated as `lib/<name>.test.ts`, pure, no mocking of
  modules. See `lib/format.test.ts` for the simplest example of the house style.

## Commands you will need

| Purpose    | Command                             | Expected on success |
|------------|-------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                 | exit 0, no errors   |
| Tests      | `npm test`                          | all pass (469 at plan time) |
| One file   | `npx vitest run lib/mailer.test.ts` | all pass            |
| Lint       | `npm run lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify or create):

- `lib/mailer.ts`
- `app/api/digest/route.ts`
- `lib/mailer.test.ts` (**create**)

**NOT in scope, despite what Step 3 once said**: `.env.example`. It is untracked
(see Step 3) and absent from any worktree. Do not create it.

**Out of scope** (do NOT touch, even though they look related):

- `lib/alerts.ts` — `shouldSend` and `suppressionReason` must keep reading
  `ctx.enabled` and keep returning the string `"ALERTS_ENABLED is not true"`.
  `lib/alerts.test.ts` asserts on that exact string.
- `app/api/refresh/route.ts` — the alert path is correct as written.
- `lib/digest.ts` — the digest builder is pure and correct; nothing about the
  email content changes.
- `.env.local` and `.env.example` — never read, never modify, never create, never print any value from either.
- **The `ALERT_TO` empty-string bug** (`lib/mailer.ts:37` uses `??`, which does
  not catch `""`). It is a real, separate finding and is deliberately not in
  this plan. Do not fix it here even though you will be editing the adjacent
  lines.

## Git workflow

- Branch: `advisor/003-separate-digest-enable-flag`
- One commit; imperative subject with a prose body, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `digestEnabled` to `MailConfig`

In `lib/mailer.ts`, extend the interface:

```ts
export interface MailConfig {
  readonly user: string;
  readonly pass: string;
  readonly to: readonly string[];
  /** Exception-driven tier-change alerts. Opt-IN: off unless explicitly "true". */
  readonly enabled: boolean;
  /**
   * The unconditional morning digest. Opt-OUT: on unless explicitly "false".
   *
   * The two flags default in opposite directions on purpose. An alert that is
   * off is quiet; a digest that is off is indistinguishable from a pipeline
   * that died, which is the one failure this email exists to make visible. So
   * silencing it has to be a deliberate act, not a side effect of muting alerts.
   */
  readonly digestEnabled: boolean;
}
```

And in `readMailConfig()`, extend the return:

```ts
  return {
    user,
    pass,
    to,
    enabled: process.env.ALERTS_ENABLED === "true",
    digestEnabled: process.env.DIGEST_ENABLED !== "false",
  };
```

Note the asymmetry is intentional and load-bearing: `=== "true"` for alerts
(opt-in), `!== "false"` for the digest (opt-out). Do not "tidy" them to match.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Gate the digest on the new flag

In `app/api/digest/route.ts`, change the guard at `:113` from `mail.enabled` to
`mail.digestEnabled`, and update the reason string:

```ts
  if (!mail.digestEnabled) {
    // Reported, not silent: a digest that stops arriving because a flag is off
    // is indistinguishable from one that stops because the cron broke. Note
    // this is DIGEST_ENABLED, not ALERTS_ENABLED -- muting the alerts must not
    // mute the heartbeat.
    return NextResponse.json({
      ok: true,
      sent: false,
      reason: "DIGEST_ENABLED is false",
      subject: digest.subject,
    });
  }
```

Leave the `if (!mail)` branch above it exactly as it is.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "mail.enabled" app/api/digest/route.ts` → **no matches**
- `grep -n "mail.enabled" app/api/refresh/route.ts` → still **one match** (the
  alert path is untouched)

### Step 3: SKIP — documenting `.env.example` is deferred to plan 006

**Do not attempt this step. There is nothing to do here.**

An earlier revision of this plan asked you to append a `DIGEST_ENABLED` block to
`.env.example`. That was a defect in the plan, discovered when an executor
correctly stopped on it: **`.env.example` is not tracked by git**, so it does not
exist in an isolated worktree and cannot be edited there.

The cause is a `.gitignore` bug, not a missing file. `.gitignore:34` ignores
`.env*`, `.gitignore:44` un-ignores `!.env.example`, and then `.gitignore:47`
repeats `.env*` — and git applies the **last** matching rule, so the negation is
silently defeated. Confirmed with `git check-ignore -v .env.example`, which
reports `.gitignore:47:.env*` as the winning rule.

The file exists on the maintainer's disk and contains names only (no values), but
has never been committed. Fixing that — and then documenting `DIGEST_ENABLED` in
it — is `plans/006-commit-env-example.md`.

**Nothing to verify. Proceed to Step 4.**

### Step 4: Create `lib/mailer.test.ts`

This is the first test covering the mail configuration layer. Use `vi.stubEnv`
so environment changes are undone automatically.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMailConfig } from "./mailer";

/**
 * Credentials here are obvious fakes and exist only to get past the
 * null-guard. Never put a real value in a test file.
 */
function withCreds() {
  vi.stubEnv("GMAIL_USER", "screener@example.com");
  vi.stubEnv("GMAIL_APP_PW", "not-a-real-password");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readMailConfig", () => {
  it("returns null without credentials", () => {
    vi.stubEnv("GMAIL_USER", "");
    vi.stubEnv("GMAIL_APP_PW", "");
    expect(readMailConfig()).toBeNull();
  });

  it("falls back to the sender when ALERT_TO is unset", () => {
    withCreds();
    vi.stubEnv("ALERT_TO", undefined);
    expect(readMailConfig()?.to).toEqual(["screener@example.com"]);
  });

  it("splits a comma-separated ALERT_TO", () => {
    withCreds();
    vi.stubEnv("ALERT_TO", "a@example.com, b@example.com");
    expect(readMailConfig()?.to).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("the two send flags default in opposite directions", () => {
  /**
   * The bug this guards: one flag gated both emails, so muting the alerts
   * also removed the digest -- the only message that proves the pipeline is
   * alive. These two cases must never collapse back into one.
   */
  it("alerts are off unless ALERTS_ENABLED is exactly true", () => {
    withCreds();
    vi.stubEnv("ALERTS_ENABLED", undefined);
    expect(readMailConfig()?.enabled).toBe(false);
    vi.stubEnv("ALERTS_ENABLED", "TRUE");
    expect(readMailConfig()?.enabled).toBe(false);
    vi.stubEnv("ALERTS_ENABLED", "true");
    expect(readMailConfig()?.enabled).toBe(true);
  });

  it("the digest is on unless DIGEST_ENABLED is exactly false", () => {
    withCreds();
    vi.stubEnv("DIGEST_ENABLED", undefined);
    expect(readMailConfig()?.digestEnabled).toBe(true);
    vi.stubEnv("DIGEST_ENABLED", "false");
    expect(readMailConfig()?.digestEnabled).toBe(false);
  });

  it("muting alerts leaves the digest sending", () => {
    withCreds();
    vi.stubEnv("ALERTS_ENABLED", "false");
    vi.stubEnv("DIGEST_ENABLED", undefined);
    const cfg = readMailConfig();
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.digestEnabled).toBe(true);
  });
});
```

**Verify**: `npx vitest run lib/mailer.test.ts` → 6 tests pass.

### Step 5: Prove the guard actually guards

Per this repo's evidence rule, a test that still passes when you break the
implementation is not a test. Temporarily change `digestEnabled` in
`lib/mailer.ts` back to `process.env.ALERTS_ENABLED === "true"`.

**Verify**: `npx vitest run lib/mailer.test.ts` → the last two tests
("the digest is on unless DIGEST_ENABLED is exactly false" and "muting alerts
leaves the digest sending") **FAIL**.

If they still pass, the test is not testing what it claims — stop and report.

Then restore the correct implementation and re-run: all 7 pass.

## Test plan

- New file `lib/mailer.test.ts` with 6 tests: 3 for `readMailConfig` basics
  (no credentials, ALERT_TO fallback, comma splitting) and 3 pinning the
  opposite-default contract of the two flags.
- Structural pattern: `lib/format.test.ts` for the house style;
  `vi.stubEnv`/`vi.unstubAllEnvs` for environment control.
- **No real credential values anywhere** — use the obvious fakes above.
- The mutation check in Step 5 is mandatory, not optional.
- Verification: `npm test` → 475 passing (469 + 6).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [x] `npm run lint` — NOT achievable and never was: 1 pre-existing error
      (`app/use-persisted-state.ts`, react-hooks/set-state-in-effect) plus 5
      warnings exist at `4fd256c`, all outside this plan's scope. Criterion
      relaxed to: lint reports no NEW problems in the three in-scope files.
- [x] `npm test` exits 0 with 475 passing (469 + 6 new)
- [ ] `grep -n "mail.enabled" app/api/digest/route.ts` returns **no matches**
- [ ] `grep -n "mail.enabled" app/api/refresh/route.ts` returns exactly **one** match
- [ ] `grep -n "ALERTS_ENABLED is not true" lib/alerts.ts` still returns its match
      (the alert's reason string is unchanged)
- [ ] Step 5's mutation check was performed and the tests failed as predicted
- [ ] Only the three in-scope files are modified/created (`git status`); `.env.example` is NOT created
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Any test in `lib/alerts.test.ts` or `lib/digest.test.ts` fails. Those cover
  the pure builders and must be unaffected by this change; a failure means you
  edited something out of scope.
- Step 5's mutation check does **not** produce failures.
- `vi.stubEnv` is unavailable in the installed vitest (2.1.9 at plan time). Do
  not substitute direct `process.env` mutation without cleanup — report instead.
- You conclude the digest should default to **off**. It must not; that inverts
  the entire purpose of the change. If you believe otherwise, stop and report.

## Maintenance notes

- **Operator action required after deploy**: `DIGEST_ENABLED` does not need to
  be set for the digest to keep working — that is the point of the opt-out
  default. But confirm on the first weekday after deploy that the 13:00 UTC run
  returns `sent: true`, because this is the first change to that code path.
- A reviewer should check the asymmetry survived: `=== "true"` for alerts,
  `!== "false"` for the digest. A well-meaning "consistency" refactor that makes
  both opt-in silently reintroduces the bug.
- **Adjacent finding, deliberately deferred**: `lib/mailer.ts:37` uses
  `process.env.ALERT_TO ?? user`, and `??` does not catch an empty string — so
  `ALERT_TO=` (a variable added then cleared in the Vercel UI) makes
  `readMailConfig()` return `null` and both emails report `"no mail config"`,
  blaming the Gmail credentials, which are fine. `lib/mailer.test.ts` now exists
  and is the right home for that regression test when it is picked up.
- Plans 004 and 005 extend `lib/mailer.test.ts`. Keep the file's structure
  (describe-per-concern, `vi.stubEnv` with an `afterEach` unstub) so they compose.
