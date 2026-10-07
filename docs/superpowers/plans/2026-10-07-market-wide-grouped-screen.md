# Market-wide grouped screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the full tier ruleset on every liquid US stock (~2,300) and show them ranked inside groups (AI themes, an "AI spenders" group, then SIC sectors), while the AI book, its 10-slot cap, alerts and digest stay exactly as they are.

**Architecture:** `computeScreen` stops narrowing to the theme before the overlays. The overlays (true MA, hysteresis, stage, fundamentals, balance sheet) run on all ranked rows. The AI book is then a filter of those same rows, and only the book is capped. Fundamentals move from live EDGAR calls into a `company_fundamentals` table, filled by a script and topped up by the nightly refresh within a time budget. A separate `market_band_tiers` table remembers yesterday's band tier for non-book names, so `tier_history` and its readers stay untouched.

**Tech Stack:** Next.js 16.3.1 App Router, TypeScript, vitest, Neon Postgres via `@neondatabase/serverless`, tsx scripts.

**Spec:** `docs/superpowers/specs/2026-10-07-market-wide-grouped-screen-design.md`

## Global Constraints

- No new npm dependencies.
- Next.js is 16.3.1 and differs from training data: read the relevant guide in `node_modules/next/dist/docs/` before changing any route or page code (AGENTS.md).
- Every task must leave `npm run typecheck`, `npm test` and `npm run lint` passing.
- `tier_history` schema and every reader of it are unchanged. Only `previousMomentumTiers` (lib/db.ts) gains a second source.
- The AI book (`ScreenPayload.themed`, `portfolio`, all book counters, alerts, digest) must produce identical tiers before and after this change on the same `asOf`.
- Strong Buy cap stays `STRONG_BUY_LIMIT = 10` with `CAP_MARGIN = 2`, applied to the book only.
- Fundamentals are re-fetched when older than **7 days**. A name with no stored fundamentals is `unverified`, never `demote`.
- `market_band_tiers` keeps the last **10** sessions.
- A database failure in any new loader becomes a `meta.warnings` entry, never a silent empty result and never a thrown error from `getScreen`.
- Never stage `.claude/` or `.semgrep/` (untracked local folders). Always `git add` explicit paths.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deploying before the fundamentals backfill.** Every book Strong Buy would read `unverified`, the gate would demote nothing, and the book would silently change. Expected: the backfill runs before deploy and the book is identical. Pinned by Task 8 Step 2 (book equivalence diff), and by the deploy order in Task 8 Step 5.
2. **An EDGAR fetch that throws every night.** Expected: never stored, listed as failed, retried next night, never blocks the rest of the batch. Pinned by Task 3 test "does not store a failed fetch".
3. **A group whose rows all have null RS** (recent listings). Expected: median is null, the group sorts last, nothing renders NaN. Pinned by Task 1 test "sorts a group with no measured RS last".
4. **A ticker present in both `tier_history` and `market_band_tiers` for the prior session** (e.g. it was just added to `THEME`). Expected: the book's value wins. Pinned by Task 4 test "book tier wins over market tier".
5. **A filter or search that empties some or all groups.** Expected: empty groups are omitted, not drawn as empty headers. When nothing matches, one empty-state line. Pinned by Task 1 tests "omits groups with no matching rows" and "returns nothing when no row matches".

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/groups.ts` | create | Group assignment (`groupOf`), AI theme display names, group summary, filter-and-group for the UI |
| `lib/groups.test.ts` | create | Tests for the above |
| `lib/fundamentals-store.ts` | create | Pure: which candidates need fetching, which stored facts are usable |
| `lib/fundamentals-store.test.ts` | create | Tests |
| `lib/fundamentals-topup.ts` | create | Budgeted EDGAR fetch loop with injectable deps |
| `lib/fundamentals-topup.test.ts` | create | Tests |
| `lib/market-rows.ts` | create | `MarketRow` type, `toMarketRow`, `heldDownReasons`, `splitBook` |
| `lib/market-rows.test.ts` | create | Tests, including the cap split |
| `lib/hysteresis.ts` | modify | Add `mergePriorTiers` |
| `lib/hysteresis.test.ts` | modify | Tests for `mergePriorTiers` |
| `lib/db.ts` | modify | Fundamentals table I/O, `ciksFor`, market band table I/O, `previousMomentumTiers` merge |
| `db/schema.sql` | modify | Document the two new tables |
| `lib/screen-service.ts` | modify | Pipeline over all ranked rows, book as a filter, payload `market` replaces `leaders` |
| `scripts/health.ts` | modify | `screen.leaders` → `screen.market` |
| `scripts/book-snapshot.ts` | create | Print the book's tiers and timing as JSON, for the equivalence check |
| `scripts/fundamentals.ts` | create | Backfill `company_fundamentals` |
| `package.json` | modify | `fundamentals` and `book:snapshot` scripts |
| `app/api/refresh/route.ts` | modify | Write market band tiers, top up fundamentals within a budget |
| `app/market-groups.tsx` | create | Grouped view |
| `app/leaders-table.tsx` | delete | Replaced by the grouped view |
| `app/page.tsx` | modify | Render `MarketGroups` instead of `LeadersTable` |
| `app/globals.css` | modify | A few `.mg-*` rules |
| `README.md` | modify | Document the grouped view, the fundamentals store and `npm run fundamentals` |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch and commit the spec and this plan**

```bash
git checkout -b feat/market-groups
git add docs/superpowers/specs/2026-10-07-market-wide-grouped-screen-design.md docs/superpowers/plans/2026-10-07-market-wide-grouped-screen.md
git commit -m "Add the market-wide grouped screen spec and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Groups

**Files:**
- Create: `lib/groups.ts`
- Test: `lib/groups.test.ts`

**Interfaces:**
- Consumes: `THEME`, `CAPEX_SPENDERS`, `CROWDING_VETO`, `exclusionReason`, type `Sector` from `lib/theme.ts`; type `SectorLabels` from `lib/sic.ts`; type `Tier` from `lib/types.ts`.
- Produces:
  - `type GroupKind = "ai_theme" | "ai_spenders" | "sector"`
  - `interface Group { name: string; kind: GroupKind; badge: string | null }`
  - `groupOf(ticker: string, sic: SectorLabels | undefined): Group`
  - `THEME_LABELS: Record<ThemeSector, string>`, `AI_SPENDERS = "AI spenders"`, `UNCLASSIFIED = "Unclassified"`
  - `interface GroupedLike { ticker: string; name: string; group: string; groupKind: GroupKind; rsPct: number | null; tier: Tier | null }`
  - `interface GroupStat { name: string; kind: GroupKind; count: number; medianRs: number | null; strongBuy: number; buy: number; hold: number }`
  - `summariseGroups(rows: readonly GroupedLike[]): GroupStat[]`
  - `type KindFilter = "all" | "ai" | "sector"`, `type TierFilter = "all" | Tier`
  - `filterAndGroup<T extends GroupedLike>(rows: readonly T[], f: { kind: KindFilter; tier: TierFilter; query: string }, order: readonly GroupStat[]): { stat: GroupStat; rows: T[] }[]`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/groups.test.ts
import { describe, expect, it } from "vitest";
import {
  AI_SPENDERS,
  UNCLASSIFIED,
  filterAndGroup,
  groupOf,
  summariseGroups,
  type GroupedLike,
} from "./groups";
import type { SectorLabels } from "./sic";

const SEMIS: SectorLabels = { sector: "Semiconductors", subsector: "Semiconductors & Related Devices" };

describe("groupOf", () => {
  it("puts a net AI CapEx spender in its own group with the reason as a badge", () => {
    expect(groupOf("MSFT", SEMIS)).toEqual({
      name: AI_SPENDERS,
      kind: "ai_spenders",
      badge: "net AI CapEx spender",
    });
  });

  it("keeps a crowding-vetoed name in its AI theme, badged", () => {
    expect(groupOf("MU", SEMIS)).toEqual({
      name: "Memory & storage",
      kind: "ai_theme",
      badge: "crowding veto: memory/storage",
    });
  });

  it("gives an ordinary theme member no badge", () => {
    expect(groupOf("LITE", undefined)).toEqual({
      name: "Optics & networking",
      kind: "ai_theme",
      badge: null,
    });
  });

  it("resolves a name listed in two themes to the first one declared", () => {
    // TER is in semicap_equipment and robotics_automation; ROK in power and robotics.
    expect(groupOf("TER", undefined).name).toBe("Semicap equipment");
    expect(groupOf("ROK", undefined).name).toBe("Power, thermal & datacenter");
    expect(groupOf("PLTR", undefined).name).toBe("Data infrastructure software");
  });

  it("falls back to the SIC sector outside the theme", () => {
    expect(groupOf("ZZZZ", SEMIS)).toEqual({ name: "Semiconductors", kind: "sector", badge: null });
  });

  it("uses Unclassified when there is no SIC label at all", () => {
    expect(groupOf("ZZZZ", undefined)).toEqual({ name: UNCLASSIFIED, kind: "sector", badge: null });
  });
});

const r = (over: Partial<GroupedLike>): GroupedLike => ({
  ticker: "T",
  name: "Test Co",
  group: "Semiconductors",
  groupKind: "sector",
  rsPct: 50,
  tier: "Hold",
  ...over,
});

describe("summariseGroups", () => {
  it("orders groups by median RS, highest first", () => {
    const stats = summariseGroups([
      r({ group: "A", rsPct: 10 }),
      r({ group: "B", rsPct: 90 }),
      r({ group: "B", rsPct: 70 }),
    ]);
    expect(stats.map((s) => s.name)).toEqual(["B", "A"]);
  });

  it("averages the middle pair for an even count", () => {
    const [s] = summariseGroups([r({ rsPct: 60 }), r({ rsPct: 80 })]);
    expect(s.medianRs).toBe(70);
  });

  it("counts tiers per group", () => {
    const [s] = summariseGroups([
      r({ tier: "Strong Buy" }),
      r({ tier: "Strong Buy" }),
      r({ tier: "Buy" }),
      r({ tier: "Hold" }),
      r({ tier: null }),
    ]);
    expect(s).toMatchObject({ count: 5, strongBuy: 2, buy: 1, hold: 1 });
  });

  it("sorts a group with no measured RS last", () => {
    const stats = summariseGroups([
      r({ group: "New", rsPct: null }),
      r({ group: "Old", rsPct: 5 }),
    ]);
    expect(stats.map((s) => s.name)).toEqual(["Old", "New"]);
    expect(stats[1].medianRs).toBeNull();
  });
});

