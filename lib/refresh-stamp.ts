/**
 * "When was the data last updated?" -- as a string a human can act on.
 *
 * WHY THIS IS NOT THE SAME AS THE SESSION DATE
 *
 * The masthead already shows `Session`, which answers "what data am I looking
 * at". It does NOT answer "is the pipeline still alive", and those come apart
 * in the dangerous direction: if the refresh dies tonight, `Session` sits
 * unchanged at yesterday's close and looks perfectly normal all day tomorrow.
 * assessStaleness() catches it eventually, but only once the trading calendar
 * moves past the stored session -- hours later, and never at all over a
 * weekend.
 *
 * So this reports the LAST CHECK, not the last change. A run that fetched
 * nothing is still evidence the cron fired, which is the thing a silent
 * failure takes away. Most runs add nothing: the evening run does the work and
 * the morning one arrives to find it already done.
 *
 * Everything here is pure and takes `now` as an argument. A module that reads
 * the clock internally cannot be tested at a boundary without faking timers,
 * and every interesting case here IS a boundary.
 */

/** America/Phoenix: UTC-7 year round, no DST, so the offset never moves. */
const TZ = "America/Phoenix";

export type RunState = "ok" | "failed" | "running";

export interface RefreshRun {
  /** When the run began. */
  readonly startedAt: string;
  /** When it ended; null while still in flight. */
  readonly finishedAt: string | null;
  /** null while still in flight. */
  readonly ok: boolean | null;
  readonly sessionsAdded: number;
  readonly barsAdded: number;
}

export interface RefreshStamp {
  readonly state: RunState;
  /** "6 hours ago" -- computed against a caller-supplied clock. */
  readonly relative: string;
  /** "Aug 26, 3:16 PM MST" -- stable regardless of when it is rendered. */
  readonly absolute: string;
  /** "Yesterday 3:16 PM MST" -- what the masthead renders. */
  readonly label: string;
  /** Full sentence for a tooltip. */
  readonly detail: string;
}

/**
 * A run that started but never finished is NOT a success.
 *
 * finishRun() is the only writer of finished_at, so a null means the process
 * died mid-run or is still going. Reporting that as a clean check is the one
 * failure this widget exists to prevent, so it gets its own state rather than
 * being folded into ok/failed.
 */
export function runState(run: RefreshRun): RunState {
  if (run.finishedAt === null) return "running";
  return run.ok === true ? "ok" : "failed";
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Coarse relative time. Granularity is deliberate: "6 hours ago" is what you
 * act on, "6 hours 12 minutes ago" is noise, and a minute-accurate string
 * invites the reader to trust a precision the hourly cron does not have.
 *
 * A future timestamp reads as "just now" rather than "in 3 hours" -- clock skew
 * between the database and the browser is real and small, and negative elapsed
 * time is never information the reader wants.
 */
export function relativeTime(then: string, now: Date): string {
  const ms = now.getTime() - new Date(then).getTime();
  if (Number.isNaN(ms)) return "unknown";
  if (ms < 0 || ms < 2 * MIN) return "just now";
  if (ms < HOUR) {
    const m = Math.floor(ms / MIN);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * "Today" / "Yesterday" / "3 days ago" -- deliberately DAY granularity.
 *
 * page.tsx sets `revalidate = 3600`, so whatever the server renders can be an
 * hour stale by the time it is read. An hourly-granularity relative string
 * ("6 hours ago") is therefore capable of being flatly wrong, which is
 * intolerable on a widget whose only job is to tell you the pipeline is alive.
 *
 * Choosing a granularity COARSER than the cache window makes the drift
 * unobservable: an hour of staleness cannot change "Yesterday" into anything
 * else, except within an hour of midnight once a day. That is a far smaller and
 * rarer error than being off by an hour every hour, and it needs no client
 * component -- which is what the first attempt used, and it did not survive
 * hydration.
 */
export function dayLabel(then: string, now: Date): string {
  const d = new Date(then);
  if (Number.isNaN(d.getTime())) return "unknown";
  // Compare CALENDAR DAYS in Phoenix, not elapsed hours: a run at 11pm and a
  // read at 1am are two hours apart but belong to different days, and
  // "yesterday" is what a reader means by that.
  const day = (x: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(x);
  const a = day(d);
  const b = day(now);
  if (a === b) return "Today";
  const diff = Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
  if (diff === 1) return "Yesterday";
  if (diff < 0) return "Today"; // clock skew; never render a future day
  return `${diff} days ago`;
}

/** Wall-clock in Phoenix, which is where the schedules are reasoned about. */
export function absoluteLabel(then: string): string {
  const d = new Date(then);
  if (Number.isNaN(d.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

/** What the run actually did, for the tooltip. */
function work(run: RefreshRun): string {
  if (run.sessionsAdded > 0) {
    const s = `${run.sessionsAdded} session${run.sessionsAdded === 1 ? "" : "s"}`;
    return `added ${s} and ${run.barsAdded.toLocaleString()} bars`;
  }
  // Not a failure, and worth saying so plainly: the evening run usually got
  // there first, so "no new sessions" is the normal morning result.
  return "no new sessions to fetch";
}

/** Just the clock time, for pairing with a day word. */
export function timeLabel(then: string): string {
  const d = new Date(then);
  if (Number.isNaN(d.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function buildRefreshStamp(run: RefreshRun, now: Date): RefreshStamp {
  const state = runState(run);
  const stamp = state === "running" ? run.startedAt : (run.finishedAt ?? run.startedAt);
  const absolute = absoluteLabel(stamp);
  const relative = relativeTime(stamp, now);

  const detail =
    state === "running"
      ? `Started ${absolute} and has not finished.`
      : state === "failed"
        ? `Check failed ${absolute}.`
        : `Ran ${absolute}, ${work(run)}.`;

  // What the masthead shows: day word plus clock time, e.g. "Yesterday 3:17 PM MST".
  const label = `${dayLabel(stamp, now)} ${timeLabel(stamp)}`;

  return { state, relative, absolute, label, detail };
}
