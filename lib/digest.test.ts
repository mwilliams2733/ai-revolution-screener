import { describe, expect, it } from "vitest";
import { buildDigest, digestSubject, tierCounts, type DigestInput } from "./digest";

const base: DigestInput = {
  asOf: "2026-08-21",
  sessionsBehind: 0,
  stalenessLabel: "Latest close",
  universeSize: 2356,
  themedCount: 109,
  strongBuy: 10,
  buy: 24,
  hold: 75,
  changes: [],
  changesComparable: true,
  stageCapped: 23,
  gateDemoted: 3,
  cappedOut: 25,
  healthCapped: 3,
  warnings: [],
  leaders: [
    { ticker: "LITE", rsPct: 99, tier: "Strong Buy" },
    { ticker: "DELL", rsPct: 99, tier: "Strong Buy" },
  ],
};

const change = (ticker: string, from: string | null, to: string | null, kind: string) =>
  ({ ticker, from, to, kind, rsPct: 80, vsMa: 5 }) as unknown as DigestInput["changes"][number];

describe("digestSubject", () => {
  it("summarises an ordinary morning", () => {
    expect(digestSubject(base)).toBe("Screener 2026-08-21: 10 strong buy, no tier changes");
  });

  it("counts the moves when there are any", () => {
    const d = { ...base, changes: [change("A", "Buy", "Hold", "downgrade")] };
    expect(digestSubject(d)).toMatch(/1 moved/);
  });

  /**
   * A subject that always reads the same trains the reader to stop opening it,
   * so the exceptional states take the front of the line.
   */
  it("leads with a data warning above everything else", () => {
    const d = { ...base, warnings: ["close history: timeout"], sessionsBehind: 5 };
    expect(digestSubject(d)).toBe("Screener 2026-08-21: DATA WARNING");
  });

  it("leads with staleness when the data has stopped moving", () => {
    expect(digestSubject({ ...base, sessionsBehind: 4 })).toMatch(/STALE \(4 sessions behind\)/);
  });

  /** One session behind is normal: the feed is delayed end-of-day. */
  it("does not cry stale at a single session behind", () => {
    expect(digestSubject({ ...base, sessionsBehind: 1 })).not.toMatch(/STALE/);
  });
});

describe("buildDigest", () => {
  it("leads with the session and its staleness, not with tier counts", () => {
    const { text } = buildDigest(base);
    expect(text.split("\n")[0]).toBe("Session 2026-08-21 - Latest close");
  });

  it("reports the tier split and both universe sizes", () => {
    const { text } = buildDigest(base);
    expect(text).toMatch(/10 Strong Buy \/ 24 Buy \/ 75 Hold/);
    expect(text).toMatch(/109 in theme, 2,356 ranked/);
  });

  it("says so plainly when nothing moved", () => {
    expect(buildDigest(base).text).toMatch(/No tier changes\./);
  });

  /**
   * Downgrades first. The digest is read before the open, and a demotion is
   * the thing that might need acting on; a promotion can wait.
   */
  it("puts downgrades above upgrades", () => {
    const d = {
      ...base,
      changes: [
        change("UP", "Buy", "Strong Buy", "upgrade"),
        change("DOWN", "Strong Buy", "Buy", "downgrade"),
      ],
    };
    const lines = buildDigest(d).text.split("\n");
    const iDown = lines.findIndex((l) => l.includes("DOWN"));
    const iUp = lines.findIndex((l) => l.includes("UP "));
    expect(iDown).toBeGreaterThan(-1);
    expect(iDown).toBeLessThan(iUp);
  });

  /**
   * A replayed baseline is not comparable: the replay omits the fundamental
   * gate, so a diff against it reports the difference between two RULESETS.
   * The digest must say that rather than print the numbers anyway.
   */
  it("refuses to present changes measured against a replayed session", () => {
    const d = {
      ...base,
      changesComparable: false,
      changes: [change("A", "Buy", "Hold", "downgrade")],
    };
    const { text } = buildDigest(d);
    expect(text).toMatch(/not comparable/i);
    expect(text).not.toMatch(/\bA\s+Buy/);
  });

  it("puts data warnings above the figures they undermine", () => {
    const { text } = buildDigest({ ...base, warnings: ["close history: 507"] });
    const iWarn = text.indexOf("DATA WARNINGS");
    const iCounts = text.indexOf("Strong Buy /");
    expect(iWarn).toBeGreaterThan(-1);
    expect(iWarn).toBeLessThan(iCounts);
    expect(text).toMatch(/close history: 507/);
  });

  it("lists every reason a tier was held down", () => {
    const { text } = buildDigest(base);
    expect(text).toMatch(/stage rule\s+23/);
    expect(text).toMatch(/fundamentals\s+3/);
    expect(text).toMatch(/top-10 rank cap\s+25/);
    expect(text).toMatch(/balance sheet\s+3/);
  });

  it("includes the strongest names", () => {
    expect(buildDigest(base).text).toMatch(/LITE\s+RS\s+99\s+Strong Buy/);
  });

  it("omits the leaders block rather than printing an empty heading", () => {
    const { text } = buildDigest({ ...base, leaders: [] });
    expect(text).not.toMatch(/Strongest names/);
  });

  it("escapes anything that could inject markup into the html", () => {
    const d = { ...base, warnings: ['<img src=x onerror="alert(1)">'] };
    const { html } = buildDigest(d);
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img/);
  });

  it("produces a subject matching digestSubject", () => {
    expect(buildDigest(base).subject).toBe(digestSubject(base));
  });
});

