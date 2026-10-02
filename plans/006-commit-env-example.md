# Plan 006: Fix the `.gitignore` rule that silently keeps `.env.example` out of version control

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **DO NOT START THIS PLAN WITHOUT THE MAINTAINER'S EXPLICIT GO-AHEAD.** It adds
> a previously-untracked file to version control. That is a deliberate decision
> about what lives in the repo, and it is not yours to make. See "Why this
> matters" for the evidence that it is intended, and STOP conditions for the
> check you must run first.
>
> **Drift check (run first)**: `git diff --stat 4fd256c..HEAD -- .gitignore`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (adds a file to version control; requires a content review first)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `4fd256c`, 2026-09-15
- **Blocked on**: maintainer approval

## Why this matters

`.env.example` is this project's only record of which environment variables the
app needs — `POLYGON_API_KEY`, `DATABASE_URL`, `SEC_EDGAR_USER_AGENT`,
`GMAIL_USER`, `ALERT_TO`, `CF_ACCESS_AUD`, `CRON_SECRET` and others, each with a
comment explaining a non-obvious trap (why `ALERT_TO` is deliberately not
`EMAIL_TO`, why an unset Access config must fail closed).

It has **never been committed**. It exists only on the maintainer's disk. A lost
machine or a fresh clone loses the entire map of the app's configuration.

This is not a missing file — it is a `.gitignore` bug. Three rules interact:

```
.gitignore:34  .env*            # ignore all env files
.gitignore:44  !.env.example    # ...except this one — a deliberate opt-in
.gitignore:47  .env*            # duplicate, re-ignores everything
```

Git applies the **last** matching rule, so line 47 silently defeats the line 44
negation. Confirmed:

```
$ git check-ignore -v .env.example
.gitignore:47:.env*	.env.example
```

The `!.env.example` at line 44 is direct evidence someone intended this file to
be tracked and believed it was. The failure is invisible: `git status` reports a
clean tree, because an ignored file is not untracked-and-unreported — it is
simply absent from git's view.

This also broke plan 003, whose Step 3 asked a worktree-isolated executor to
edit a file that cannot exist in a worktree.

## Current state

`.gitignore` env-related lines (from `grep -n "env" .gitignore`):

```
33: # env files (can opt-in for committing if needed)
34: .env*
41: next-env.d.ts
44: !.env.example
47: .env*
```

Lines 34 and 47 are duplicates. Line 47 is the one that wins.

`.env.example` on disk is 1805 bytes, last modified 2026-08-21. Its header
states its own safety contract:

```
# Names only. Real values live in ~/.secrets/shared.env and .env.local.
# Nothing here may ever take a NEXT_PUBLIC_ prefix: every one of these is
# read server-side in a route handler.
```

`git log --oneline --all -- .env.example` returns nothing — it has never existed
in history, so there is no risk of a secret already being in a past commit.

Repo conventions that apply here:

- `db/schema.sql` establishes the house style for a tracked reference file:
  heavily commented, explaining *why* each thing exists rather than what it is.
  `.env.example` already follows it.
- Secrets live in `~/.secrets/shared.env` and `.env.local`, never in the repo.

## Commands you will need

| Purpose        | Command                              | Expected on success |
|----------------|--------------------------------------|---------------------|
| Ignore check   | `git check-ignore -v .env.example`   | after Step 1: exit 1, no output |
| Tracked check  | `git ls-files .env.example`          | after Step 2: prints the path |
| Secret scan    | see Step 2                           | no matches          |
| Tests          | `npm test`                           | all pass            |

## Scope

**In scope**:

- `.gitignore`
- `.env.example` (add to version control; **content changes only as Step 3 allows**)

**Out of scope**:

- `.env.local` — must stay ignored. **Never open it, never print it, never
  commit it.** Verify at the end that it is still ignored.
- Any source file.
- Rotating or changing any credential.

## Git workflow

- Branch: `advisor/006-commit-env-example`
- One commit; imperative subject with a prose body explaining the last-rule-wins
  behaviour, matching `git log`.
- Do NOT push.

## Steps

### Step 1: Remove the duplicate ignore rule

Delete the **second** `.env*` (line 47), keeping line 34 and the `!.env.example`
negation at line 44. Order matters: the negation must come after the `.env*` it
negates, and nothing may re-ignore it afterwards.

Add a comment where the duplicate was, so nobody reinstates it:

