/**
 * Render the digest locally, without waiting for 6 AM.
 *
 *   npm run digest:preview                        # write tmp/digest/*, print the text
 *   npm run digest:preview -- --out some/dir      # write elsewhere
 *   npm run digest:preview -- --send --to me@x.y  # ALSO deliver one copy to that address
 *
 * Uses composeDigest(), the same function /api/digest calls, so what this
 * prints is what the route would send right now.
 *
 * The send path never touches the mail ledger and never uses ALERT_TO: it
 * addresses exactly one recipient, the one on the command line, so a test
 * cannot reach the real distribution list or suppress the real morning.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeDigest } from "../lib/digest-service";
import { readMailConfig, sendMail } from "../lib/mailer";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const out = arg("out") ?? join("tmp", "digest");
  const { digest, screen, baseline } = await composeDigest(true);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "digest.subject"), digest.subject + "\n");
  writeFileSync(join(out, "digest.txt"), digest.text + "\n");
  writeFileSync(join(out, "digest.html"), digest.html + "\n");

  console.log(`asOf ${screen.asOf}  baseline ${baseline}  warnings ${screen.meta.warnings.length}`);
  console.log(`Subject: ${digest.subject}\n`);
  console.log(digest.text);
  console.log(`\nWritten to ${out}/`);

  if (has("send")) {
    const to = arg("to");
    if (!to) throw new Error("--send requires --to <address>");
    const cfg = readMailConfig();
    if (!cfg) throw new Error("No mail config: set GMAIL_USER and GMAIL_APP_PW");
    // One recipient, explicitly. envelope() still puts the sender on To and
    // this address in Bcc: the production shape, which is the point.
    const result = await sendMail(
      { ...cfg, to: [to] },
      `[PREVIEW] ${digest.subject}`,
      digest.text,
      digest.html,
    );
    console.log(result.sent ? `Sent preview to ${to}` : `Send failed: ${result.reason} ${result.error ?? ""}`);
    if (!result.sent) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
