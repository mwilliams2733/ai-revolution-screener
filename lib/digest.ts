/**
 * The morning digest.
 *
 * Deliberately a different thing from lib/alerts.ts, not a variant of it.
 *
 *   The ALERT is exception-driven: it fires only when a tier moved, and its
 *   job is to interrupt. Silence from it means nothing changed.
 *
 *   The DIGEST is unconditional: it arrives every weekday morning whether or
 *   not anything moved, and its job is to be read over coffee before the open.
 *   Silence from it means the cron did not run -- which is information the
 *   alert can never give you, because an alert that stays quiet looks exactly
 *   like a screener that has stopped.
 *
 * That last point is the reason this exists at all. A screener nobody hears
 * from is indistinguishable from a screener that died three weeks ago, and the
 * failure mode of a quiet alert is that you trust a stale page.
 *
 * So the digest leads with the SESSION DATE and staleness. If the pipeline has
 * stopped, the first line of the email says so rather than burying it under
 * tier counts that are quietly a fortnight old.
 */

import { escapeHtml, type TierChange } from "./alerts";

export interface DigestInput {
  /** Session the screen is showing. */
  readonly asOf: string;
  /** How far behind the latest trading session, in sessions. */
  readonly sessionsBehind: number;
  readonly stalenessLabel: string;
  readonly universeSize: number;
  readonly themedCount: number;
  readonly strongBuy: number;
  readonly buy: number;
  readonly hold: number;
  /** Tier moves since the previous recorded session. */
  readonly changes: readonly TierChange[];
  /** Whether the baseline was a live session; a replayed one is not comparable. */
  readonly changesComparable: boolean;
  readonly stageCapped: number;
  readonly gateDemoted: number;
  readonly cappedOut: number;
  readonly healthCapped: number;
  /** Loader failures. Non-empty means the numbers above are suspect. */
  readonly warnings: readonly string[];
  /** Top names by relative strength, for the body. */
  readonly leaders: readonly { ticker: string; rsPct: number | null; tier: string | null }[];
}

export interface Digest {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const TIER_ORDER = ["Strong Buy", "Buy", "Hold"] as const;

/**
 * A percentile as a reader wants it.
 *
 * rsPct is a tie-averaged float, so it arrives as 99.95753715498938. Printing
 * that raw is not precision, it is noise -- the rank is meaningful to a whole
 * number and nothing beyond the decimal point survives tomorrow.
 */
const rs = (v: number | null): string => (v == null ? "--" : String(Math.round(v)));

const leaderLine = (l: { ticker: string; rsPct: number | null; tier: string | null }): string =>
  `${l.ticker.padEnd(6)} RS ${rs(l.rsPct).padStart(3)}  ${l.tier ?? "--"}`;

/**
 * Subject line, front-loaded with whatever is most wrong.
 *
 * A subject that always reads the same trains you to stop opening it, so the
 * exceptional states -- stale data, loader failures -- take the front of the
 * line and the ordinary state gets the ordinary summary.
 */
export function digestSubject(d: DigestInput): string {
  if (d.warnings.length > 0) return `Screener ${d.asOf}: DATA WARNING`;
  if (d.sessionsBehind >= 2) return `Screener ${d.asOf}: STALE (${d.sessionsBehind} sessions behind)`;
  // "no tier changes" and "we could not compare" are different statements and
  // the subject must not collapse them: the first says the market was quiet,
  // the second says we do not know.
  const moved = !d.changesComparable
    ? "baseline not comparable"
    : d.changes.length > 0
      ? `${d.changes.length} moved`
      : "no tier changes";
  return `Screener ${d.asOf}: ${d.strongBuy} strong buy, ${moved}`;
}

function changeLines(d: DigestInput): string[] {
  if (!d.changesComparable) {
    return ["Tier changes not comparable: the previous session was reconstructed, not live."];
  }
  if (d.changes.length === 0) return ["No tier changes."];
  // Downgrades first: the thing you might have to act on before the open.
  const order = { downgrade: 0, dropped: 1, upgrade: 2, entered: 3 } as Record<string, number>;
  return [...d.changes]
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.ticker.localeCompare(b.ticker))
    .map((c) => `  ${c.ticker.padEnd(6)} ${c.from ?? "--"} -> ${c.to ?? "--"}`);
}

export function buildDigest(d: DigestInput): Digest {
  const lines: string[] = [];

  lines.push(`Session ${d.asOf} - ${d.stalenessLabel}`);
  if (d.warnings.length > 0) {
    lines.push("", "DATA WARNINGS - the figures below may be wrong:");
    for (const w of d.warnings) lines.push(`  ${w}`);
  }

  lines.push(
    "",
    `${d.strongBuy} Strong Buy / ${d.buy} Buy / ${d.hold} Hold` +
      `   (${d.themedCount} in theme, ${d.universeSize.toLocaleString()} ranked)`,
    "",
    "Tier changes",
    ...changeLines(d),
    "",
    "Held down by",
    `  stage rule      ${d.stageCapped}`,
    `  fundamentals    ${d.gateDemoted}`,
    `  top-10 rank cap ${d.cappedOut}`,
    `  balance sheet   ${d.healthCapped}`,
  );

  if (d.leaders.length > 0) {
    lines.push("", "Strongest names");
    for (const l of d.leaders) lines.push(`  ${leaderLine(l)}`);
  }

  const text = lines.join("\n");

  const esc = (s: string) => escapeHtml(s);
  const html = [
    `<h2 style="margin:0 0 4px">Screener ${esc(d.asOf)}</h2>`,
    `<p style="margin:0 0 12px;color:#5B6B7A">${esc(d.stalenessLabel)}</p>`,
    d.warnings.length > 0
      ? `<p style="padding:8px 12px;border-left:3px solid #A65A1F;color:#A65A1F"><strong>Data warnings</strong><br>${d.warnings.map(esc).join("<br>")}</p>`
      : "",
    `<p><strong>${d.strongBuy}</strong> Strong Buy &middot; <strong>${d.buy}</strong> Buy &middot; <strong>${d.hold}</strong> Hold` +
      `<br><span style="color:#5B6B7A">${d.themedCount} in theme, ${d.universeSize.toLocaleString()} ranked</span></p>`,
    `<h3 style="margin:16px 0 4px">Tier changes</h3>`,
    `<pre style="margin:0;font:13px ui-monospace,monospace">${esc(changeLines(d).join("\n"))}</pre>`,
    `<h3 style="margin:16px 0 4px">Held down by</h3>`,
    `<pre style="margin:0;font:13px ui-monospace,monospace">${esc(
      [
        `stage rule      ${d.stageCapped}`,
        `fundamentals    ${d.gateDemoted}`,
        `top-10 rank cap ${d.cappedOut}`,
        `balance sheet   ${d.healthCapped}`,
      ].join("\n"),
    )}</pre>`,
    d.leaders.length > 0
      ? `<h3 style="margin:16px 0 4px">Strongest names</h3><pre style="margin:0;font:13px ui-monospace,monospace">${esc(
          d.leaders.map(leaderLine).join("\n"),
        )}</pre>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: digestSubject(d), text, html };
}

/** Tier counts from a set of rows, in a fixed order so the email is stable. */
export function tierCounts(
  rows: readonly { tier: string | null }[],
): { strongBuy: number; buy: number; hold: number } {
  const n = (t: string) => rows.filter((r) => r.tier === t).length;
  return { strongBuy: n(TIER_ORDER[0]), buy: n(TIER_ORDER[1]), hold: n(TIER_ORDER[2]) };
}
