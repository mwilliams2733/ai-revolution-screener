import { describe, expect, it } from "vitest";
import { summarise } from "./summarise";

describe("summarise", () => {
  it("leaves a short description untouched", () => {
    const s = "Makes optical components.";
    expect(summarise(s)).toBe(s);
  });

  it("cuts at a sentence boundary rather than mid-word", () => {
    const s =
      "AXT Inc is a developer and producer of compound and single element semiconductor substrates, also known as wafers. " +
      "The dominant substrates used in producing semiconductor chips are made from silicon. " +
      "It is engaged in the design, development, manufacture, and distribution of high-performance compound substrates. " +
      "Geographically it has business presence across Europe, Japan, Taiwan, China and North America.";
    const out = summarise(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out.endsWith(".")).toBe(true);
    // A boundary cut must not strand a partial word before the period.
    expect(out).not.toMatch(/\s\S{1,2}\.$/);
  });

  it("falls back to an ellipsis when no sentence ends in range", () => {
    const s = `${"word ".repeat(120)}end.`;
    const out = summarise(s, 100);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(101);
  });

  it("does not cut at a period that is far too early", () => {
    // A leading abbreviation must not truncate the summary to almost nothing.
    const s = `Inc. ${"a".repeat(400)}`;
    expect(summarise(s, 200).length).toBeGreaterThan(100);
  });
});
