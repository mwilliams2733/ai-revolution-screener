/**
 * Display helpers that keep "unknown" distinguishable from "zero". (Finding H2)
 *
 * A screener's most dangerous failure is rendering a missing measurement as a
 * real one. `Math.round(rsPct ?? 0)` prints 0 for a name that was never ranked,
 * which is indistinguishable from the genuinely weakest name in the market, and
 * `?? 0` on a rail draws an empty bar that reads as a measured result.
 *
 * These return a sentinel string instead, so an absent value looks absent.
 */

/** Shown wherever a value was not measured. */
export const MISSING = "--";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Integer, or the missing marker. Never coerces null to 0. */
export function num(value: number | null | undefined, digits = 0): string {
  return isNum(value) ? value.toFixed(digits) : MISSING;
}

/** Signed percentage, or the missing marker. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return MISSING;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** Compact dollars, or the missing marker. */
export function money(value: number | null | undefined): string {
  if (!isNum(value)) return MISSING;
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
}

/**
 * Bar width for a 0-100 measure.
 *
 * Returns null when unmeasured so callers render an explicitly unknown track
 * rather than a zero-length bar, which would look like a real bottom rank.
 */
export function railWidth(value: number | null | undefined): number | null {
  if (!isNum(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** Class for a signed figure, or none when the value is missing. */
export function signClass(value: number | null | undefined): string {
  if (!isNum(value)) return "unknown";
  return value >= 0 ? "pos" : "neg";
}
