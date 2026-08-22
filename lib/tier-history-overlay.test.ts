import { describe, expect, it } from "vitest";
import { summariseTierHistory } from "./tier-history-overlay";

const rec = (session: string, ticker: string, tier: string | null) => ({ session, ticker, tier });

describe("summariseTierHistory", () => {
  it("reports nothing measurable from an empty history", () => {
    const s = summariseTierHistory([]);
    expect(s.sessions).toBe(0);
    expect(s.turnover).toBeNull();
    expect(s.medianTimeInTier).toBeNull();
  });

  /**
   * One recorded session is a photograph, not a history. Turnover from a single
   * point would be zero, which reads as "perfectly stable" -- the opposite of
   * "not yet known".
   */
  it("refuses to compute turnover from a single session", () => {
    const s = summariseTierHistory([rec("2026-08-21", "A", "Buy")]);
    expect(s.sessions).toBe(1);
    expect(s.turnover).toBeNull();
  });

  it("lists transitions newest first", () => {
    const s = summariseTierHistory([
      rec("2026-08-19", "A", "Buy"),
      rec("2026-08-20", "A", "Strong Buy"),
      rec("2026-08-21", "A", "Hold"),
    ]);
    expect(s.transitions[0].session).toBe("2026-08-21");
    expect(s.transitions[0].to).toBe("Hold");
  });

  it("measures how long names have held their current tier", () => {
    const s = summariseTierHistory([
      rec("2026-08-19", "A", "Buy"),
      rec("2026-08-20", "A", "Buy"),
      rec("2026-08-21", "A", "Buy"),
      rec("2026-08-19", "B", "Buy"),
      rec("2026-08-20", "B", "Hold"),
      rec("2026-08-21", "B", "Hold"),
    ]);
    expect(s.medianTimeInTier).toBeCloseTo(2.5, 6);
    // B has held Hold for 2 sessions, A has held Buy for 3.
    expect(s.leastStable[0].ticker).toBe("B");
  });

  it("counts sessions, not rows", () => {
    const s = summariseTierHistory([
      rec("2026-08-20", "A", "Buy"),
      rec("2026-08-20", "B", "Buy"),
      rec("2026-08-21", "A", "Buy"),
      rec("2026-08-21", "B", "Buy"),
    ]);
    expect(s.sessions).toBe(2);
  });

  it("ignores departed names when ranking stability", () => {
    const s = summariseTierHistory([
      rec("2026-08-20", "GONE", "Buy"),
      rec("2026-08-20", "HERE", "Buy"),
      rec("2026-08-21", "GONE", null),
      rec("2026-08-21", "HERE", "Buy"),
    ]);
    expect(s.leastStable.map((x) => x.ticker)).not.toContain("GONE");
  });
});
