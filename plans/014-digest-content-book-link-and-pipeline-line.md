# Plan 014: The digest shows the Strong Buy book, a pipeline-health line, and a link to the screener

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Setup (run first)**: `git rev-parse --short HEAD`. If it is not `7d56c3f`
> or a descendant, run `git merge --ff-only 7d56c3f`; if that fails, STOP.
> Plan 013 must be merged: `lib/digest-service.ts` must exist and be the only
> caller of `buildDigest` outside tests. If not, STOP.
>
> **Drift check (run second)**: `git diff --stat 7d56c3f..HEAD -- lib/digest.ts lib/digest.test.ts lib/digest-service.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — formatting only; inputs are already computed by `getScreen`
- **Depends on**: plans/013-digest-preview-and-ledger-scripts.md
- **Category**: direction
- **Planned at**: commit `7d56c3f`, 2026-09-23; made concrete against `b2f89e0` at dispatch 2026-09-24. The dispatched version also converts the rounding and dash tests (lines 186-204) from `leaders` to `book`, which this draft missed; expected count 513

## Why this matters

Three gaps in what the morning email actually tells a reader:

1. **No link.** The alert ends with `https://screener.williamstradingplatform.com`
   (`lib/alerts.ts:169`, `:185`); the digest — the email people actually
   open — has no way to reach the app.
2. **"Strongest names" is the wrong list.** It is the top ten themed names
   by RS percentile (`app/api/digest/route.ts:104-108`), regardless of tier.
   A stage-4 name capped to Hold can sit at the top with `Hold` beside it,
   which reads as a contradiction. The actionable output of this screener is
   the **ten Strong Buy slots** after every overlay; that is the list the
   reader wants at 6 AM.
3. **No pipeline line.** The digest's stated purpose (`lib/digest.ts:9-21`)
   is to reveal a dead pipeline. It reports data staleness but not whether
   the 5 AM refresh actually ran, succeeded, or is still running — which the
   page already shows via `buildRefreshStamp` (`lib/refresh-stamp.ts:166`)
   and `screen.lastRefresh`. A Monday digest can be "Latest close" while
   Friday night's refresh failed; the page would say so and the email would not.

## Current state

- `lib/digest.ts:47-48` — `readonly leaders: readonly { ticker; rsPct; tier }[]`,
  rendered by `leaderLine` (`:68-69`) under the heading "Strongest names"
  (`:128-131` text, `:155-159` html).
- `lib/digest.ts:104-165` — `buildDigest` builds `lines` for text and an
  array of HTML fragments; both must carry every change.
- `lib/digest-service.ts` (after plan 013) builds `DigestInput` including the
  `leaders` sort `.sort((a, b) => (b.rsPct ?? -1) - (a.rsPct ?? -1)).slice(0, LEADERS)`.
- `ScreenPayload.lastRefresh: RefreshRun | null` (`lib/screen-service.ts:214`),
  and `buildRefreshStamp(run, now).detail` yields e.g.
  `Ran Sep 23, 5:12 AM MST, added 1 session and 4,102 bars.` /
  `Check failed Sep 23, 5:12 AM MST.` / `Started … and has not finished.`
- `screen.themed` rows carry `tier`, `rsPct`, `vsMa`, `weight`, and are in
  rank order (strongest first).
- Tests: `lib/digest.test.ts` uses a `base: DigestInput` fixture; every
  field added to `DigestInput` must be added to `base`.
- The screener URL is currently a literal in two places in `lib/alerts.ts`.
  Export one constant from `lib/alerts.ts` and use it in both modules —
  "derive, don't duplicate".

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 |
| Tests | `npx vitest run lib/digest.test.ts lib/alerts.test.ts` | pass |
| All | `npm test` | pass, +3 |
| Preview | `npm run digest:preview` | text shows the three new sections |
| Lint | `npx eslint lib/digest.ts lib/digest-service.ts lib/alerts.ts` | no new problems |

## Scope

**In scope**:
- `lib/alerts.ts` (export `SCREENER_URL`; use it in `formatAlert`)
- `lib/digest.ts`, `lib/digest.test.ts`
- `lib/digest-service.ts`

**Out of scope**:
- `app/api/digest/route.ts`, `lib/mailer.ts`, `lib/refresh-stamp.ts`.
- Subject-line logic (`digestSubject`) — unchanged.

## Git workflow

- Branch: `advisor/014-digest-content`
- One commit: `Put the Strong Buy book, the refresh outcome and a link in the digest`

## Steps

### Step 1: One URL constant

In `lib/alerts.ts` add near the top:
`export const SCREENER_URL = "https://screener.williamstradingplatform.com";`
and replace both literal occurrences in `formatAlert` with it.

**Verify**: `grep -c "williamstradingplatform" lib/alerts.ts` → 1.
`npx vitest run lib/alerts.test.ts` → pass.

### Step 2: Extend `DigestInput`

In `lib/digest.ts`, replace the `leaders` field with:

```ts
  /**
   * The Strong Buy book after every overlay, in rank order -- the ten names
   * that actually hold a slot this morning. This replaced a "strongest by
   * RS" list, which could lead with a stage-4 name capped to Hold and read
   * as a contradiction.
   */
  readonly book: readonly { ticker: string; rsPct: number | null; vsMa: number | null }[];
  /**
   * One sentence on the last refresh run, from buildRefreshStamp().detail,
   * or null when no run is recorded. Data staleness says whether the numbers
   * are old; this says whether the thing that updates them is alive.
   */
  readonly refreshLine: string | null;
```

Import `SCREENER_URL` from `./alerts` (that import line already brings `escapeHtml`).

### Step 3: Render

In `buildDigest`:

