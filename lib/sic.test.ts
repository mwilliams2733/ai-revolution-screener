import { describe, expect, it } from "vitest";
import { SECTORS, classify, sectorsPresent, subsectorsPresent } from "./sic";

describe("classify", () => {
  /**
   * The codes this project actually cares about, verified against real EDGAR
   * filings: NVDA and INTC file 3674, AAPL files 3571.
   */
  it("puts the semiconductor makers in Semiconductors", () => {
    expect(classify(3674).sector).toBe("Semiconductors");
    expect(classify("3674").sector).toBe("Semiconductors");
  });

  it("does not let semiconductors inherit the electronics major group", () => {
    // 36xx defaults to Electronics; 3674 must override it, and 3675 must not.
    expect(classify(3675).sector).toBe("Electronics");
    expect(classify(3690).sector).toBe("Electronics");
    expect(classify(3674).sector).not.toBe("Electronics");
  });

  it("separates computers from industrial machinery inside 35xx", () => {
    expect(classify(3571).sector).toBe("Hardware");
    expect(classify(3550).sector).toBe("Industrials");
  });

  it("separates drugs from chemicals inside 28xx", () => {
    expect(classify(2834).sector).toBe("Biotech & Pharma");
    expect(classify(2820).sector).toBe("Materials & Chemicals");
  });

  /** Most clinical-stage biotech files 8731, not 283x. Missing it would put
   *  the majority of the sector under Business Services. */
  it("catches contract research as biotech", () => {
    expect(classify(8731).sector).toBe("Biotech & Pharma");
    expect(classify(8700).sector).toBe("Business Services");
  });

  it("separates software from the rest of business services", () => {
    expect(classify(7372).sector).toBe("Software");
    expect(classify(7373).sector).toBe("IT Services");
    expect(classify(7389).sector).toBe("Business Services");
    expect(classify(7300).sector).toBe("Business Services");
  });

  it("splits transportation equipment into aerospace and automotive", () => {
    expect(classify(3711).sector).toBe("Automotive");
    expect(classify(3721).sector).toBe("Aerospace & Defense");
    expect(classify(3761).sector).toBe("Aerospace & Defense");
    expect(classify(3730).sector).toBe("Industrials");
  });

  it("keeps medical instruments out of Electronics", () => {
    expect(classify(3841).sector).toBe("Medical Devices");
    expect(classify(3826).sector).toBe("Medical Devices");
    expect(classify(3827).sector).toBe("Electronics");
  });

  it("routes energy by major group", () => {
    expect(classify(1311).sector).toBe("Energy");
    expect(classify(2911).sector).toBe("Energy");
    expect(classify(4911).sector).toBe("Utilities");
  });

  /** Waste management files under the utilities major group and is not one. */
  it("pulls sanitary services out of Utilities", () => {
    expect(classify(4953).sector).toBe("Industrials");
    expect(classify(4911).sector).toBe("Utilities");
  });

  it("carries the EDGAR description through as the subsector", () => {
    expect(classify(3674, "Semiconductors & Related Devices").subsector).toBe(
      "Semiconductors & Related Devices",
    );
  });

  /**
   * Unclassified must not mean invisible. A ranked name with no SIC still has
   * to appear in a sector view, or the leaders list is quietly incomplete and
   * nothing on screen says so.
   */
  it("keeps unclassifiable names visible under Other", () => {
    for (const bad of [null, undefined, "", "  ", "abcd", 12345, "N/A"]) {
      expect(classify(bad as never).sector).toBe("Other");
    }
    expect(classify(null).subsector).toBe("Unclassified");
    expect(classify(null, "  ").subsector).toBe("Unclassified");
  });

  it("pads a three-digit code rather than misreading its major group", () => {
    // "731" is 0731; read unpadded its major group would be 73, Business
    // Services, instead of 07.
    expect(classify(731).sector).toBe(classify("0731").sector);
    expect(classify(731).sector).toBe("Other");
  });

  it("only ever returns a declared sector", () => {
    const declared = new Set<string>(SECTORS);
    for (let code = 100; code <= 9999; code += 1) {
      expect(declared.has(classify(code).sector)).toBe(true);
    }
  });
});

describe("sectorsPresent", () => {
  it("lists only sectors that appear, in declared order", () => {
    const rows = [
      { sector: "Software" },
      { sector: "Semiconductors" },
      { sector: "Software" },
    ];
    // Semiconductors precedes Software in SECTORS, so the input order is not
    // what comes back -- the filter list must be stable between renders.
    expect(sectorsPresent(rows)).toEqual(["Semiconductors", "Software"]);
  });

  it("is empty for no rows", () => {
    expect(sectorsPresent([])).toEqual([]);
  });
});

describe("subsectorsPresent", () => {
  const rows = [
    { sector: "Semiconductors", subsector: "Semiconductors & Related Devices" },
    { sector: "Semiconductors", subsector: "Printed Circuit Boards" },
    { sector: "Software", subsector: "Services-Prepackaged Software" },
  ];

  it("narrows to the selected sectors", () => {
    expect(subsectorsPresent(rows, new Set(["Semiconductors"]))).toEqual([
      "Printed Circuit Boards",
      "Semiconductors & Related Devices",
    ]);
  });

  /** An empty selection means "no sector filter", not "no sectors". */
  it("offers everything when nothing is selected", () => {
    expect(subsectorsPresent(rows, new Set())).toHaveLength(3);
  });

  it("deduplicates across rows", () => {
    expect(subsectorsPresent([...rows, ...rows], new Set(["Software"]))).toEqual([
      "Services-Prepackaged Software",
    ]);
  });
});