describe("tierCounts", () => {
  it("counts each tier", () => {
    const rows = [
      { tier: "Strong Buy" }, { tier: "Strong Buy" }, { tier: "Buy" },
      { tier: "Hold" }, { tier: null },
    ];
    expect(tierCounts(rows)).toEqual({ strongBuy: 2, buy: 1, hold: 1 });
  });

  it("is all zeros for no rows", () => {
    expect(tierCounts([])).toEqual({ strongBuy: 0, buy: 0, hold: 0 });
  });
});

describe("digest formatting against real-shaped data", () => {
  /**
   * rsPct is a tie-averaged float. The first draft of this file printed it
   * raw and the live preview read "RS 99.95753715498938" -- the fixtures had
   * used whole numbers, so nothing caught it.
   */
  it("rounds the percentile rather than printing the float", () => {
    const d = {
      ...base,
      leaders: [{ ticker: "AXTI", rsPct: 99.95753715498938, tier: "Hold" }],
    };
    const { text, html } = buildDigest(d);
    expect(text).toMatch(/AXTI\s+RS\s+100\s+Hold/);
    expect(text).not.toMatch(/99\.95/);
    expect(html).not.toMatch(/99\.95/);
  });

  it("renders an unmeasured percentile as a dash, not as zero", () => {
    const d = { ...base, leaders: [{ ticker: "NEW", rsPct: null, tier: null }] };
    expect(buildDigest(d).text).toMatch(/NEW\s+RS\s+--\s+--/);
  });

  /**
   * "Nothing moved" and "we could not tell" are different statements. The
   * subject collapsed them into "no tier changes" while the body said the
   * baseline was not comparable -- the email contradicted itself.
   */
  it("does not report an incomparable baseline as a quiet market", () => {
    const d = { ...base, changesComparable: false };
    const subject = digestSubject(d);
    expect(subject).toMatch(/not comparable/i);
    expect(subject).not.toMatch(/no tier changes/);
  });

  it("keeps subject and body telling the same story", () => {
    for (const comparable of [true, false]) {
      const d = { ...base, changesComparable: comparable, changes: [] };
      const { subject, text } = buildDigest(d);
      expect(/not comparable/i.test(subject)).toBe(/not comparable/i.test(text));
    }
  });
});
