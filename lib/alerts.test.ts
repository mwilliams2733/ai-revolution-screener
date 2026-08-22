import { describe, expect, it } from "vitest";
import { diffTiers, formatAlert, shouldSend } from "./alerts";

const prev = (pairs: [string, string][]) => new Map(pairs);

describe("diffTiers", () => {
  it("classifies an upgrade and a downgrade by direction", () => {
    const changes = diffTiers(
      prev([
        ["AAA", "Buy"],
        ["BBB", "Strong Buy"],
      ]),
      [
        { ticker: "AAA", tier: "Strong Buy", rsPct: 91, vsMa: 12 },
        { ticker: "BBB", tier: "Buy", rsPct: 78, vsMa: 4 },
      ],
    );
    expect(changes.find((c) => c.ticker === "AAA")!.kind).toBe("upgrade");
    expect(changes.find((c) => c.ticker === "BBB")!.kind).toBe("downgrade");
  });

  it("reports a name entering the screen", () => {
    const changes = diffTiers(prev([]), [
      { ticker: "NEW", tier: "Buy", rsPct: 70, vsMa: 3 },
    ]);
    expect(changes[0].kind).toBe("entered");
    expect(changes[0].from).toBeNull();
  });

  it("reports a name dropping out entirely", () => {
    const changes = diffTiers(prev([["GONE", "Buy"]]), []);
    expect(changes[0].kind).toBe("dropped");
    expect(changes[0].to).toBeNull();
  });

  it("says nothing when nothing moved", () => {
    const changes = diffTiers(prev([["AAA", "Buy"]]), [
      { ticker: "AAA", tier: "Buy", rsPct: 70, vsMa: 3 },
    ]);
    expect(changes).toHaveLength(0);
  });

  /**
   * Downgrades first. A Strong Buy falling to Hold is the message that needs
   * acting on; a name being promoted can wait until the reader scrolls.
   */
  it("orders downgrades and exits above upgrades", () => {
    const changes = diffTiers(
      prev([
        ["UP", "Buy"],
        ["DOWN", "Strong Buy"],
        ["OUT", "Buy"],
      ]),
      [
        { ticker: "UP", tier: "Strong Buy", rsPct: 95, vsMa: 20 },
        { ticker: "DOWN", tier: "Hold", rsPct: 30, vsMa: -5 },
      ],
    );
    expect(changes.map((c) => c.kind).slice(0, 2)).toEqual(["downgrade", "dropped"]);
    expect(changes.at(-1)!.kind).toBe("upgrade");
  });
});

describe("shouldSend", () => {
  /**
   * The first night has no previous session, so EVERY name reads as new. Mailing
   * 104 "entered" alerts would train the reader to ignore the alerts on day one.
   */
  it("stays silent on the first run, when there is no baseline", () => {
    const changes = diffTiers(prev([]), [
      { ticker: "A", tier: "Buy", rsPct: 70, vsMa: 1 },
      { ticker: "B", tier: "Buy", rsPct: 71, vsMa: 1 },
    ]);
    expect(shouldSend(changes, { hasBaseline: false, enabled: true })).toBe(false);
  });

  it("stays silent when nothing changed", () => {
    expect(shouldSend([], { hasBaseline: true, enabled: true })).toBe(false);
  });

  it("stays silent when alerts are switched off", () => {
    const changes = diffTiers(prev([["A", "Buy"]]), [
      { ticker: "A", tier: "Hold", rsPct: 20, vsMa: -9 },
    ]);
    expect(shouldSend(changes, { hasBaseline: true, enabled: false })).toBe(false);
  });

  it("sends when a real change happened against a real baseline", () => {
    const changes = diffTiers(prev([["A", "Buy"]]), [
      { ticker: "A", tier: "Hold", rsPct: 20, vsMa: -9 },
    ]);
    expect(shouldSend(changes, { hasBaseline: true, enabled: true })).toBe(true);
  });
});

describe("formatAlert", () => {
  const changes = diffTiers(
    prev([
      ["MRVL", "Strong Buy"],
      ["LITE", "Buy"],
    ]),
    [
      { ticker: "MRVL", tier: "Buy", rsPct: 78, vsMa: 5.2 },
      { ticker: "LITE", tier: "Strong Buy", rsPct: 99, vsMa: 32.8 },
    ],
  );

  it("leads the subject with what got worse", () => {
    const { subject } = formatAlert(changes, "2026-08-21");
    expect(subject).toMatch(/1 down/i);
    expect(subject).toContain("2026-08-21");
  });

  it("names every ticker and both tiers in the body", () => {
    const { text } = formatAlert(changes, "2026-08-21");
    expect(text).toContain("MRVL");
    expect(text).toContain("Strong Buy");
    expect(text).toContain("Buy");
    expect(text).toContain("LITE");
  });

  it("produces plain text and HTML that agree on the ticker list", () => {
    const { text, html } = formatAlert(changes, "2026-08-21");
    for (const t of ["MRVL", "LITE"]) {
      expect(text).toContain(t);
      expect(html).toContain(t);
    }
  });

  it("escapes ticker text rather than interpolating it raw into HTML", () => {
    const evil = diffTiers(prev([["<img src=x>", "Buy"]]), []);
    expect(formatAlert(evil, "2026-08-21").html).not.toContain("<img src=x>");
  });
});
