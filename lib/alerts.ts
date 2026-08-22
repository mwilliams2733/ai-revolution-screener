/**
 * Tier-change alerts. (Build step 8)
 *
 * HANDOFF.md calls this "the thing you will actually open the app for". The
 * screen tells you where names stand; the alert tells you what MOVED, which is
 * the only part that needs attention on a given evening.
 *
 * Pure: diffing and formatting only. Delivery lives in lib/mailer.ts so this
 * stays testable without a mail server.
 */

/** Ordered weakest to strongest, so a move can be given a direction. */
const TIER_RANK: Record<string, number> = { Hold: 1, Buy: 2, "Strong Buy": 3 };

export type ChangeKind = "downgrade" | "dropped" | "entered" | "upgrade";

export interface TierChange {
  readonly ticker: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly kind: ChangeKind;
  readonly rsPct: number | null;
  readonly vsMa: number | null;
}

export interface CurrentRow {
  readonly ticker: string;
  readonly tier: string | null;
  readonly rsPct: number | null;
  readonly vsMa: number | null;
}

/**
 * Attention order, not alphabetical.
 *
 * A Strong Buy falling to Hold is the message worth acting on tonight; a
 * promotion can wait until the reader scrolls. Sorting by severity means the
 * subject line and the first rows carry the bad news.
 */
const KIND_ORDER: Record<ChangeKind, number> = {
  downgrade: 0,
  dropped: 1,
  entered: 2,
  upgrade: 3,
};

/** Compare last session's tiers against this session's rows. */
export function diffTiers(
  previous: ReadonlyMap<string, string>,
  current: readonly CurrentRow[],
): TierChange[] {
  const out: TierChange[] = [];
  const seen = new Set<string>();

  for (const row of current) {
    seen.add(row.ticker);
    const before = previous.get(row.ticker) ?? null;
    const after = row.tier;
    if (before === after) continue;

    let kind: ChangeKind;
    if (before == null) kind = "entered";
    else if (after == null) kind = "dropped";
    else kind = (TIER_RANK[after] ?? 0) > (TIER_RANK[before] ?? 0) ? "upgrade" : "downgrade";

    out.push({ ticker: row.ticker, from: before, to: after, kind, rsPct: row.rsPct, vsMa: row.vsMa });
  }

  // A name absent from today's screen left the universe entirely, which is a
  // real event and not the same as merely sliding a tier.
  for (const [ticker, before] of previous) {
    if (seen.has(ticker)) continue;
    out.push({ ticker, from: before, to: null, kind: "dropped", rsPct: null, vsMa: null });
  }

  return out.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ticker.localeCompare(b.ticker),
  );
}

export interface SendContext {
  /** Was there a previous session to compare against? */
  readonly hasBaseline: boolean;
  readonly enabled: boolean;
}

/**
 * Whether an email is warranted.
 *
 * Silent on the first run. With no previous session every name reads as
 * "entered", and 104 arrivals on day one would teach the reader that these
 * emails are noise — which is how alerting systems die.
 */
export function shouldSend(changes: readonly TierChange[], ctx: SendContext): boolean {
  if (!ctx.enabled) return false;
  if (!ctx.hasBaseline) return false;
  return changes.length > 0;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const arrow = (c: TierChange): string => `${c.from ?? "—"} → ${c.to ?? "off screen"}`;

const figures = (c: TierChange): string => {
  const bits: string[] = [];
  if (c.rsPct != null) bits.push(`RS ${Math.round(c.rsPct)}`);
  if (c.vsMa != null) bits.push(`vs MA ${c.vsMa >= 0 ? "+" : ""}${c.vsMa.toFixed(1)}%`);
  return bits.join(", ");
};

export interface Alert {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Build the message. Subject leads with what got worse. */
export function formatAlert(changes: readonly TierChange[], asOf: string): Alert {
  const down = changes.filter((c) => c.kind === "downgrade" || c.kind === "dropped").length;
  const up = changes.filter((c) => c.kind === "upgrade" || c.kind === "entered").length;

  const parts: string[] = [];
  if (down > 0) parts.push(`${down} down`);
  if (up > 0) parts.push(`${up} up`);
  const subject = `Screener ${asOf}: ${parts.join(", ") || "no change"}`;

  const lines = changes.map((c) => {
    const f = figures(c);
    return `  ${c.ticker.padEnd(6)} ${arrow(c)}${f ? `   (${f})` : ""}`;
  });

  const text = [
    `Tier changes for ${asOf}`,
    "",
    ...lines,
    "",
    "https://screener.williamstradingplatform.com",
  ].join("\n");

  const rows = changes
    .map(
      (c) =>
        `<tr><td style="padding:4px 10px 4px 0;font-weight:600">${escapeHtml(c.ticker)}</td>` +
        `<td style="padding:4px 10px 4px 0">${escapeHtml(arrow(c))}</td>` +
        `<td style="padding:4px 0;color:#5B6B7A">${escapeHtml(figures(c))}</td></tr>`,
    )
    .join("");

  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">` +
    `<p style="margin:0 0 12px"><strong>Tier changes for ${escapeHtml(asOf)}</strong></p>` +
    `<table style="border-collapse:collapse">${rows}</table>` +
    `<p style="margin:14px 0 0"><a href="https://screener.williamstradingplatform.com">Open the screener</a></p>` +
    `</div>`;

  return { subject, text, html };
}