describe("filterAndGroup", () => {
  const rows = [
    r({ ticker: "AAA", name: "Alpha", group: "Optics & networking", groupKind: "ai_theme", rsPct: 90, tier: "Strong Buy" }),
    r({ ticker: "BBB", name: "Beta", group: "Optics & networking", groupKind: "ai_theme", rsPct: 95, tier: "Buy" }),
    r({ ticker: "CCC", name: "Gamma", group: "Energy", groupKind: "sector", rsPct: 40, tier: "Hold" }),
  ];
  const order = summariseGroups(rows);
  const all = { kind: "all" as const, tier: "all" as const, query: "" };

  it("ranks rows by RS inside each group, in the stats order", () => {
    const out = filterAndGroup(rows, all, order);
    expect(out.map((g) => g.stat.name)).toEqual(["Optics & networking", "Energy"]);
    expect(out[0].rows.map((x) => x.ticker)).toEqual(["BBB", "AAA"]);
  });

  it("omits groups with no matching rows", () => {
    const out = filterAndGroup(rows, { ...all, kind: "sector" }, order);
    expect(out.map((g) => g.stat.name)).toEqual(["Energy"]);
  });

  it("filters by tier and by ticker or name search", () => {
    expect(filterAndGroup(rows, { ...all, tier: "Strong Buy" }, order)[0].rows.map((x) => x.ticker)).toEqual(["AAA"]);
    expect(filterAndGroup(rows, { ...all, query: "gam" }, order)[0].rows.map((x) => x.ticker)).toEqual(["CCC"]);
  });

  it("returns nothing when no row matches", () => {
    expect(filterAndGroup(rows, { ...all, query: "nope" }, order)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/groups.test.ts`
Expected: FAIL, "Failed to resolve import ./groups".

- [ ] **Step 3: Implement**

```ts
// lib/groups.ts
/**
 * Which group a ranked name is shown under, market-wide.
 *
 * Three kinds, in precedence order:
 *   1. ai_spenders -- the net AI CapEx spenders the strategy excludes. Ranked
 *      and shown so you can see where they stand, badged with the reason.
 *   2. ai_theme    -- the hand-maintained THEME map. First declared wins, the
 *      same rule themeUniverse uses, so a name never sits in two groups.
 *      Crowding-vetoed names stay in their theme, badged.
 *   3. sector      -- the SIC sector from lib/sic.ts, or Unclassified when the
 *      filer has no SIC code at all.
 *
 * Grouping is presentation only. It never re-ranks: rsPct is the universe-wide
 * percentile, computed once before any of this runs.
 */

import {
  CAPEX_SPENDERS,
  CROWDING_VETO,
  THEME,
  exclusionReason,
  type Sector as ThemeSector,
} from "./theme";
import type { SectorLabels } from "./sic";
import type { Tier } from "./types";

export type GroupKind = "ai_theme" | "ai_spenders" | "sector";

export interface Group {
  readonly name: string;
  readonly kind: GroupKind;
  /** Why the strategy excludes this name, or null. */
  readonly badge: string | null;
}

export const AI_SPENDERS = "AI spenders";
export const UNCLASSIFIED = "Unclassified";

export const THEME_LABELS: Readonly<Record<ThemeSector, string>> = {
  compute_gpu_cpu: "Compute (GPU/CPU)",
  memory_storage: "Memory & storage",
  semicap_equipment: "Semicap equipment",
  foundry_packaging: "Foundry & packaging",
  optics_networking: "Optics & networking",
  power_thermal_datacenter: "Power, thermal & datacenter",
  materials_specialty: "Specialty materials",
  security_identity: "Security & identity",
  data_infra_software: "Data infrastructure software",
  robotics_automation: "Robotics & automation",
  defense_space_autonomy: "Defense, space & autonomy",
  ai_appliers: "AI appliers",
};

/** ticker -> its first-declared theme. Built once; THEME is a constant. */
const THEME_OF: ReadonlyMap<string, ThemeSector> = (() => {
  const m = new Map<string, ThemeSector>();
  for (const [key, tickers] of Object.entries(THEME) as [ThemeSector, readonly string[]][]) {
    for (const t of tickers) if (!m.has(t)) m.set(t, key);
  }
  return m;
})();

export function groupOf(ticker: string, sic: SectorLabels | undefined): Group {
  if (CAPEX_SPENDERS.has(ticker)) {
    return { name: AI_SPENDERS, kind: "ai_spenders", badge: exclusionReason(ticker) };
  }
  const theme = THEME_OF.get(ticker);
  if (theme) {
    return {
      name: THEME_LABELS[theme],
      kind: "ai_theme",
      badge: CROWDING_VETO.has(ticker) ? exclusionReason(ticker) : null,
    };
  }
  if (sic) return { name: sic.sector, kind: "sector", badge: null };
  return { name: UNCLASSIFIED, kind: "sector", badge: null };
}

/** The fields grouping and summarising need. MarketRow satisfies it. */
export interface GroupedLike {
  readonly ticker: string;
  readonly name: string;
  readonly group: string;
  readonly groupKind: GroupKind;
  readonly rsPct: number | null;
  readonly tier: Tier | null;
}

export interface GroupStat {
  readonly name: string;
  readonly kind: GroupKind;
  readonly count: number;
  /** Median, not mean: one 99th-percentile name should not describe forty middling ones. */
  readonly medianRs: number | null;
  readonly strongBuy: number;
  readonly buy: number;
  readonly hold: number;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summariseGroups(rows: readonly GroupedLike[]): GroupStat[] {
  const groups = new Map<string, GroupedLike[]>();
  for (const r of rows) {
    const g = groups.get(r.group);
    if (g) g.push(r);
    else groups.set(r.group, [r]);
  }
  return [...groups.values()]
    .map((g): GroupStat => ({
      name: g[0].group,
      kind: g[0].groupKind,
      count: g.length,
      medianRs: median(
        g.map((r) => r.rsPct).filter((v): v is number => v != null && Number.isFinite(v)),
      ),
      strongBuy: g.filter((r) => r.tier === "Strong Buy").length,
      buy: g.filter((r) => r.tier === "Buy").length,
      hold: g.filter((r) => r.tier === "Hold").length,
    }))
    .sort(
      (a, b) =>
        (b.medianRs ?? -Infinity) - (a.medianRs ?? -Infinity) || a.name.localeCompare(b.name),
    );
}

export type KindFilter = "all" | "ai" | "sector";
export type TierFilter = "all" | Tier;

export interface GroupFilter {
  readonly kind: KindFilter;
  readonly tier: TierFilter;
  readonly query: string;
}

/**
 * Filter, then bucket into groups in `order`, rows ranked by RS within each.
 * Groups left empty by the filter are dropped rather than drawn as bare headers.
 */
export function filterAndGroup<T extends GroupedLike>(
  rows: readonly T[],
  f: GroupFilter,
  order: readonly GroupStat[],
): { stat: GroupStat; rows: T[] }[] {
  const q = f.query.trim().toUpperCase();
  const keep = (r: T) =>
    (f.kind === "all" || (f.kind === "ai" ? r.groupKind !== "sector" : r.groupKind === "sector")) &&
    (f.tier === "all" || r.tier === f.tier) &&
    (q === "" || r.ticker.toUpperCase().includes(q) || r.name.toUpperCase().includes(q));

  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    if (!keep(r)) continue;
    const g = byGroup.get(r.group);
    if (g) g.push(r);
    else byGroup.set(r.group, [r]);
  }
  const rank = (a: T, b: T) =>
    (b.rsPct ?? -Infinity) - (a.rsPct ?? -Infinity) || a.ticker.localeCompare(b.ticker);

  return order
    .filter((s) => byGroup.has(s.name))
    .map((s) => ({ stat: s, rows: (byGroup.get(s.name) as T[]).sort(rank) }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/groups.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation check**

Temporarily change `if (!m.has(t)) m.set(t, key);` to `m.set(t, key);` and rerun. Expected: "resolves a name listed in two themes" FAILS. Then temporarily change `.filter((s) => byGroup.has(s.name))` to `.filter(() => true)` with `rows: byGroup.get(s.name) ?? []`. Expected: "omits groups with no matching rows" FAILS. Revert both, rerun, confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/groups.ts lib/groups.test.ts
git commit -m "Add market-wide group assignment and group summaries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fundamentals store

**Files:**
- Create: `lib/fundamentals-store.ts`
- Test: `lib/fundamentals-store.test.ts`
- Modify: `lib/db.ts` (append a new section after the "Tier history" section)
- Modify: `db/schema.sql` (append)

**Interfaces:**
- Consumes: type `Fundamentals` from `lib/edgar.ts`.
- Produces:
  - `FUNDAMENTALS_MAX_AGE_DAYS = 7`
  - `interface StoredFundamentals { facts: Fundamentals | null; fetchedAt: string }`
  - `wantedFundamentals(candidates: readonly string[], fetchedAt: ReadonlyMap<string, string>, now: Date, maxAgeDays?: number): string[]`. Missing first, in candidate order, then stale oldest-first.
  - `usableFundamentals(stored: ReadonlyMap<string, StoredFundamentals>): Map<string, Fundamentals>`
  - lib/db.ts: `loadStoredFundamentals(): Promise<Map<string, StoredFundamentals>>`, `upsertFundamentals(rows: readonly { ticker: string; facts: Fundamentals | null }[]): Promise<number>`, `ciksFor(tickers: readonly string[]): Promise<Map<string, string>>`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/fundamentals-store.test.ts
import { describe, expect, it } from "vitest";
import { usableFundamentals, wantedFundamentals, type StoredFundamentals } from "./fundamentals-store";
import type { Fundamentals } from "./edgar";

const NOW = new Date("2026-10-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("wantedFundamentals", () => {
  it("wants missing names, in candidate order, before stale ones", () => {
    const stored = new Map([["OLD", daysAgo(30)]]);
    expect(wantedFundamentals(["OLD", "B", "A"], stored, NOW)).toEqual(["B", "A", "OLD"]);
  });

  it("skips names fetched within the window", () => {
    const stored = new Map([["FRESH", daysAgo(2)]]);
    expect(wantedFundamentals(["FRESH"], stored, NOW)).toEqual([]);
  });

  it("orders stale names oldest first", () => {
    const stored = new Map([
      ["X", daysAgo(8)],
      ["Y", daysAgo(40)],
    ]);
    expect(wantedFundamentals(["X", "Y"], stored, NOW)).toEqual(["Y", "X"]);
  });

  it("finds a gap in the middle, not just the tail", () => {
    // Resume by set difference: an interrupted backfill must not be read as
    // "done up to C".
    const stored = new Map([
      ["A", daysAgo(1)],
      ["C", daysAgo(1)],
    ]);
    expect(wantedFundamentals(["A", "B", "C"], stored, NOW)).toEqual(["B"]);
  });

  it("treats an unparseable timestamp as stale and ignores duplicate candidates", () => {
    const stored = new Map([["BAD", "not a date"]]);
    expect(wantedFundamentals(["BAD", "BAD"], stored, NOW)).toEqual(["BAD"]);
  });
});

describe("usableFundamentals", () => {
  it("drops rows stored as 'no SEC filings', so the gate reads them as unverified", () => {
    const f = { cik: "1", revAccel: 1, opMarginDelta: 1 } as unknown as Fundamentals;
    const stored = new Map<string, StoredFundamentals>([
      ["HAS", { facts: f, fetchedAt: daysAgo(1) }],
      ["NONE", { facts: null, fetchedAt: daysAgo(1) }],
    ]);
    const out = usableFundamentals(stored);
    expect([...out.keys()]).toEqual(["HAS"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/fundamentals-store.test.ts`
Expected: FAIL, cannot resolve `./fundamentals-store`.

- [ ] **Step 3: Implement the pure module**

```ts
// lib/fundamentals-store.ts
/**
 * Stored EDGAR fundamentals: what to fetch, and what is usable.
 *
 * Fundamentals used to be fetched live during the screen and cached in memory,
 * which was fine for ~40 AI names and impossible for ~400 market-wide Strong Buy
 * candidates inside a 60s request. They now live in company_fundamentals, filled
 * by scripts/fundamentals.ts and topped up by the nightly refresh.
 *
 * Quarterly data, so a week-old copy loses nothing. A stale row is still USED
 * for gating -- it is only queued for a re-fetch. A missing row is unverified,
 * which the gate already treats as "do not demote".
 */

import type { Fundamentals } from "./edgar";

export const FUNDAMENTALS_MAX_AGE_DAYS = 7;

export interface StoredFundamentals {
  /** Null means "fetched, and the filer has no usable SEC data". Not re-fetched until stale. */
  readonly facts: Fundamentals | null;
  readonly fetchedAt: string;
}

/**
 * Candidates that need a fetch: missing first, in candidate order, then stale
 * oldest-first. Set difference, never a high-water mark, so a gap anywhere is found.
 */
export function wantedFundamentals(
  candidates: readonly string[],
  fetchedAt: ReadonlyMap<string, string>,
  now: Date,
  maxAgeDays: number = FUNDAMENTALS_MAX_AGE_DAYS,
): string[] {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const missing: string[] = [];
  const stale: { t: string; at: number }[] = [];
  for (const t of new Set(candidates)) {
    const at = fetchedAt.get(t);
    if (at == null) {
      missing.push(t);
      continue;
    }
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) stale.push({ t, at: -Infinity });
    else if (ms < cutoff) stale.push({ t, at: ms });
  }
  stale.sort((a, b) => a.at - b.at || a.t.localeCompare(b.t));
  return [...missing, ...stale.map((s) => s.t)];
}

/** The facts the gate can judge. Null rows are left out so they read as unverified. */
export function usableFundamentals(
  stored: ReadonlyMap<string, StoredFundamentals>,
): Map<string, Fundamentals> {
  const out = new Map<string, Fundamentals>();
  for (const [t, s] of stored) if (s.facts) out.set(t, s.facts);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/fundamentals-store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the database functions**

In `lib/db.ts`, add to the imports at the top:

```ts
import type { Fundamentals } from "./edgar";
import type { StoredFundamentals } from "./fundamentals-store";
```

Append this section after `loadTierHistory` and before the `previousTiers` function:

```ts
// ---------------------------------------------------------------------------
// Stored fundamentals
// ---------------------------------------------------------------------------

/** Created by its consumer, like company_health and mail_sends. */
async function ensureFundamentalsTable(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS company_fundamentals (
      ticker     TEXT PRIMARY KEY,
      facts      JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/** Every stored row. A few thousand small JSON objects, well under the response cap. */
export async function loadStoredFundamentals(): Promise<Map<string, StoredFundamentals>> {
  await ensureFundamentalsTable();
  const sql = client();
  const rows = (await sql`
    SELECT ticker, facts, fetched_at::text AS fetched_at FROM company_fundamentals
  `) as { ticker: string; facts: Fundamentals | null; fetched_at: string }[];
  return new Map(rows.map((r) => [r.ticker, { facts: r.facts, fetchedAt: r.fetched_at }]));
}

/** Store fetched facts. Null facts record "no usable SEC data" so it is not re-fetched nightly. */
export async function upsertFundamentals(
  rows: readonly { ticker: string; facts: Fundamentals | null }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureFundamentalsTable();
  const sql = client();
  let n = 0;
  for (const batch of chunk(rows, CHUNK)) {
    await sql`
      INSERT INTO company_fundamentals (ticker, facts, fetched_at)
      SELECT t.ticker, t.facts, now() FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => (r.facts == null ? null : JSON.stringify(r.facts)))}::jsonb[]
      ) AS t(ticker, facts)
      ON CONFLICT (ticker) DO UPDATE SET facts = EXCLUDED.facts, fetched_at = now()
    `;
    n += batch.length;
  }
  return n;
}

/** ticker -> CIK for the given tickers, from the reference table. */
export async function ciksFor(tickers: readonly string[]): Promise<Map<string, string>> {
  if (tickers.length === 0) return new Map();
  const sql = client();
  const rows = (await sql`
    SELECT ticker, cik FROM tickers
    WHERE ticker = ANY(${[...tickers]}::text[]) AND cik IS NOT NULL
  `) as { ticker: string; cik: string }[];
  return new Map(rows.map((r) => [r.ticker, String(r.cik).trim()]));
}
```

- [ ] **Step 6: Document the table**

Append to `db/schema.sql`:

```sql
-- EDGAR fundamentals for the fundamental gate, one row per ticker.
-- facts is lib/edgar.ts Fundamentals as JSON, or NULL for "fetched, no usable
-- SEC data" so foreign issuers are not re-fetched nightly. Rows older than
-- 7 days are re-fetched (lib/fundamentals-store.ts). Created by its consumer.
CREATE TABLE IF NOT EXISTS company_fundamentals (
  ticker     TEXT PRIMARY KEY,
  facts      JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 7: Typecheck, then smoke-test the database functions against the live database**

Run: `npm run typecheck`
Expected: no errors.

Then run this once (read plus one throwaway row, which it deletes):

```bash
npx tsx --env-file=.env.local -e "
import('./lib/db.ts').then(async (db) => {
  await db.upsertFundamentals([{ ticker: '__SMOKE__', facts: null }]);
  const m = await db.loadStoredFundamentals();
  console.log('smoke row', m.get('__SMOKE__'));
  console.log('ciks', await db.ciksFor(['NVDA', 'LITE']));
  const { neon } = await import('@neondatabase/serverless');
  await neon(process.env.DATABASE_URL)\`DELETE FROM company_fundamentals WHERE ticker = '__SMOKE__'\`;
});"
```

Expected: `smoke row { facts: null, fetchedAt: '2026-…' }` and two CIKs printed. If `-e` is not supported by the installed tsx, put the same body in a file under the session scratchpad and run it from the repo root with `npx tsx --env-file=.env.local <file>`.

- [ ] **Step 8: Commit**

```bash
git add lib/fundamentals-store.ts lib/fundamentals-store.test.ts lib/db.ts db/schema.sql
git commit -m "Store EDGAR fundamentals in the database with a 7-day refresh rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Budgeted fundamentals top-up

**Files:**
- Create: `lib/fundamentals-topup.ts`
- Test: `lib/fundamentals-topup.test.ts`

**Interfaces:**
- Consumes: `fundamentalsFor(cik: string): Promise<Fundamentals | null>` from `lib/edgar.ts`; `ciksFor`, `upsertFundamentals` from `lib/db.ts` (Task 2).
- Produces:
  - `interface TopUpDeps { ciks(tickers: readonly string[]): Promise<ReadonlyMap<string, string>>; fetch(cik: string): Promise<Fundamentals | null>; save(rows: readonly { ticker: string; facts: Fundamentals | null }[]): Promise<unknown>; now(): number }`
  - `interface TopUpResult { fetched: number; failed: string[]; remaining: number; elapsedMs: number }`
  - `TOPUP_BATCH = 5`
  - `topUpFundamentals(tickers: readonly string[], budgetMs: number, deps: TopUpDeps): Promise<TopUpResult>`
  - `defaultTopUpDeps(): TopUpDeps`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/fundamentals-topup.test.ts
import { describe, expect, it } from "vitest";
import { TOPUP_BATCH, topUpFundamentals, type TopUpDeps } from "./fundamentals-topup";
import type { Fundamentals } from "./edgar";

const F = { cik: "x" } as unknown as Fundamentals;

/** Fake deps with a clock each fetch advances by `msPerFetch`. */
function fake(opts: { msPerFetch?: number; throwFor?: string[]; noCik?: string[] } = {}) {
  let clock = 0;
  const saved: { ticker: string; facts: Fundamentals | null }[] = [];
  const fetched: string[] = [];
  const deps: TopUpDeps = {
    ciks: async (ts) =>
      new Map(ts.filter((t) => !(opts.noCik ?? []).includes(t)).map((t) => [t, `cik-${t}`])),
    fetch: async (cik) => {
      clock += opts.msPerFetch ?? 0;
      const t = cik.replace("cik-", "");
      fetched.push(t);
      if ((opts.throwFor ?? []).includes(t)) throw new Error("EDGAR 503");
      return F;
    },
    save: async (rows) => {
      saved.push(...rows);
    },
    now: () => clock,
  };
  return { deps, saved, fetched };
}

const tickers = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`);

describe("topUpFundamentals", () => {
  it("fetches and saves everything when the budget allows", async () => {
    const { deps, saved } = fake();
    const r = await topUpFundamentals(tickers(12), 60_000, deps);
    expect(r).toMatchObject({ fetched: 12, failed: [], remaining: 0 });
    expect(saved).toHaveLength(12);
  });

  it("stops starting new batches once the budget is spent", async () => {
    // Each batch of 5 costs 5s; a 7s budget allows the first two batches to start.
    const { deps, saved } = fake({ msPerFetch: 1000 });
    const r = await topUpFundamentals(tickers(20), 7_000, deps);
    expect(r.fetched).toBe(2 * TOPUP_BATCH);
    expect(r.remaining).toBe(20 - 2 * TOPUP_BATCH);
    expect(saved).toHaveLength(2 * TOPUP_BATCH);
  });

  it("does nothing with a zero budget", async () => {
    const { deps, fetched } = fake();
    const r = await topUpFundamentals(tickers(3), 0, deps);
    expect(r).toMatchObject({ fetched: 0, remaining: 3 });
    expect(fetched).toEqual([]);
  });

  it("does not store a failed fetch, and keeps going", async () => {
    const { deps, saved } = fake({ throwFor: ["T1"] });
    const r = await topUpFundamentals(tickers(3), 60_000, deps);
    expect(r.failed).toEqual(["T1"]);
    expect(r.fetched).toBe(2);
    expect(saved.map((s) => s.ticker)).toEqual(["T0", "T2"]);
  });

  it("records a name with no CIK as null facts without calling EDGAR", async () => {
    const { deps, saved, fetched } = fake({ noCik: ["T0"] });
    await topUpFundamentals(["T0"], 60_000, deps);
    expect(fetched).toEqual([]);
    expect(saved).toEqual([{ ticker: "T0", facts: null }]);
  });

  it("handles an empty list", async () => {
    const { deps } = fake();
    expect(await topUpFundamentals([], 60_000, deps)).toMatchObject({
      fetched: 0,
      failed: [],
      remaining: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/fundamentals-topup.test.ts`
Expected: FAIL, cannot resolve `./fundamentals-topup`.

- [ ] **Step 3: Implement**

```ts
// lib/fundamentals-topup.ts
/**
 * Fetch missing or stale fundamentals within a wall-clock budget.
 *
 * Shared by scripts/fundamentals.ts (no budget) and the nightly refresh
 * (bounded, so the route stays under its 300s limit). The budget is checked
 * before each batch starts, so a run can overshoot by at most one batch.
 *
 * A failed fetch is NOT stored: storing it would mark the name fresh and hide
 * the failure for a week. It stays wanted and is retried next run.
 */

import { fundamentalsFor, type Fundamentals } from "./edgar";
import { ciksFor, upsertFundamentals } from "./db";

export interface TopUpDeps {
  ciks(tickers: readonly string[]): Promise<ReadonlyMap<string, string>>;
  fetch(cik: string): Promise<Fundamentals | null>;
  save(rows: readonly { ticker: string; facts: Fundamentals | null }[]): Promise<unknown>;
  now(): number;
}

export interface TopUpResult {
  readonly fetched: number;
  readonly failed: string[];
  readonly remaining: number;
  readonly elapsedMs: number;
}

/** Matches lib/edgar.ts MAX_IN_FLIGHT, so a batch never queues behind itself. */
export const TOPUP_BATCH = 5;

export async function topUpFundamentals(
  tickers: readonly string[],
  budgetMs: number,
  deps: TopUpDeps,
): Promise<TopUpResult> {
  const started = deps.now();
  const failed: string[] = [];
  let fetched = 0;
  let i = 0;
  if (tickers.length === 0 || budgetMs <= 0) {
    return { fetched, failed, remaining: tickers.length, elapsedMs: 0 };
  }

  const ciks = await deps.ciks(tickers);
  while (i < tickers.length && deps.now() - started < budgetMs) {
    const batch = tickers.slice(i, i + TOPUP_BATCH);
    i += batch.length;
    const results = await Promise.all(
      batch.map(async (ticker) => {
        const cik = ciks.get(ticker);
        if (!cik) return { ticker, facts: null as Fundamentals | null, ok: true };
        try {
          return { ticker, facts: await deps.fetch(cik), ok: true };
        } catch {
          return { ticker, facts: null as Fundamentals | null, ok: false };
        }
      }),
    );
    const good = results.filter((r) => r.ok).map(({ ticker, facts }) => ({ ticker, facts }));
    if (good.length > 0) await deps.save(good);
    fetched += good.length;
    failed.push(...results.filter((r) => !r.ok).map((r) => r.ticker));
  }
  return { fetched, failed, remaining: tickers.length - i, elapsedMs: deps.now() - started };
}

export function defaultTopUpDeps(): TopUpDeps {
  return { ciks: ciksFor, fetch: fundamentalsFor, save: upsertFundamentals, now: Date.now };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/fundamentals-topup.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation check**

Temporarily replace `const good = results.filter((r) => r.ok)…` with `const good = results.map(({ ticker, facts }) => ({ ticker, facts }));`. Expected: "does not store a failed fetch" FAILS. Temporarily change the loop condition to `while (i < tickers.length)`. Expected: "stops starting new batches" FAILS. Revert both, rerun, confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/fundamentals-topup.ts lib/fundamentals-topup.test.ts
git commit -m "Add a budgeted fundamentals top-up that never stores a failed fetch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Band-tier memory for non-book names

**Files:**
- Modify: `lib/hysteresis.ts` (append `mergePriorTiers`)
- Modify: `lib/hysteresis.test.ts` (append tests)
- Modify: `lib/db.ts` (`previousMomentumTiers`, plus a new market band section)
- Modify: `db/schema.sql` (append)

**Interfaces:**
- Produces:
  - `mergePriorTiers(book: ReadonlyMap<string, string>, market: ReadonlyMap<string, string>): Map<string, string>`. Book wins.
  - lib/db.ts: `MARKET_BAND_KEEP_SESSIONS = 10`, `upsertMarketBandTiers(session: string, rows: readonly { ticker: string; bandTier: string | null }[]): Promise<number>`
  - `previousMomentumTiers(session)`: same signature, now returns book plus market entries.

- [ ] **Step 1: Write the failing tests**

Append to `lib/hysteresis.test.ts` (and add `mergePriorTiers` to its import from `./hysteresis`):

```ts
describe("mergePriorTiers", () => {
  it("combines book and market prior tiers", () => {
    const out = mergePriorTiers(new Map([["LITE", "Strong Buy"]]), new Map([["XOM", "Buy"]]));
    expect(out).toEqual(new Map([["XOM", "Buy"], ["LITE", "Strong Buy"]]));
  });

  it("book tier wins over market tier", () => {
    const out = mergePriorTiers(new Map([["NEW", "Hold"]]), new Map([["NEW", "Strong Buy"]]));
    expect(out.get("NEW")).toBe("Hold");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/hysteresis.test.ts`
Expected: FAIL, `mergePriorTiers` is not exported.

- [ ] **Step 3: Implement `mergePriorTiers`**

Append to `lib/hysteresis.ts`:

```ts
/**
 * Yesterday's band tiers from both stores.
 *
 * tier_history holds the AI book; market_band_tiers holds everyone else. A
 * name can appear in both after it is added to THEME, and the book's record
 * wins because it is the one the book's own band was built from.
 */
export function mergePriorTiers(
  book: ReadonlyMap<string, string>,
  market: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map(market);
  for (const [t, v] of book) out.set(t, v);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/hysteresis.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the market band table functions and the merge in `previousMomentumTiers`**

In `lib/db.ts`, add `import { mergePriorTiers } from "./hysteresis";` to the imports.

Replace the body of `previousMomentumTiers` (currently around lib/db.ts:773) with:

```ts
export async function previousMomentumTiers(session: string): Promise<Map<string, string>> {
  const sql = client();
  const prev = (await sql`
    SELECT session::text AS session FROM tier_history
    WHERE session < ${session}::date
    ORDER BY session DESC LIMIT 1
  `) as { session: string }[];
  if (prev.length === 0) return new Map();

  const rows = (await sql`
    SELECT ticker, COALESCE(momentum_tier, tier) AS tier
    FROM tier_history WHERE session = ${prev[0].session}::date
  `) as { ticker: string; tier: string | null }[];
  const book = new Map(rows.filter((r) => r.tier).map((r) => [r.ticker, r.tier as string]));

  // Non-book names live in their own table so tier_history's readers never
  // see them. Same prior session, so both halves describe the same day.
  await ensureMarketBandTiers();
  const marketRows = (await sql`
    SELECT ticker, band_tier FROM market_band_tiers WHERE session = ${prev[0].session}::date
  `) as { ticker: string; band_tier: string | null }[];
  const market = new Map(
    marketRows.filter((r) => r.band_tier).map((r) => [r.ticker, r.band_tier as string]),
  );
  return mergePriorTiers(book, market);
}
```

Append directly after it:

```ts
// ---------------------------------------------------------------------------
// Market band tiers
// ---------------------------------------------------------------------------

/** Sessions of band memory kept. Hysteresis only ever reads the previous one. */
export const MARKET_BAND_KEEP_SESSIONS = 10;

async function ensureMarketBandTiers(): Promise<void> {
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS market_band_tiers (
      session   DATE NOT NULL,
      ticker    TEXT NOT NULL,
      band_tier TEXT,
      PRIMARY KEY (session, ticker)
    )
  `;
}

/**
 * Record each non-book name's band tier for tomorrow's hysteresis, then prune.
 * Never touches tier_history.
 */
export async function upsertMarketBandTiers(
  session: string,
  rows: readonly { ticker: string; bandTier: string | null }[],
): Promise<number> {
  await ensureMarketBandTiers();
  const sql = client();
  let n = 0;
  for (const batch of chunk(rows, CHUNK)) {
    await sql`
      INSERT INTO market_band_tiers (session, ticker, band_tier)
      SELECT ${session}::date, * FROM UNNEST(
        ${batch.map((r) => r.ticker)}::text[],
        ${batch.map((r) => r.bandTier)}::text[]
      ) AS t(ticker, band_tier)
      ON CONFLICT (session, ticker) DO UPDATE SET band_tier = EXCLUDED.band_tier
    `;
    n += batch.length;
  }
  await sql`
    DELETE FROM market_band_tiers WHERE session < (
      SELECT min(session) FROM (
        SELECT DISTINCT session FROM market_band_tiers
        ORDER BY session DESC LIMIT ${MARKET_BAND_KEEP_SESSIONS}
      ) recent
    )
  `;
  return n;
}
```

- [ ] **Step 6: Document the table**

Append to `db/schema.sql`:

```sql
-- Yesterday's hysteresis band tier for every ranked name OUTSIDE the AI book.
-- Kept apart from tier_history on purpose: tier_history feeds alerts, the
-- replay guard, turnover stats, the cohort view and the backtest, and none of
-- them should see market-wide rows. Pruned to the last 10 sessions.
CREATE TABLE IF NOT EXISTS market_band_tiers (
  session   DATE NOT NULL,
  ticker    TEXT NOT NULL,
  band_tier TEXT,
  PRIMARY KEY (session, ticker)
);
```

- [ ] **Step 7: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/hysteresis.ts lib/hysteresis.test.ts lib/db.ts db/schema.sql
git commit -m "Remember band tiers for non-book names outside tier_history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Market rows and the book split

**Files:**
- Create: `lib/market-rows.ts`
- Test: `lib/market-rows.test.ts`

**Interfaces:**
- Consumes: `groupOf`, `GroupKind` (Task 1); `TrendFields` from `lib/trend-overlay.ts`; `StageFields` from `lib/stage-overlay.ts`; `HysteresisFields` from `lib/hysteresis.ts`; `GateFields`, `GateVerdict` from `lib/fundamental-gate.ts`; `HealthFields` from `lib/health-overlay.ts`; `Stage` from `lib/trend-template.ts`; `SectorLabels` from `lib/sic.ts`.
- Produces:
  - `type GuardedRow = ScreenRow & TrendFields & StageFields & HysteresisFields & GateFields & HealthFields`
  - `interface MarketRow` (fields listed in Step 3)
  - `heldDownReasons(r: GuardedRow): string[]`
  - `toMarketRow(r: GuardedRow, labels: SectorLabels | undefined, book: { inBook: boolean; bookCapped: boolean }): MarketRow`
  - `splitBook<T extends ScreenRow>(rows: readonly T[], theme: ReadonlyMap<string, string>): T[]`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/market-rows.test.ts
import { describe, expect, it } from "vitest";
import { heldDownReasons, splitBook, toMarketRow, type GuardedRow } from "./market-rows";
import { capStrongBuy } from "./strong-buy-cap";
import { themeUniverse } from "./theme";

function g(over: Partial<GuardedRow> = {}): GuardedRow {
  return {
    ticker: "T",
    name: "Test",
    sector: "",
    price: 100,
    dollarVolume: 5e7,
    r1m: 1,
    r3m: 20,
    r6m: 40,
    r12m: 80,
    maProxy: 80,
    vsMa: 25,
    rsRaw: 40,
    rsPct: 90,
    tier: "Strong Buy",
    weight: 0.0743,
    trend: null,
    stage: null,
    stageCapped: false,
    stageReason: "",
    held: false,
    bandTier: "Strong Buy",
    momentumTier: "Strong Buy",
    gate: "pass",
    gateReason: "",
    health: null,
    healthCapped: false,
    healthReason: "",
    ...over,
  };
}

describe("heldDownReasons", () => {
  it("lists stage, gate and health reasons in pipeline order", () => {
    const out = heldDownReasons(
      g({
        stageCapped: true,
        stageReason: "Stage 3 (topping)",
        gate: "demote",
        gateReason: "revenue growth decelerating 2.0pp",
        healthCapped: true,
        healthReason: "shares +42% in a year (limit 30%)",
      }),
    );
    expect(out).toEqual([
      "Stage 3 (topping)",
      "Momentum Strong Buy, held at Buy — revenue growth decelerating 2.0pp",
      "shares +42% in a year (limit 30%)",
    ]);
  });

  it("ignores a demote verdict on a name that was not a momentum Strong Buy", () => {
    expect(heldDownReasons(g({ momentumTier: "Buy", gate: "demote", gateReason: "x" }))).toEqual([]);
  });
});

describe("toMarketRow", () => {
  it("carries group, badge, book flags and SIC labels", () => {
    const m = toMarketRow(g({ ticker: "MU" }), { sector: "Semiconductors", subsector: "Semis" }, {
      inBook: false,
      bookCapped: false,
    });
    expect(m).toMatchObject({
      ticker: "MU",
      group: "Memory & storage",
      groupKind: "ai_theme",
      badge: "crowding veto: memory/storage",
      sector: "Semiconductors",
      subsector: "Semis",
      inBook: false,
      bookCapped: false,
      bandTier: "Strong Buy",
      gate: "pass",
    });
  });

  it("labels an unclassified filer the same way the old leaders table did", () => {
    const m = toMarketRow(g({ ticker: "ZZZZ" }), undefined, { inBook: false, bookCapped: false });
    expect(m).toMatchObject({ group: "Unclassified", sector: "Other", subsector: "Unclassified" });
  });
});

describe("the cap applies to the book only", () => {
  // 30 real theme members and 30 non-theme names, all qualifying Strong Buys,
  // plus one spender and one vetoed name that also qualify.
  const theme = themeUniverse();
  const aiTickers = [...theme.keys()].slice(0, 30);
  const rows: GuardedRow[] = [
    ...aiTickers.map((t, i) => g({ ticker: t, rsPct: 99 - i * 0.1 })),
    ...Array.from({ length: 30 }, (_, i) => g({ ticker: `X${i}`, rsPct: 98 - i * 0.1 })),
    g({ ticker: "MSFT", rsPct: 99.9 }),
    g({ ticker: "MU", rsPct: 99.8 }),
  ];

  it("leaves every qualifying market row a Strong Buy", () => {
    expect(rows.filter((r) => r.tier === "Strong Buy")).toHaveLength(62);
  });

  it("caps the book at 10 and keeps spenders and vetoed names out of it", () => {
    const book = capStrongBuy(splitBook(rows, theme), 10);
    expect(book).toHaveLength(30);
    expect(book.filter((r) => r.tier === "Strong Buy")).toHaveLength(10);
    expect(book.map((r) => r.ticker)).not.toContain("MSFT");
    expect(book.map((r) => r.ticker)).not.toContain("MU");
  });

  it("derives the book from the market rows: same pre-cap tier, theme sector set", () => {
    const book = splitBook(rows, theme);
    for (const b of book) {
      const m = rows.find((r) => r.ticker === b.ticker);
      expect(b.tier).toBe(m?.tier);
      expect(b.sector).toBe(theme.get(b.ticker));
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/market-rows.test.ts`
Expected: FAIL, cannot resolve `./market-rows`.

- [ ] **Step 3: Implement**

```ts
// lib/market-rows.ts
/**
 * The market-wide row, and the AI book as a filter of the same rows.
 *
 * Every ranked name runs the same overlays. The book is not computed
 * separately -- splitBook filters the overlaid rows -- so a tier means the same
 * thing in the grouped view and in the book, except for the 10-slot cap, which
 * only the book applies.
 */

import { groupOf, type GroupKind } from "./groups";
import type { TrendFields } from "./trend-overlay";
import type { StageFields } from "./stage-overlay";
import type { HysteresisFields } from "./hysteresis";
import type { GateFields, GateVerdict } from "./fundamental-gate";
import type { HealthFields } from "./health-overlay";
import type { Stage } from "./trend-template";
import type { SectorLabels } from "./sic";
import type { ScreenRow, Tier } from "./types";

/** A ranked row after every overlay and before the cap. */
export type GuardedRow = ScreenRow &
  TrendFields &
  StageFields &
  HysteresisFields &
  GateFields &
  HealthFields;

/** Trimmed for transport: ~2,300 of these go to the browser. */
export interface MarketRow {
  readonly ticker: string;
  readonly name: string;
  readonly group: string;
  readonly groupKind: GroupKind;
  readonly badge: string | null;
  /** SIC sector and subsector, kept for the ticker detail and the health script. */
  readonly sector: string;
  readonly subsector: string;
  readonly price: number;
  readonly dollarVolume: number;
  readonly r3m: number;
  readonly r12m: number;
  readonly rsPct: number | null;
  readonly vsMa: number;
  /** Final tier after every overlay, with no Strong Buy cap. */
  readonly tier: Tier | null;
  /** Tier after the band and before the overlays; tomorrow's hysteresis input. */
  readonly bandTier: Tier | null;
  readonly stage: Stage | null;
  readonly gate: GateVerdict;
  readonly heldDown: readonly string[];
  /** In the AI book (theme member, not a spender, not vetoed). */
  readonly inBook: boolean;
  /** A book Strong Buy that the 10-slot cap moved to Buy. */
  readonly bookCapped: boolean;
}

export function heldDownReasons(r: GuardedRow): string[] {
  const out: string[] = [];
  if (r.stageCapped && r.stageReason) out.push(r.stageReason);
  if (r.momentumTier === "Strong Buy" && r.gate === "demote") {
    out.push(`Momentum Strong Buy, held at Buy — ${r.gateReason}`);
  }
  if (r.healthCapped && r.healthReason) out.push(r.healthReason);
  return out;
}

export function toMarketRow(
  r: GuardedRow,
  labels: SectorLabels | undefined,
  book: { inBook: boolean; bookCapped: boolean },
): MarketRow {
  const group = groupOf(r.ticker, labels);
  return {
    ticker: r.ticker,
    name: r.name,
    group: group.name,
    groupKind: group.kind,
    badge: group.badge,
    sector: labels?.sector ?? "Other",
    subsector: labels?.subsector ?? "Unclassified",
    price: r.price,
    dollarVolume: r.dollarVolume,
    r3m: r.r3m,
    r12m: r.r12m,
    rsPct: r.rsPct,
    vsMa: r.vsMa,
    tier: r.tier,
    bandTier: r.bandTier,
    stage: r.stage?.stage ?? null,
    gate: r.gate,
    heldDown: heldDownReasons(r),
    inBook: book.inBook,
    bookCapped: book.bookCapped,
  };
}

/** The AI book: rows whose ticker is in `theme`, with the theme sector set. Order preserved. */
export function splitBook<T extends ScreenRow>(
  rows: readonly T[],
  theme: ReadonlyMap<string, string>,
): T[] {
  return rows
    .filter((r) => theme.has(r.ticker))
    .map((r) => ({ ...r, sector: theme.get(r.ticker) as string }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/market-rows.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation check**

Temporarily change `splitBook`'s filter to `.filter(() => true)`. Expected: "caps the book at 10 and keeps spenders and vetoed names out" FAILS. Revert, rerun, confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/market-rows.ts lib/market-rows.test.ts
git commit -m "Add the market row shape and derive the AI book by filtering it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Run the pipeline over the whole market

**Files:**
- Create: `scripts/book-snapshot.ts`
- Modify: `package.json` (scripts)
- Modify: `lib/screen-service.ts`
- Modify: `scripts/health.ts:362,380`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces, on `ScreenPayload`:
  - `market: readonly MarketRow[]` (replaces `leaders`)
  - `marketClassified: number` (replaces `leadersClassified`)
  - `fundamentalsWanted: readonly string[]`
  - `meta.fundamentalsUnverified: number`
  - `themed`, `portfolio` and every existing counter unchanged in meaning (book-scoped).

- [ ] **Step 1: Write the snapshot script and capture the BEFORE baseline**

```ts
// scripts/book-snapshot.ts
/**
 * Print the AI book's tiers and the screen's timing as JSON.
 *
 *   npm run book:snapshot > before.json
 *
 * Used to prove a pipeline change leaves the book alone: capture before and
 * after on the same asOf and diff. Each run is a fresh process, so elapsedMs
 * is a cold-start figure.
 */

import { getScreen } from "../lib/screen-service";

async function main(): Promise<void> {
  const s = await getScreen(true);
  const payload = s as unknown as Record<string, unknown>;
  const market = (payload.market ?? payload.leaders) as unknown[];
  console.log(
    JSON.stringify(
      {
        asOf: s.asOf,
        elapsedMs: s.meta.elapsedMs,
        warnings: s.meta.warnings,
        marketRows: market.length,
        marketBytes: JSON.stringify(market).length,
        counters: {
          demoted: s.demoted,
          capped: s.capped,
          capHeld: s.capHeld,
          healthCapped: s.healthCapped,
          stageDemoted: s.stageDemoted,
          held: s.held,
        },
        book: s.themed.map((r) => ({ ticker: r.ticker, tier: r.tier, bandTier: r.bandTier })),
        portfolio: s.portfolio.map((r) => r.ticker),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `package.json` scripts: `"book:snapshot": "tsx --env-file=.env.local scripts/book-snapshot.ts",`

Run, before touching `lib/screen-service.ts`, saving the output outside the repo:

```bash
npm run --silent book:snapshot > "$SCRATCH/book-before.json"
```

(`$SCRATCH` is the session scratchpad directory.) Expected: JSON with `book` of about 108 rows and `asOf` = the latest stored session. Keep this file. Task 8 compares against it.

- [ ] **Step 2: Swap the imports in `lib/screen-service.ts`**

Replace the line `import { fundamentalsFor, type Fundamentals } from "./edgar";` with:

```ts
import { usableFundamentals, wantedFundamentals, type StoredFundamentals } from "./fundamentals-store";
import { splitBook, toMarketRow, type MarketRow } from "./market-rows";
```

Add `loadStoredFundamentals,` to the existing `from "./db"` import list. In the `./sic` import, change `import { classify, type SectorLabels } from "./sic";` to `import type { SectorLabels } from "./sic";` (the `classify` call was only used by the leaders block).

- [ ] **Step 3: Replace the live EDGAR fetch with the stored loader**

Delete the whole block from the doc comment `/**\n * Fundamentals for the names the gate can actually act on.` through the end of `fundamentalsForCandidates` (the `fundamentalCache` constant and the function). Put this in its place:

```ts
/**
 * Stored fundamentals, empty without a database.
 *
 * Never live EDGAR: ~400 market-wide Strong Buy candidates cannot be fetched
 * inside a 60s request. The nightly refresh and scripts/fundamentals.ts fill
 * the table. A failure here is a warning; the gate then reads every candidate
 * as unverified, which demotes nothing.
 */
async function storedFundamentals(warnings: string[]): Promise<Map<string, StoredFundamentals>> {
  if (!dbConfigured()) return new Map();
  try {
    return await loadStoredFundamentals();
  } catch (e) {
    warnings.push(`fundamentals: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}
```

- [ ] **Step 4: Replace `LeaderRow` and the payload fields**

Delete the `LeaderRow` interface and its doc comment. In `ScreenPayload`, replace the `leaders` and `leadersClassified` fields (and their doc comments) with:

```ts
  /**
   * Every ranked name in the liquid universe, under the full ruleset, grouped
   * for display. Tiers here have NO Strong Buy cap; the cap is a property of
   * the AI book (`themed`), not of the market.
   */
  readonly market: readonly MarketRow[];
  /** How many market rows carry a real SIC classification. */
  readonly marketClassified: number;
  /** Strong Buy candidates whose stored fundamentals are missing or stale. */
  readonly fundamentalsWanted: readonly string[];
```

In `meta`, after `fundamentalsChecked`, add:

```ts
    /** Market-wide momentum Strong Buys the gate could not judge (no stored facts yet). */
    readonly fundamentalsUnverified: number;
```

- [ ] **Step 5: Replace the pipeline block in `computeScreen`**

Change `const { ranked, themed, universeSize } = runScreen({` to `const { ranked, universeSize } = runScreen({`.

Replace everything from the comment `// True moving averages FIRST: they change vsMa, which re-decides the tier,` down to and including `const portfolio = buildPortfolio(limited, SCREEN_PARAMS);` with the block below. The health/splits loading in the middle is unchanged and is repeated here so the block is complete:

```ts
  // Every ranked name runs the full ruleset; the AI book is a filter of the
  // same rows (lib/market-rows.ts). True moving averages FIRST: they change
  // vsMa, which re-decides the tier, which decides who the gate considers.
  const rankedTickers = ranked.map((r) => r.ticker);
  const history = await loadHistory(rankedTickers, warnings);
  const withMa = applyTrueMa(ranked, history);
  const trended = applyHysteresis(withMa, priorTiers as ReadonlyMap<string, Tier>);

  // Stage needs the trend history, and the stage rule must run before the
  // fundamental gate and the cap: a topping name should not consume one of the
  // ten Strong Buy slots on its way down.
  const trendBars = await loadTrendBars(rankedTickers, warnings);
  const staged = applyTrend(trended, trendBars);
  const stageRuled = applyStageRule(staged);

  // Fundamental overlay from the nightly store. Candidates are the names the
  // gate can act on: Strong Buys after the stage rule.
  const stored = await storedFundamentals(warnings);
  const fundamentals = usableFundamentals(stored);
  const candidates = stageRuled.filter((r) => r.tier === "Strong Buy").map((r) => r.ticker);
  const fundamentalsWanted = wantedFundamentals(
    candidates,
    new Map([...stored].map(([t, s]) => [t, s.fetchedAt])),
    new Date(),
  );
  const overlaid = applyFundamentalOverlay(stageRuled, fundamentals);

  // Balance-sheet guardrails run BEFORE the cap, for the same reason the stage
  // rule does: a name that is about to be capped at Hold must not consume one
  // of the ten Strong Buy slots on its way down.
  const [healthFacts, splits] = dbConfigured()
    ? await Promise.all([
        companyHealth().catch((e: unknown) => {
          warnings.push(`company health: ${e instanceof Error ? e.message : String(e)}`);
          return new Map<string, HealthFacts>();
        }),
        splitHistory().catch((e: unknown) => {
          warnings.push(`splits: ${e instanceof Error ? e.message : String(e)}`);
          return new Map<string, Split[]>();
        }),
      ])
    : [new Map<string, HealthFacts>(), new Map<string, Split[]>()];
  const guarded = applyHealth(overlaid, healthFacts, splits);

  // The AI book: theme members minus spenders and the crowding veto, restricted
  // to the liquid universe exactly as runScreen restricted `themed`. Only the
  // book is capped.
  const bookTheme = themeUniverse({ restrictTo: new Set(liquid.keys()) });
  const inBook = <T extends ScreenRow>(rows: readonly T[]) => splitBook(rows, bookTheme);
  const limited = capStrongBuy(inBook(guarded), STRONG_BUY_LIMIT, undefined, incumbents);
  const bookCapped = new Set(limited.filter((r) => r.capped).map((r) => r.ticker));

  // The book is selected from the FINAL tiers. runScreen also returns a
  // portfolio, but it is built from the raw momentum tiers before the
  // overlays above re-decide them.
  const portfolio = buildPortfolio(limited, SCREEN_PARAMS);
```

Then delete the line `const themeTickers = new Set(themed.map((r) => r.ticker));`.

- [ ] **Step 6: Keep every book counter book-scoped and emit the market rows**

In the returned object:

- `demoted: demotedCount(overlaid),` → `demoted: demotedCount(inBook(overlaid)),`
- `stageDemoted: stageDemotedCount(stageRuled),` → `stageDemoted: stageDemotedCount(inBook(stageRuled)),`
- `held: heldCount(trended),` → `held: heldCount(inBook(trended)),`
- in `meta`: `trueMaRows: trueMaCount(trended),` → `trueMaRows: trueMaCount(inBook(trended)),` and `trendScored: trendScoredCount(staged),` → `trendScored: trendScoredCount(inBook(staged)),`
- in `meta`: `fundamentalsChecked: fundamentals.size,` → `fundamentalsChecked: candidates.filter((t) => fundamentals.has(t)).length,` and add after it:

```ts
      fundamentalsUnverified: guarded.filter(
        (r) => r.momentumTier === "Strong Buy" && r.gate === "unverified",
      ).length,
```

Replace the whole `leaders: ranked.map(...)` property and the `leadersClassified:` line with:

```ts
    market: guarded.map((r) =>
      toMarketRow(r, sectors.get(r.ticker), {
        inBook: bookTheme.has(r.ticker),
        bookCapped: bookCapped.has(r.ticker),
      }),
    ),
    marketClassified: ranked.filter((r) => sectors.has(r.ticker)).length,
    fundamentalsWanted,
```

If `trueMaCount` or `trendScoredCount` reject the `inBook(...)` argument type, check their signatures in `lib/moving-average.ts` and `lib/trend-overlay.ts`. They take row arrays, so `inBook` (which preserves the element type) should satisfy them.

- [ ] **Step 7: Update the health script**

In `scripts/health.ts`, replace both occurrences of `screen.leaders` (lines ~362 and ~380) with `screen.market`.

- [ ] **Step 8: Typecheck, lint, test**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. `app/leaders-table.tsx` will fail typecheck because `data.leaders` is gone. For this task only, make it compile by changing `const all = data.leaders;` to `const all = data.market;` and `data.leadersClassified` to `data.marketClassified`. Task 9 deletes the file.

- [ ] **Step 9: Commit**

```bash
git add lib/screen-service.ts scripts/health.ts scripts/book-snapshot.ts package.json app/leaders-table.tsx
git commit -m "Run the full tier ruleset over every ranked name and derive the book from it

Fundamentals now come from company_fundamentals instead of live EDGAR.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Backfill script and nightly wiring

**Files:**
- Create: `scripts/fundamentals.ts`
- Modify: `package.json`
- Modify: `app/api/refresh/route.ts`

**Interfaces:**
- Consumes: `ScreenPayload.fundamentalsWanted`, `ScreenPayload.market` (Task 6); `topUpFundamentals`, `defaultTopUpDeps` (Task 3); `upsertMarketBandTiers` (Task 4).
- Produces: `npm run fundamentals [-- --limit N]`; refresh response gains `marketBand` and `fundamentals` objects.

- [ ] **Step 1: Write the backfill script**

```ts
// scripts/fundamentals.ts
/**
 * Fill company_fundamentals for every market-wide Strong Buy candidate whose
 * stored facts are missing or older than 7 days.
 *
 *   npm run fundamentals                 # everything wanted, no time budget
 *   npm run fundamentals -- --limit 50   # trial
 *
 * Resumable by set difference: re-running fetches only what is still wanted.
 * Run it BEFORE deploying the market-wide screen, or the AI book's Strong Buys
 * read as unverified and the gate demotes nothing.
 */

import { getScreen } from "../lib/screen-service";
import { defaultTopUpDeps, topUpFundamentals } from "../lib/fundamentals-topup";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

async function main(): Promise<void> {
  const screen = await getScreen(true);
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const all = screen.fundamentalsWanted;
  const wanted = Number.isFinite(limit) ? all.slice(0, limit) : [...all];
  console.log(`${all.length} candidates missing or stale; fetching ${wanted.length}`);

  const r = await topUpFundamentals(wanted, Number.POSITIVE_INFINITY, defaultTopUpDeps());
  const perFetch = r.fetched > 0 ? Math.round(r.elapsedMs / r.fetched) : null;
  console.log(
    `fetched ${r.fetched}, failed ${r.failed.length}, remaining ${r.remaining}, ` +
      `${(r.elapsedMs / 1000).toFixed(1)}s (${perFetch ?? "--"} ms per fetch)`,
  );
  if (r.failed.length) console.log(`failed: ${r.failed.join(" ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `package.json` scripts: `"fundamentals": "tsx --env-file=.env.local scripts/fundamentals.ts",`

- [ ] **Step 2: Trial run, then measure throughput at both ends**

Run: `npm run fundamentals -- --limit 10`
Expected: `fetched 10` (or fewer with listed failures) and a ms-per-fetch figure.

Then run the full backfill: `npm run fundamentals`
Expected: completes; `remaining 0`. Record the ms per fetch from both runs. If the two figures differ by more than 2×, note it. The budget calculation in Step 3 uses the slower figure.

Run `npm run fundamentals` a second time. Expected: `0 candidates missing or stale; fetching 0`. This proves resume by set difference.

- [ ] **Step 3: Pick the nightly budget from measured refresh durations**

Run this read-only query (scratch script, as in Task 2 Step 7):

```sql
SELECT count(*) AS runs,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)) AS p95_s,
       max(extract(epoch FROM finished_at - started_at)) AS max_s
FROM refresh_runs
WHERE kind = 'nightly' AND ok AND finished_at IS NOT NULL
  AND started_at > now() - interval '45 days';
```

Budget seconds = `min(60, 300 - max_s - 60)`, floored at 0. The extra 60s covers the market-band write and one overshooting batch. If the query returns fewer than 10 runs, use 30s and say so in the constant's comment. Record `runs`, `p95_s`, `max_s` and the chosen budget for the commit message.

- [ ] **Step 4: Wire the refresh route**

Read `node_modules/next/dist/docs/` for route handlers before editing (AGENTS.md).

In `app/api/refresh/route.ts`, add `upsertMarketBandTiers,` to the `@/lib/db` import and add:

```ts
import { defaultTopUpDeps, topUpFundamentals } from "@/lib/fundamentals-topup";
```

Below `MAX_REFETCH_PER_RUN`, add (replace `<BUDGET>` and the measurement line with the Step 3 numbers):

```ts
/**
 * Wall-clock budget for the nightly fundamentals top-up.
 *
 * Chosen from measured refresh durations: <runs> nightly runs, p95 <p95_s>s,
 * max <max_s>s, against the 300s limit with 60s spare. Whatever does not fit
 * is still wanted tomorrow -- the work list is a set difference, not a cursor.
 */
const FUNDAMENTALS_BUDGET_MS = <BUDGET> * 1000;
```

Directly after `const snapshotted = await upsertTierHistory(screen.asOf, tierRows);` add:

```ts
    // Band memory for every non-book name, so tomorrow's hysteresis works
    // market-wide. Kept out of tier_history; see db/schema.sql. A failure here
    // costs one night of band memory, not the refresh.
    let marketBand: Record<string, unknown>;
    try {
      marketBand = {
        written: await upsertMarketBandTiers(
          screen.asOf,
          screen.market
            .filter((r) => !r.inBook)
            .map((r) => ({ ticker: r.ticker, bandTier: r.bandTier })),
        ),
      };
    } catch (e) {
      marketBand = { error: e instanceof Error ? e.message : String(e) };
    }
```

Directly before `await finishRun(runId, sessionsAdded, barsAdded, true);` add:

```ts
    // Fundamentals top-up, bounded. Feeds the NEXT screen; today's already ran.
    let fundamentals: Record<string, unknown>;
    try {
      const r = await topUpFundamentals(
        screen.fundamentalsWanted,
        FUNDAMENTALS_BUDGET_MS,
        defaultTopUpDeps(),
      );
      fundamentals = {
        wanted: screen.fundamentalsWanted.length,
        fetched: r.fetched,
        failed: r.failed.length,
        remaining: r.remaining,
        elapsedMs: r.elapsedMs,
      };
    } catch (e) {
      fundamentals = { error: e instanceof Error ? e.message : String(e) };
    }
```

Add `marketBand,` and `fundamentals,` to the `NextResponse.json({...})` object after `tierChanges: changes.length,`.

- [ ] **Step 5: Typecheck, lint, test**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/fundamentals.ts package.json app/api/refresh/route.ts
git commit -m "Backfill fundamentals and top them up nightly within a measured budget

Budget from <runs> nightly runs: p95 <p95_s>s, max <max_s>s -> <BUDGET>s.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Prove the book is unchanged and the screen fits its limit

**Files:**
- Possibly modify: `app/api/screen/route.ts:15`

- [ ] **Step 1: Capture the AFTER snapshot twice (two cold processes)**

```bash
npm run --silent book:snapshot > "$SCRATCH/book-after-1.json"
npm run --silent book:snapshot > "$SCRATCH/book-after-2.json"
```

- [ ] **Step 2: Diff the book**

Confirm `asOf` matches `book-before.json`. If a refresh stored a new session in between, the comparison is invalid. Re-capture the baseline from the pre-change commit instead:

```bash
git worktree add "$SCRATCH/before" <commit before Task 6>
cp .env.local "$SCRATCH/before/" && (cd "$SCRATCH/before" && npm ci && npm run --silent book:snapshot > "$SCRATCH/book-before.json")
```

The baseline commit does not have `book:snapshot`. Copy `scripts/book-snapshot.ts` into the worktree and run it with `npx tsx --env-file=.env.local scripts/book-snapshot.ts`.

Then diff the `book`, `portfolio` and `counters` keys:

```bash
node -e "
const a=require(process.argv[1]), b=require(process.argv[2]);
for (const k of ['book','portfolio','counters']) console.log(k, JSON.stringify(a[k])===JSON.stringify(b[k]) ? 'IDENTICAL' : 'DIFFERENT');
" "$SCRATCH/book-before.json" "$SCRATCH/book-after-1.json"
```

Expected: all three `IDENTICAL`. If any differs, stop and diagnose before continuing. The likely causes are a fundamental that was fetched live before but failed or is missing in the store (check `npm run fundamentals` failures), or a counter still computed over market rows.

- [ ] **Step 3: Check the warnings and timing**

From both after-files: `warnings` must not contain new entries compared with before. Record `elapsedMs` from both runs and `marketBytes`.

- If either cold `elapsedMs` > 40,000: change `export const maxDuration = 60;` to `export const maxDuration = 300;` in `app/api/screen/route.ts` (read the route segment config guide in `node_modules/next/dist/docs/` first), and say so in the commit.
- If `marketBytes` > 2,000,000: stop and report. The browser payload would need trimming, which this plan does not cover.

Then measure the two enlarged history loads directly. These are single Neon responses capped at 64MB, and the spec's threshold is 32MB. Run from the repo root as a scratch script with `npx tsx --env-file=.env.local <file>`:

```ts
import { getScreen } from "./lib/screen-service";
import { loadCloseHistory, loadTrendHistory } from "./lib/db";

const s = await getScreen(true);
const tickers = s.market.map((r) => r.ticker);
for (const [label, load] of [
  ["close", () => loadCloseHistory(200, tickers)],
  ["trend", () => loadTrendHistory(252, tickers)],
] as const) {
  const t = Date.now();
  const m = await load();
  const bytes = JSON.stringify([...m]).length;
  console.log(label, tickers.length, "tickers", (bytes / 1e6).toFixed(1), "MB", Date.now() - t, "ms");
}
```

Expected: both under 32MB. If either is over, stop and report. Chunking the ticker list in `loadCloseHistory` and `loadTrendHistory` is the fix, but it is not specified here.

- [ ] **Step 4: Commit (only if Step 3 changed the route)**

```bash
git add app/api/screen/route.ts
git commit -m "Raise the screen route limit for the market-wide pipeline

Cold computeScreen measured at <a>ms and <b>ms.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Deploy order (record in the PR description)**

1. `npm run fundamentals` against production (already done in Task 7 Step 2: same database).
2. Deploy.
3. The next nightly refresh writes the first `market_band_tiers` session. Until then non-book names have no band memory, so for one night they get plain cutoffs. This is expected.

---

### Task 9: Grouped view

**Files:**
- Create: `app/market-groups.tsx`
- Delete: `app/leaders-table.tsx`
- Modify: `app/page.tsx` (import, usage near line 294, comment)
- Modify: `app/globals.css` (append)

**Interfaces:**
- Consumes: `ScreenPayload.market`, `ScreenPayload.marketClassified`, `ScreenPayload.meta.fundamentalsUnverified`; `summariseGroups`, `filterAndGroup`, `KindFilter`, `TierFilter` from `lib/groups.ts`; `MarketRow` from `lib/market-rows.ts`; `usePersistedState(key, initial, isValid)` from `app/use-persisted-state.ts`; `MISSING`, `num`, `pct`, `railWidth`, `signClass` from `lib/format.ts`.

- [ ] **Step 1: Read the Next.js client component guide**

Read the client components page under `node_modules/next/dist/docs/` (search for `use client`) before writing the component.

- [ ] **Step 2: Write the component**

```tsx
// app/market-groups.tsx
"use client";

import { useMemo } from "react";
import {
  filterAndGroup,
  summariseGroups,
  type KindFilter,
  type TierFilter,
} from "@/lib/groups";
import { DEFAULT_PARAMS } from "@/lib/params";
import { MISSING, num, pct, railWidth, signClass } from "@/lib/format";
import { usePersistedState } from "./use-persisted-state";
import type { MarketRow } from "@/lib/market-rows";
import type { ScreenPayload } from "@/lib/screen-service";

/**
 * Every ranked name, grouped: AI themes, AI spenders, then SIC sectors.
 *
 * Same ranking as the AI book above -- percentiles are computed once across the
 * whole liquid universe -- and the same ruleset, with one difference: no
 * Strong Buy cap. Every name that clears every rule shows as Strong Buy here.
 * The cap is a property of the book, and a capped book name says so.
 */

const PREVIEW = 25;
const STRONG_CUT = DEFAULT_PARAMS.strongRs;
const BUY_CUT = DEFAULT_PARAMS.buyRs;

const KINDS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All groups" },
  { key: "ai", label: "AI themes" },
  { key: "sector", label: "Sectors" },
];
const TIER_FILTERS: TierFilter[] = ["all", "Strong Buy", "Buy", "Hold"];

const isKind = (v: unknown): v is KindFilter => v === "all" || v === "ai" || v === "sector";
const isTier = (v: unknown): v is TierFilter =>
  typeof v === "string" && (TIER_FILTERS as string[]).includes(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const slug = (s: string) => `g-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function tierClass(r: MarketRow): string {
  if (r.vsMa < 0) return "t-below";
  if (r.tier === "Strong Buy") return "t-strong";
  if (r.tier === "Buy") return "t-buy";
  return "t-hold";
}

function stageLabel(s: MarketRow["stage"]): string {
  if (s == null) return MISSING;
  return s === "Transitional" ? "T" : String(s);
}

function notes(r: MarketRow): string[] {
  const out = [...r.heldDown];
  if (r.bookCapped) out.push("Buy in the AI book — outside its top 10");
  if (r.tier === "Strong Buy" && r.gate === "unverified") out.push("Fundamentals not yet checked");
  return out;
}

function toggle(list: string[], set: (v: string[]) => void, v: string) {
  set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
}

export default function MarketGroups({ data }: { data: ScreenPayload }) {
  const [kind, setKind] = usePersistedState<KindFilter>("groups.kind", "all", isKind);
  const [tier, setTier] = usePersistedState<TierFilter>("groups.tier", "all", isTier);
  const [query, setQuery] = usePersistedState<string>("groups.query", "", isString);
  const [expanded, setExpanded] = usePersistedState<string[]>("groups.expanded", [], isStringArray);
  const [collapsed, setCollapsed] = usePersistedState<string[]>("groups.collapsed", [], isStringArray);

  const all = data.market;
  // Group order comes from the unfiltered rows, so filtering never reshuffles groups.
  const stats = useMemo(() => summariseGroups(all), [all]);
  const groups = useMemo(
    () => filterAndGroup(all, { kind, tier, query }, stats),
    [all, kind, tier, query, stats],
  );
  const shownRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const unclassified = all.length - data.marketClassified;
  const unverified = data.meta.fundamentalsUnverified;

  return (
    <section className="leaders">
      <header className="leaders-head">
        <h2>Whole market by group</h2>
        <p className="subtitle">
          All {all.length.toLocaleString()} liquid US names under the same rules as the AI
          book, grouped by AI theme and then by industry sector. RS is the same
          market-wide percentile everywhere. There is no Strong Buy limit here: every name
          that clears every rule is a Strong Buy.
        </p>
        {unverified > 0 && (
          <p className="note">
            {unverified.toLocaleString()} Strong Buy candidates have no stored fundamentals
            yet and keep their momentum tier. The nightly refresh fills these in; run{" "}
            <code>npm run fundamentals</code> to do it now.
          </p>
        )}
        {unclassified > 0 && (
          <p className="note">
            {unclassified.toLocaleString()} names have no SEC classification and sit under{" "}
            <strong>Unclassified</strong> or <strong>Other</strong>. Run{" "}
            <code>npm run sectors</code> to fill them in.
          </p>
        )}
      </header>

      <div className="sector-stats" role="table" aria-label="Groups ranked by median relative strength">
        <div className="ss-head mg-stats" role="row">
          <span role="columnheader">Group</span>
          <span role="columnheader">Names</span>
          <span role="columnheader">Median RS</span>
          <span role="columnheader">SB / B / H</span>
        </div>
        {stats.map((s) => (
          <a key={s.name} className="ss-row mg-stats" role="row" href={`#${slug(s.name)}`}>
            <span role="cell" className="ss-name">
              {s.name}
              {s.kind !== "sector" && <span className="mg-kind">AI</span>}
            </span>
            <span role="cell" className="num">{s.count}</span>
            <span role="cell" className="num">
              {s.medianRs == null ? MISSING : Math.round(s.medianRs)}
            </span>
            <span role="cell" className="num">
              {s.strongBuy} / {s.buy} / {s.hold}
            </span>
            <span className="ss-bar" aria-hidden="true">
              <span
                className="ss-fill"
                style={{
                  width: `${s.medianRs ?? 0}%`,
                  background:
                    (s.medianRs ?? 0) >= STRONG_CUT
                      ? "var(--cool-strong)"
                      : (s.medianRs ?? 0) >= BUY_CUT
                        ? "var(--cool-mid)"
                        : "var(--muted)",
                }}
              />
            </span>
          </a>
        ))}
      </div>

      <div className="controls">
        <span className="ctl-label">Show</span>
        {KINDS.map((k) => (
          <button key={k.key} className="chip" aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="controls">
        <span className="ctl-label">Tier</span>
        {TIER_FILTERS.map((t) => (
          <button key={t} className="chip" aria-pressed={tier === t} onClick={() => setTier(t)}>
            {t === "all" ? "All" : t}
          </button>
        ))}
        <input
          className="mg-search"
          type="search"
          placeholder="Ticker or name"
          aria-label="Search by ticker or company name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <p className="result-count" aria-live="polite">
        {shownRows.toLocaleString()} of {all.length.toLocaleString()} names in {groups.length} groups
      </p>

      {groups.length === 0 && <p className="empty">No names match these filters.</p>}

      {groups.map(({ stat, rows }) => {
        const isCollapsed = collapsed.includes(stat.name);
        const isExpanded = expanded.includes(stat.name);
        const visible = isExpanded ? rows : rows.slice(0, PREVIEW);
        return (
          <section key={stat.name} id={slug(stat.name)} className="mg-group">
            <h3>
              <button
                className="mg-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(collapsed, setCollapsed, stat.name)}
              >
                <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span> {stat.name}
                <span className="mg-count">
                  {rows.length} · median RS {stat.medianRs == null ? MISSING : Math.round(stat.medianRs)}
                </span>
              </button>
            </h3>
            {!isCollapsed && (
              <div className="panel">
                <table className="leaders-tbl">
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col">Tier</th>
                      <th scope="col" className="num">RS</th>
                      <th scope="col" className="num">3M</th>
                      <th scope="col" className="num">12M</th>
                      <th scope="col" className="num">vs MA</th>
                      <th scope="col" className="num">Stage</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const w = railWidth(r.rsPct);
                      const n = notes(r);
                      return (
                        <tr key={r.ticker} className={r.inBook ? "in-theme" : undefined}>
                          <th scope="row">
                            <span className="lt-ticker">{r.ticker}</span>
                            {r.inBook && <span className="theme-dot" title="In the AI book">●</span>}
                            <span className="lt-name">{r.name}</span>
                            {r.badge && <span className="mg-badge">{r.badge}</span>}
                          </th>
                          <td>
                            <span className={`badge-name ${tierClass(r)}`}>{r.tier ?? MISSING}</span>
                          </td>
                          <td className="num">
                            {num(r.rsPct)}
                            <span className="lt-rail" aria-hidden="true">
                              <span className="lt-rail-fill" style={{ width: `${w ?? 0}%` }} />
                            </span>
                          </td>
                          <td className={`num ${signClass(r.r3m)}`}>{pct(r.r3m)}</td>
                          <td className={`num ${signClass(r.r12m)}`}>{pct(r.r12m)}</td>
                          <td className={`num ${signClass(r.vsMa)}`}>{pct(r.vsMa)}</td>
                          <td className="num">{stageLabel(r.stage)}</td>
                          <td className="mg-notes">{n.length ? n.join(" · ") : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length > PREVIEW && (
                  <button className="more" onClick={() => toggle(expanded, setExpanded, stat.name)}>
                    {isExpanded ? `Show top ${PREVIEW}` : `Show all ${rows.length}`}
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 3: Styles**

Append to `app/globals.css`:

```css
/* Whole market by group (app/market-groups.tsx). Reuses the leaders table,
   sector strip, chips and panel; these rules cover only what is new. */
.mg-stats { text-decoration: none; color: inherit; }
.mg-kind {
  margin-left: 6px;
  font-size: 0.6rem;
  letter-spacing: 0.06em;
  color: var(--cool-strong);
}
.mg-search {
  margin-left: auto;
  min-width: 0;
  flex: 1 1 160px;
  max-width: 240px;
  padding: 4px 10px;
  border: 1px solid var(--muted);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-size: 0.8rem;
}
.mg-group { margin-top: 28px; scroll-margin-top: 16px; }
.mg-group h3 { margin: 0 0 8px; font-size: 1rem; }
.mg-toggle {
  all: unset;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.mg-toggle:focus-visible { outline: 2px solid var(--cool-mid); outline-offset: 2px; }
.mg-count { font-size: 0.75rem; font-weight: 400; color: var(--muted); }
.mg-badge {
  display: block;
  font-size: 0.66rem;
  color: var(--warm, var(--muted));
}
.mg-notes { font-size: 0.72rem; color: var(--muted); min-width: 12ch; }
```

If `--warm` is not defined in `:root`, check `app/globals.css` for the warm token's real name (`grep -n "\-\-warm" app/globals.css`) and use it.

- [ ] **Step 4: Swap the page over and delete the old table**

In `app/page.tsx`, replace `import LeadersTable from "./leaders-table";` with `import MarketGroups from "./market-groups";`. Replace `<LeadersTable data={data} />` with `<MarketGroups data={data} />`. Update the comment above it to:

```tsx
      {/* The whole market, grouped, below the AI book. Order is the argument:
          the book is what the strategy says to do; the groups are the market
          it was selected from, under the same rules and without the cap. */}
```

Then:

```bash
git rm app/leaders-table.tsx
```

- [ ] **Step 5: Typecheck, lint, test**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Verify visually**

Start `npm run dev` in the background. `proxy.ts` skips Cloudflare Access outside production, so `http://localhost:3000` loads directly. Using claude-in-chrome:

1. Desktop width: the AI book is first. "Whole market by group" is below it, with the strip ordered by median RS, AI groups tagged "AI", and an "AI spenders" group present.
2. Click a strip row: the page jumps to that group.
3. Filters: "AI themes" hides sector groups. "Strong Buy" shows only Strong Buys. Searching "lite" shows LITE in "Optics & networking". Searching "zzzzzz" shows "No names match these filters." and no group headers.
4. MU shows a "crowding veto" badge. MSFT sits in "AI spenders" with its badge.
5. A book name beyond the top 10 (for example COHU in the current data) shows "Buy in the AI book — outside its top 10".
6. Collapse a group, reload: it stays collapsed. "Show all" expands a group of over 25.
7. Resize to 390px wide: no horizontal page scroll (the table may scroll inside its panel), and the search box wraps instead of overflowing.

Take a screenshot at each width. Fix anything that fails before committing.

- [ ] **Step 7: Commit**

```bash
git add app/market-groups.tsx app/page.tsx app/globals.css
git commit -m "Show the whole market grouped by AI theme and sector, uncapped

Replaces the flat leaders table.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

1. In the "Tier and weight" section, after the "Meets every Strong Buy rule, outside the top 10 by rank" bullet, add one sentence: "The top-10 limit applies to the AI book only. In the whole-market view below it, every name that clears every rule is a Strong Buy."
2. Replace any section describing the "Market leaders" table with a "Whole market by group" section covering: the three group kinds and their order (AI spenders, AI themes first-declared-wins, SIC sector or Unclassified), the badges, no cap, the "Buy in the AI book" note, and "Fundamentals not yet checked".
3. In the FAQ, change "Why is a name missing?" so it says the name may still appear in the whole-market view, and that only the AI book excludes it.
4. Add a short "Fundamentals store" paragraph under the data/operations section: the `company_fundamentals` table, the 7-day refresh, `npm run fundamentals`, and the nightly budget with its measured basis from Task 7.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the whole-market grouped view and the fundamentals store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Full check**

Run: `npm run audit`
Expected: typecheck, tests and the data audit all pass. `scripts/audit.ts` asserts `themed.length >= 50` and LITE's presence; both still hold because `themed` is still the book.
