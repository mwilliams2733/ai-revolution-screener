import { describe, expect, it } from "vitest";
import { isoDaysAgo, phoenixToday } from "./dates";

describe("phoenixToday", () => {
  /** 23:30 UTC is 16:30 in Phoenix: still the same calendar day. */
  it("agrees with UTC before 07:00 UTC of the next day", () => {
    expect(phoenixToday(new Date("2026-09-23T23:30:00Z"))).toBe("2026-09-23");
  });

  /**
   * 02:00 UTC on the 24th is 19:00 on the 23rd in Phoenix. A manual digest
   * run at that hour must be keyed to the 23rd, or the 24th's real 6 AM
   * digest is refused as already sent.
   */
  it("stays on the Phoenix day after UTC midnight", () => {
    expect(phoenixToday(new Date("2026-09-24T02:00:00Z"))).toBe("2026-09-23");
  });

  it("rolls over at 07:00 UTC", () => {
    expect(phoenixToday(new Date("2026-09-24T06:59:59Z"))).toBe("2026-09-23");
    expect(phoenixToday(new Date("2026-09-24T07:00:00Z"))).toBe("2026-09-24");
  });
});

describe("isoDaysAgo", () => {
  it("returns a yyyy-mm-dd string", () => {
    expect(isoDaysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
