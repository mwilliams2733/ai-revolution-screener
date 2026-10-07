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
