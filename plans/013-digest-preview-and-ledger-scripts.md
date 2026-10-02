# Plan 013: A shared `composeDigest`, a preview script that renders the email locally, and a ledger script

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Plans 008, 009 and 010 must be merged: the digest route must contain
> `baseline`, `digestKey(phoenixToday(), screen.asOf)` and `claimMailSend`.
> If any is missing, STOP.
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- app/api/digest/route.ts package.json .gitignore scripts/`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW — extraction plus two new scripts; the route's behaviour is unchanged
- **Depends on**: plans/010-mail-ledger-claim-before-send.md
- **Category**: dx
- **Planned at**: commit `7d56c3f`, 2026-09-23; re-verified against `4d6bad9` (post-010) 2026-09-23; Step 1 made concrete at dispatch, live preview moved to the reviewer (no `.env.local` in executor worktrees)

## Why this matters

There is currently no way to see what tomorrow's digest will say without
waiting for 6 AM or hitting production. Every wording change in
`lib/digest.ts` ships blind, and the only rendering of the HTML anyone sees
is in their inbox. Likewise, when the ledger holds a key it should not (a
stranded claim after plan 010, or an old-format row), the fix is a hand-typed
SQL statement against Neon.

This plan:

1. Moves the compose logic out of `app/api/digest/route.ts` into
   `lib/digest-service.ts` so the route and a script call **one** function
   (the repo's "derive, don't duplicate" rule).
2. Adds `scripts/preview-digest.ts` (`npm run digest:preview`) which writes
   the subject, text and HTML to files and prints the text. With
   `--send --to <address>` it delivers a real copy to that one address
   **without touching the ledger**.
3. Adds `scripts/mail-ledger.ts` (`npm run mail-ledger -- list|forget`).

## Current state

- `app/api/digest/route.ts` after plans 008-010 — `handle()` does, in order:
  authorise → `getScreen()` → baseline lookup (`previousTiers` in try/catch,
  four-way `baseline`) → `diffTiers` when live → `tierCounts` → `buildDigest({...})`
  → `readMailConfig()` → `digestEnabled` check → `claimMailSend` → `sendMail`
  → `releaseMailSend` on failure → JSON. The compose part is everything from
  `getScreen()` through `buildDigest(...)`; the `LEADERS = 10` constant and
  the leaders sort live there too.
- Script conventions (`scripts/health.ts:1-45`): a header comment with the
  `npm run …` invocations, tiny `arg()` / `has()` argv helpers, `neon(process.env.DATABASE_URL)`
  for direct SQL, imports from `../lib/...`. Scripts run via
  `tsx --env-file=.env.local scripts/<name>.ts` in `package.json`.
- `lib/mailer.ts:104-113` — `envelope(cfg)` always puts `cfg.user` on the To
  line; a preview send must pass a `MailConfig` whose `to` is the single
  `--to` address so nobody else receives a test.
- `.gitignore` has no entry for a local output directory. The preview will
  write under `tmp/`; add `/tmp/` to `.gitignore`.
- `db/schema.sql:209-214` — `mail_sends(kind, dedupe_key, sent_at)`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | pass |
| Lint | `npx eslint lib/digest-service.ts scripts/preview-digest.ts scripts/mail-ledger.ts app/api/digest/route.ts` | no problems |
| Preview | `npm run digest:preview` | exit 0; `tmp/digest/digest.html`, `.txt`, `.subject` written; text printed |
| Ledger | `npm run mail-ledger -- list` | prints rows (or "no rows") |

`tsconfig.json` excludes nothing under `scripts/`, so `npm run typecheck`
covers the new scripts (confirm with `grep -n '"include"\|"exclude"' tsconfig.json`).

## Scope

**In scope**:
- `lib/digest-service.ts` (create)
- `app/api/digest/route.ts` (call the service; keep auth, flags, ledger, send)
- `scripts/preview-digest.ts` (create), `scripts/mail-ledger.ts` (create)
- `package.json` (two script entries), `.gitignore` (one line)
- `lib/dates.ts` (one doc-comment sentence only; see Step 0)

**Out of scope**:
- `lib/digest.ts`, `lib/mailer.ts`, `lib/db.ts` — no signature changes.
- `app/api/refresh/route.ts`.
- Any test harness for the route.

## Git workflow

- Branch: `advisor/013-digest-preview`
- Commits: (1) `Extract composeDigest so the route and a script build the same email`,
  (2) `Add a digest preview script and a mail ledger script`.

## Steps

### Step 0: Correct one sentence in `phoenixToday`'s comment

Plan 009 landed a doc comment on `phoenixToday` in `lib/dates.ts` that says
"Phoenix is UTC-7 with no daylight saving, so the offset is a constant and
needs no timezone database." The implementation uses `Intl.DateTimeFormat`
with `timeZone: "America/Phoenix"`, which does use the runtime's timezone
database. Replace that sentence with:
"Phoenix is UTC-7 year round with no daylight saving, so its calendar day
never shifts with the seasons."
Change nothing else in the file.

**Verify**: `grep -c "needs no timezone database" lib/dates.ts` → `0`.
`npx vitest run lib/dates.test.ts` → 4 pass.

### Step 1: Extract `composeDigest`

Create `lib/digest-service.ts`:

```ts
/**
 * Build the morning digest from live data. Server-only.
 *
 * One function for both callers -- the /api/digest route and
 * scripts/preview-digest.ts -- so the preview shows exactly what the route
 * would send. Two copies of this logic would drift the first time someone
 * changed one of them.
 *
 * Pure composition: no mail, no ledger. Those stay in the route.
 */

