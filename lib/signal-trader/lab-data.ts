/**
 * The signal lab's CSVs (research/signal-lab/data), for tests and scripts.
 * Never imported by the app: research/ is excluded from deployments.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "./types";

export const LAB_DIR = join(process.cwd(), "research", "signal-lab");

/** Bars for one ticker with start <= date <= end, oldest first (the lab's load filter). */
export function readLabBars(ticker: string, start: string, end: string): Bar[] {
  const text = readFileSync(join(LAB_DIR, "data", `${ticker}.csv`), "utf8");
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  const at = (name: string) => cols.indexOf(name);
  const [d, o, h, l, c, v] = ["date", "open", "high", "low", "close", "volume"].map(at);
  return lines
    .map((line) => line.split(","))
    .map((x) => ({
      session: x[d].slice(0, 10),
      open: Number(x[o]),
      high: Number(x[h]),
      low: Number(x[l]),
      close: Number(x[c]),
      volume: Number(x[v]),
    }))
    .filter((b) => b.session >= start && b.session <= end)
    .sort((a, b) => a.session.localeCompare(b.session));
}
