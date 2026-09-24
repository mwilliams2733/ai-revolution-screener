/**
 * Inspect or correct the mail send ledger (mail_sends).
 *
 *   npm run mail-ledger -- list                 # newest 30 rows
 *   npm run mail-ledger -- list --limit 100
 *   npm run mail-ledger -- forget digest digest:2026-09-23:2026-09-22
 *
 * `forget` is for a claim that never became an email: the process died
 * between claimMailSend and releaseMailSend, so the key stays claimed and
 * every later scheduler skips. Deleting the row lets the next one send. It
 * cannot un-send anything.
 */

import { neon } from "@neondatabase/serverless";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = neon(url);
  const cmd = process.argv[2];

  if (cmd === "list") {
    const limit = Number(arg("limit") ?? 30);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
    const rows = (await sql`
      SELECT kind, dedupe_key, sent_at FROM mail_sends ORDER BY sent_at DESC LIMIT ${limit}
    `) as { kind: string; dedupe_key: string; sent_at: string }[];
    if (rows.length === 0) {
      console.log("no rows");
      return;
    }
    for (const r of rows) {
      console.log(`${new Date(r.sent_at).toISOString()}  ${r.kind.padEnd(6)}  ${r.dedupe_key}`);
    }
    return;
  }

  if (cmd === "forget") {
    const kind = process.argv[3];
    const key = process.argv[4];
    if (!kind || !key) throw new Error("usage: forget <kind> <dedupe_key>");
    const rows = (await sql`
      DELETE FROM mail_sends WHERE kind = ${kind} AND dedupe_key = ${key} RETURNING 1
    `) as unknown[];
    console.log(rows.length === 1 ? `forgot ${kind} ${key}` : `no such row: ${kind} ${key}`);
    return;
  }

  throw new Error("usage: list [--limit N] | forget <kind> <dedupe_key>");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
