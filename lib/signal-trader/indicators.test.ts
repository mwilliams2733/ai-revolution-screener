import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addFeatures } from "./indicators";
import { LONG_RULES, fires, type Cutoffs } from "./signals";
import { LAB_DIR, readLabBars } from "./lab-data";

interface Golden {
  as_of: string;
  start: string;
  tickers: string[];
  cutoffs: Cutoffs;
  firings: Record<string, Record<string, string[]>>;
}
const golden = JSON.parse(readFileSync(join(LAB_DIR, "golden.json"), "utf8")) as Golden;

describe("indicators reproduce the lab, firing for firing", () => {
  it("covers every long rule the lab evaluates", () => {
    expect([...LONG_RULES].sort()).toEqual(Object.keys(golden.firings).sort());
  });

  for (const ticker of golden.tickers) {
    it(ticker, () => {
      const bars = readLabBars(ticker, golden.start, golden.as_of);
      const f = addFeatures(bars);
      const problems: string[] = [];
      for (const rule of LONG_RULES) {
        const want = new Set(golden.firings[rule]?.[ticker] ?? []);
        const got = new Set(
          bars.filter((_, i) => fires(rule, f, i, golden.cutoffs)).map((b) => b.session),
        );
        for (const d of got) if (!want.has(d)) problems.push(`${rule} ${d}: port fires, lab does not`);
        for (const d of want) if (!got.has(d)) problems.push(`${rule} ${d}: lab fires, port does not`);
      }
      expect(problems).toEqual([]);
    });
  }
});
