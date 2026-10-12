import { describe, expect, it } from "vitest";
import { toSessionBars } from "./ticker-history";

describe("toSessionBars", () => {
  it("keys each aggregate by its New York trading date", () => {
    // Polygon stamps a daily bar at midnight America/New_York: 04:00Z in summer,
    // 05:00Z in winter. Both must land on the session date, not the day before.
    const summer = Date.UTC(2025, 9, 7, 4); // 2025-10-07 00:00 EDT
    const winter = Date.UTC(2026, 0, 30, 5); // 2026-01-30 00:00 EST
    const out = toSessionBars([
      { t: summer, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.4 },
      { t: winter, c: 3 },
    ]);
    expect(out).toEqual([
      { session: "2025-10-07", o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.4 },
      { session: "2026-01-30", o: undefined, h: undefined, l: undefined, c: 3, v: undefined, vw: undefined },
    ]);
  });
});
