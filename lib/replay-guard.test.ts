import { describe, expect, it } from "vitest";
import { replayMayWrite } from "./replay-guard";

describe("replayMayWrite", () => {
  const live = new Set(["2026-09-23", "2026-09-24"]);

  /**
   * The bug: the replay inserted a row for a ticker the live snapshot lacked,
   * turning a live session into a mixed one. A live session must be skipped
   * entirely, not merely protected row by row.
   */
  it("refuses a session that has live rows", () => {
    expect(replayMayWrite("2026-09-23", live)).toBe(false);
  });

  it("allows a session with no live rows", () => {
    expect(replayMayWrite("2026-09-22", live)).toBe(true);
  });

  it("allows everything when there is no live history yet", () => {
    expect(replayMayWrite("2026-09-23", new Set())).toBe(true);
  });
});