- Text: after the first line (`Session … - stalenessLabel`) push
  `Refresh: ${d.refreshLine ?? "no run recorded"}`.
- Text: replace the "Strongest names" block with:

```ts
  lines.push("", `Strong Buy book (${d.book.length})`);
  if (d.book.length === 0) lines.push("  none");
  for (const b of d.book) lines.push(`  ${bookLine(b)}`);
  lines.push("", SCREENER_URL);
```

  with `const bookLine = (b) => `${b.ticker.padEnd(6)} RS ${rs(b.rsPct).padStart(3)}  vs MA ${b.vsMa == null ? "--" : `${b.vsMa >= 0 ? "+" : ""}${b.vsMa.toFixed(1)}%`}`;`
  (type the parameter as `DigestInput["book"][number]`).
- HTML: wrap the whole fragment array in
  `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">…</div>`
  (the alert already does this at `lib/alerts.ts:182`; the digest is bare);
  add `<p style="margin:0 0 12px;color:#5B6B7A">Refresh: ${esc(d.refreshLine ?? "no run recorded")}</p>`
  after the staleness `<p>`; replace the leaders `<h3>` block with a
  `Strong Buy book (N)` `<h3>` + `<pre>` built from `bookLine`; and end with
  `<p style="margin:14px 0 0"><a href="${SCREENER_URL}">Open the screener</a></p>`.

Delete `leaderLine`.

**Verify**: `npm run typecheck` → errors only in `lib/digest.test.ts` and
`lib/digest-service.ts`.

### Step 4: Feed it

In `lib/digest-service.ts` replace the `leaders:` entry with:

```ts
    book: screen.themed
      .filter((r) => r.tier === "Strong Buy")
      .map((r) => ({ ticker: r.ticker, rsPct: r.rsPct, vsMa: r.vsMa })),
    refreshLine: screen.lastRefresh ? buildRefreshStamp(screen.lastRefresh, new Date()).detail : null,
```

Import `buildRefreshStamp` from `./refresh-stamp`. Remove the `LEADERS`
constant and its sort.

**Verify**: `npm run typecheck` → errors only in `lib/digest.test.ts`.

### Step 5: Tests

In `lib/digest.test.ts`: in `base`, replace `leaders: [...]` with
`book: [{ ticker: "LITE", rsPct: 99, vsMa: 12.3 }, { ticker: "DELL", rsPct: 99, vsMa: 4.0 }],`
and add `refreshLine: "Ran Aug 21, 5:12 AM MST, added 1 session and 4,102 bars.",`.
Rewrite the two leaders tests ("includes the strongest names", "omits the
leaders block…") as:

```ts
  it("lists the Strong Buy book with RS and distance from the MA", () => {
    const { text, html } = buildDigest(base);
    expect(text).toMatch(/Strong Buy book \(2\)/);
    expect(text).toMatch(/LITE\s+RS\s+99\s+vs MA \+12\.3%/);
    expect(html).toMatch(/Strong Buy book \(2\)/);
  });

  it("says none rather than printing an empty book", () => {
    expect(buildDigest({ ...base, book: [] }).text).toMatch(/Strong Buy book \(0\)\n  none/);
  });

  it("reports the last refresh run, or that none is recorded", () => {
    expect(buildDigest(base).text).toMatch(/Refresh: Ran Aug 21/);
    expect(buildDigest({ ...base, refreshLine: null }).text).toMatch(/Refresh: no run recorded/);
  });

  it("links to the screener in both parts", () => {
    const { text, html } = buildDigest(base);
    expect(text).toContain("https://screener.williamstradingplatform.com");
    expect(html).toMatch(/href="https:\/\/screener\.williamstradingplatform\.com"/);
  });
```

Also fix any test that referenced `leaders` in an override.

**Verify**: `npx vitest run lib/digest.test.ts` → pass, net +2 (two
replaced, four added).

### Step 6: Mutation check (mandatory)

Temporarily change the `filter` in `lib/digest-service.ts` to
`r.tier !== "Hold"` — no unit test can catch that (it is I/O), so instead run
`npm run digest:preview` and confirm the `Strong Buy book (N)` count equals
the `N Strong Buy` count on the line above it; with the mutation they differ.
Restore, re-run, confirm they match. Report both numbers.

Then temporarily remove the `SCREENER_URL` line from the text body; the
"links to the screener" test MUST fail. Restore.

### Step 7: Gates

`npm run typecheck` 0; `npm test` +2 from the plan-013 baseline;
`npm run digest:preview` shows Refresh line, book, link.

## Done criteria

- [ ] `grep -rn "leaders" lib/digest.ts lib/digest-service.ts` → none
- [ ] `grep -c "SCREENER_URL" lib/digest.ts` ≥ 2; `grep -c "williamstradingplatform" lib/alerts.ts` → 1
- [ ] `npm test` passes with the new tests; both mutation checks reported
- [ ] `npm run digest:preview` output pasted (text part) in the report
- [ ] Only in-scope files modified; `plans/README.md` updated

## STOP conditions

- `screen.lastRefresh` is not on `ScreenPayload`, or `buildRefreshStamp`'s
  signature is not `(run, now) => { detail }`.
- `buildDigest` is called anywhere other than `lib/digest-service.ts` and tests.
- The preview cannot run (no keys) — finish, run unit gates, report the
  book-count check as not performed.

## Maintenance notes

- If the Strong Buy limit changes (`STRONG_BUY_LIMIT`), the book grows with
  it automatically.
- Reviewer: the text and HTML must list the same tickers; the alert has a
  test for exactly that (`lib/alerts.test.ts:122`) — consider mirroring it.
- The README's description of the digest ("the ten strongest names",
  `README.md:158`) becomes "the Strong Buy book"; plan 015 covers README.
