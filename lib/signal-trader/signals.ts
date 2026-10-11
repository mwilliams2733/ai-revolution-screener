/**
 * The lab's signal rules (find_best_signal.py lines 300-313): a continuous
 * column fires LONG in its top train decile (>= hi) and SHORT in its bottom
 * decile (<= lo); a binary column fires long when true. NaN never fires.
 */
import { BINARY, CONTINUOUS, type Binary, type Continuous, type Features } from "./indicators";

export type LongRule = `${Continuous}__long` | Binary;
export type ShortRule = `${Continuous}__short`;
export type Rule = LongRule | ShortRule;
export type Cutoffs = Readonly<Record<Continuous, { readonly lo: number; readonly hi: number }>>;

export const LONG_RULES: readonly LongRule[] = [
  ...CONTINUOUS.map((c) => `${c}__long` as const),
  ...BINARY,
];
export const SHORT_RULES: readonly ShortRule[] = CONTINUOUS.map((c) => `${c}__short` as const);

const isBinary = (rule: Rule): rule is Binary => (BINARY as readonly string[]).includes(rule);

export function fires(rule: Rule, f: Features, i: number, cutoffs: Cutoffs): boolean {
  if (isBinary(rule)) return f.binary[rule][i];
  const [col, side] = rule.split("__") as [Continuous, "long" | "short"];
  const x = f.continuous[col][i];
  return side === "long" ? x >= cutoffs[col].hi : x <= cutoffs[col].lo;
}
