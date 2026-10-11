import { describe, expect, it } from "vitest";
import { universeSplits } from "./splits-refresh";

describe("universeSplits", () => {
  it("keeps the universe's splits, maps Polygon's fields and collapses duplicates", () => {
    const out = universeSplits(
      [
        { ticker: "NVDA", execution_date: "2026-11-02", split_from: 1, split_to: 4 },
        { ticker: "NVDA", execution_date: "2026-11-02", split_from: 1, split_to: 4 },
        { ticker: "ZZZZ", execution_date: "2026-11-02", split_from: 1, split_to: 2 },
        { ticker: "TSLA", execution_date: "2026-10-20", split_from: 1, split_to: 3 },
      ],
      ["NVDA", "TSLA", "SPY"],
    );
    expect(out).toEqual([
      { ticker: "NVDA", executionDate: "2026-11-02", from: 1, to: 4 },
      { ticker: "TSLA", executionDate: "2026-10-20", from: 1, to: 3 },
    ]);
  });
});
