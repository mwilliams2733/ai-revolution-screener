/**
 * Trim a filing-style company description to a readable summary.
 *
 * Polygon returns the full boilerplate paragraph — AXTI's runs past 700
 * characters — which in a tooltip pushes the earnings section out of view. The
 * ask was a summary of what the company does, not the whole Item 1.
 *
 * Cuts at a sentence boundary near the limit so the result still reads as
 * prose, and falls back to an ellipsis when no sentence ends in range.
 */
export function summarise(text: string, limit = 260): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;

  const window = clean.slice(0, limit + 60);
  const stop = window.lastIndexOf(". ");
  if (stop > limit * 0.5) return window.slice(0, stop + 1);
  return `${clean.slice(0, limit).trimEnd()}…`;
}