import { getScreen, type ScreenPayload } from "./screen-service";
import { previousTiers } from "./db";
import { diffTiers } from "./alerts";
import { buildDigest, tierCounts, type BaselineState, type Digest } from "./digest";

/** How many of the strongest names to list. */
const LEADERS = 10;

export interface ComposedDigest {
  readonly digest: Digest;
  readonly screen: ScreenPayload;
  readonly baseline: BaselineState;
}

export async function composeDigest(force = false): Promise<ComposedDigest> {
  const screen = await getScreen(force);
  // (move the baseline try/catch, the diffTiers call, tierCounts and the
  //  buildDigest({...}) call here VERBATIM from app/api/digest/route.ts,
  //  including their comments)
  ...
  return { digest, screen, baseline };
}
```

Then in `app/api/digest/route.ts` replace the compose block with
`const { digest, screen } = await composeDigest();` and delete the now-unused
imports (`getScreen`, `previousTiers`, `diffTiers`, `buildDigest`,
`tierCounts`, `BaselineState`, `LEADERS`). Everything from `readMailConfig()`
down stays as it is.

**Verify**: `npm run typecheck` → 0. `npx eslint app/api/digest/route.ts lib/digest-service.ts` → 0 problems
(unused imports are lint errors here). `git diff app/api/digest/route.ts` shows
only deletions in the compose region plus the one new call.

### Step 2: The preview script

Create `scripts/preview-digest.ts`:

```ts
/**
 * Render tomorrow's digest without waiting for 6 AM.
 *
 *   npm run digest:preview                        # write tmp/digest/*, print the text
 *   npm run digest:preview -- --out some/dir      # elsewhere
 *   npm run digest:preview -- --send --to me@x.y  # ALSO deliver one copy to that address
 *
 * The send path never touches the mail ledger and never uses ALERT_TO: it
 * addresses exactly one recipient, the one on the command line, so a test
 * cannot go to the real distribution list or suppress the real morning.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeDigest } from "../lib/digest-service";
import { readMailConfig, sendMail } from "../lib/mailer";

const arg = (n: string) => { /* copy from scripts/health.ts */ };
const has = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const out = arg("out") ?? join("tmp", "digest");
  const { digest, screen, baseline } = await composeDigest(true);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "digest.subject"), digest.subject + "\n");
  writeFileSync(join(out, "digest.txt"), digest.text + "\n");
  writeFileSync(join(out, "digest.html"), digest.html + "\n");

  console.log(`asOf ${screen.asOf}  baseline ${baseline}  warnings ${screen.meta.warnings.length}`);
  console.log(`Subject: ${digest.subject}\n`);
  console.log(digest.text);
  console.log(`\nWritten to ${out}/`);

  if (has("send")) {
    const to = arg("to");
    if (!to) throw new Error("--send requires --to <address>");
    const cfg = readMailConfig();
    if (!cfg) throw new Error("No mail config: set GMAIL_USER and GMAIL_APP_PW");
    // One recipient, explicitly. envelope() still puts the sender on To and
    // this address in Bcc; that is the production shape, which is the point.
    const result = await sendMail({ ...cfg, to: [to] }, `[PREVIEW] ${digest.subject}`, digest.text, digest.html);
    console.log(result.sent ? `Sent preview to ${to}` : `Send failed: ${result.reason} ${result.error ?? ""}`);
    if (!result.sent) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

Add to `package.json` scripts:
`"digest:preview": "tsx --env-file=.env.local scripts/preview-digest.ts",`

Add `/tmp/` to `.gitignore` under the `# misc` block with the comment
`# local digest previews (npm run digest:preview)`.

**Verify**: `npm run digest:preview` → exit 0, prints the text, and
`ls tmp/digest` lists `digest.html digest.subject digest.txt`. Open
`tmp/digest/digest.html` in a browser if one is available and confirm it
renders; otherwise `head -c 300 tmp/digest/digest.html` shows the `<h2>`.
`git status` must NOT list `tmp/`.

### Step 3: The ledger script

Create `scripts/mail-ledger.ts`:

```ts
/**
 * Inspect or correct the mail send ledger.
 *
 *   npm run mail-ledger -- list                 # newest 30 rows
 *   npm run mail-ledger -- list --limit 100
 *   npm run mail-ledger -- forget digest digest:2026-09-23:2026-09-22
 *
 * `forget` is for a claim that never became an email: the process died
 * between claimMailSend and releaseMailSend, or a row from before the key
 * format changed. Deleting it lets the next scheduler send. It cannot
 * un-send anything.
 */

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const sql = neon(url);
const arg = (n: string) => { /* copy from scripts/health.ts */ };

async function main() {
  const cmd = process.argv[2];
  if (cmd === "list") {
    const limit = Number(arg("limit") ?? 30);
    const rows = (await sql`
      SELECT kind, dedupe_key, sent_at FROM mail_sends ORDER BY sent_at DESC LIMIT ${limit}
    `) as { kind: string; dedupe_key: string; sent_at: string }[];
    if (rows.length === 0) { console.log("no rows"); return; }
    for (const r of rows) console.log(`${new Date(r.sent_at).toISOString()}  ${r.kind.padEnd(6)}  ${r.dedupe_key}`);
    return;
  }
  if (cmd === "forget") {
    const [kind, key] = [process.argv[3], process.argv[4]];
    if (!kind || !key) throw new Error("usage: forget <kind> <dedupe_key>");
    const rows = (await sql`
      DELETE FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${key} RETURNING 1
    `) as unknown[];
    console.log(rows.length === 1 ? `forgot ${kind} ${key}` : `no such row: ${kind} ${key}`);
    return;
  }
  throw new Error("usage: list [--limit N] | forget <kind> <dedupe_key>");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

Add to `package.json`: `"mail-ledger": "tsx --env-file=.env.local scripts/mail-ledger.ts",`

**Verify**: `npm run mail-ledger -- list` → prints rows or `no rows`, exit 0.
`npm run mail-ledger -- forget digest nonexistent-key` → prints `no such row`, exit 0.
Do NOT forget a real key during verification.

### Step 4: Gates

`npm run typecheck` → 0. `npm test` → unchanged count. `npx eslint` on the
four files → 0 problems.

## Test plan

`composeDigest` is I/O; the pure parts it calls are already tested. The
preview script IS the test for the composition: its output must show the
same subject the route would send. No new unit tests are required; say so.

## Done criteria

- [ ] `grep -c "composeDigest" app/api/digest/route.ts` → 1; `grep -n "buildDigest\|diffTiers\|previousTiers" app/api/digest/route.ts` → none
- [ ] `npm run digest:preview` exits 0 and writes three files under `tmp/digest/`
- [ ] `git status` does not show `tmp/`
- [ ] `npm run mail-ledger -- list` exits 0
- [ ] `npm run typecheck` 0; `npm test` 0; eslint clean on new files
- [ ] `plans/README.md` updated

## STOP conditions

- `.env.local` lacks `DATABASE_URL` or `POLYGON_API_KEY` — the preview cannot
  run; finish the code, run typecheck and lint, and report the preview as
  unverified.
- `readMailConfig()` stops returning a plain object spreadable with `to` overridden.
- The digest route no longer contains the compose block described in
  "Current state" (someone restructured it) — report before extracting.

## Maintenance notes

- Plan 014 changes `DigestInput`; the only place that builds it is now
  `composeDigest`, which is the point of this plan.
- Reviewer: check the preview send uses `{ ...cfg, to: [to] }` and never
  calls `claimMailSend`.
- `--send` marks the subject `[PREVIEW]` so a test copy can never be mistaken
  for the morning email in a search.
