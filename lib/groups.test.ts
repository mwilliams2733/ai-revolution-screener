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