```
# NOTE: do not re-add a blanket `.env*` below this point. Git applies the LAST
# matching rule, so a second `.env*` here silently cancels the `!.env.example`
# opt-in above -- which is exactly what happened, and it kept the only record of
# this app's configuration out of the repo entirely while `git status` reported
# a clean tree.
```

**Verify**: `git check-ignore -v .env.example` → **exit code 1 and no output**
(the file is no longer ignored). Confirm with `echo $?` immediately after.

Also confirm `.env.local` is still ignored:
`git check-ignore -v .env.local` → prints a matching rule (exit 0).

### Step 2: Scan the file for real values BEFORE staging it

This is the step that makes the plan safe. Do not skip it and do not shortcut it.

Every line must be either a comment (`#`), blank, or `KEY=` with **nothing after
the equals sign**.

```bash
grep -nvE '^($|#|[A-Z0-9_]+=$)' .env.example
```

**Verify**: this command produces **no output**. Any line it prints is a
populated value and a potential secret.

If it prints anything: **STOP immediately.** Do not stage the file, do not
report the offending content, and tell the maintainer only the line number and
the variable name — never the value.

### Step 3: Stage and commit

```bash
git add .gitignore .env.example
git status --short
```

**Verify**: `git status --short` shows exactly two entries — `M .gitignore` and
`A .env.example` — and nothing else. In particular `.env.local` must **not**
appear.

Then commit per the git workflow above.

**Verify**: `git ls-files .env.example` → prints `.env.example`.

### Step 4: Add the `DIGEST_ENABLED` entry deferred from plan 003

**Only if plan 003 has landed** (check: `grep -c "digestEnabled" lib/mailer.ts`
returns a non-zero count). If it has not, skip this step and say so.

Append to `.env.example`, matching the surrounding comment voice:

```
# The morning digest is the pipeline's heartbeat and is ON by default -- it
# sends unless this is exactly "false". Deliberately NOT gated by
# ALERTS_ENABLED: muting the exception-driven alerts must not also remove the
# one message that proves the screener is still running.
DIGEST_ENABLED=
```

**Verify**: re-run the Step 2 scan — still no output — and
`grep -c "DIGEST_ENABLED" .env.example` → `1`.

## Test plan

No unit tests; this is a version-control and configuration change with no
runtime behaviour. Verification is entirely via the `git check-ignore`,
`git ls-files` and secret-scan commands above.

Run `npm test` once at the end purely to confirm nothing was disturbed → all pass.

## Done criteria

ALL must hold:

- [ ] `git check-ignore -v .env.example` exits 1 with no output
- [ ] `git check-ignore -v .env.local` exits 0 (still ignored)
- [ ] `git ls-files .env.example` prints the path
- [ ] `git ls-files .env.local` prints **nothing**
- [ ] `grep -nvE '^($|#|[A-Z0-9_]+=$)' .env.example` produces no output
- [ ] `grep -c "env\*" .gitignore` returns `1` (the duplicate is gone)
- [ ] `npm test` exits 0, all pass
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **The maintainer has not explicitly approved this plan.** This is the first
  check, before any edit.
- The Step 2 scan prints **any** line. Report the line number and variable name
  only — never the value — and recommend the maintainer review it.
- `git log --all -- .env.example` returns any commit, meaning the file has a
  history you were not told about. The premise that nothing sensitive was ever
  committed no longer holds.
- Removing line 47 does not change `git check-ignore` output — there is another
  ignore source (a global `core.excludesFile`, or `.git/info/exclude`) and the
  diagnosis is incomplete.
- `.env.local` appears in `git status` at any point.

## Maintenance notes

- The real lesson is the failure mode, not the file: **a `.gitignore` negation
  can be silently cancelled by a later broad rule, and nothing reports it.**
  `git status` shows a clean tree either way. If another `!`-negated path is
  added later, verify it with `git check-ignore -v` rather than assuming.
- A reviewer should confirm the committed `.env.example` contains names only.
  That review is the actual safety gate — the grep in Step 2 is a good filter,
  not a proof, since a value that happens to match `[A-Z0-9_]+=$` shape cannot
  exist but an unusual key format could slip past.
- Once tracked, `.env.example` becomes the place new environment variables are
  documented. Plans that add a variable should update it in the same commit.
- If the maintainer decides they would rather `.env.example` stay untracked,
  mark this plan REJECTED and remove the forward reference in plan 003's Step 3.
