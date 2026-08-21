import { describe, expect, it } from "vitest";
import { MISSING, money, num, pct, railWidth, signClass } from "./format";

describe("missing values never render as zero", () => {
  it("num", () => {
    expect(num(null)).toBe(MISSING);
    expect(num(undefined)).toBe(MISSING);
    expect(num(NaN)).toBe(MISSING);
    // A real zero must still render as zero.
    expect(num(0)).toBe("0");
  });

  it("pct", () => {
    expect(pct(null)).toBe(MISSING);
    expect(pct(0)).toBe("+0.0%");
    expect(pct(-3.25)).toBe("-3.3%");
  });

  it("money", () => {
    expect(money(null)).toBe(MISSING);
    expect(money(0)).toBe("$0");
    expect(money(2.4e9)).toBe("$2.4B");
  });

  it("railWidth returns null rather than a zero-length bar", () => {
    expect(railWidth(null)).toBeNull();
    // A measured zero is a real bottom rank and must still draw.
    expect(railWidth(0)).toBe(0);
    expect(railWidth(150)).toBe(100);
    expect(railWidth(-5)).toBe(0);
  });

  it("signClass marks unknown separately from negative", () => {
    expect(signClass(null)).toBe("unknown");
    expect(signClass(-1)).toBe("neg");
    expect(signClass(0)).toBe("pos");
  });
});
