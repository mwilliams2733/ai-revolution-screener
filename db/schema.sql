-- AI Revolution screener: cached price + reference data.
-- Target: Neon Postgres. Safe to re-run; every statement is IF NOT EXISTS.
--
-- Two distinct jobs live here, with very different sizes:
--   1. The live screen reads FIVE sessions only (now, r1m, r3m, r6m, r12m).
--      See lib/factors.ts computeRows: the 200d MA is a five-point proxy, not
--      a 200-bar average.
--   2. The 250-session backfill exists for backtests not yet written, and is
--      what actually consumes storage.
--
-- Sizing: ~12,500 bars/session. 250 sessions is ~3.1M rows, roughly 300-350 MB
-- with the primary key, which is tight against Neon's 0.5 GB free tier. See
-- the note on liquid_only at the bottom before committing to a full backfill.

-- ---------------------------------------------------------------------------
-- Reference universe
-- ---------------------------------------------------------------------------

-- Stores BOTH active and delisted names. Delisted rows are the whole point:
-- /v3/reference/tickers?active=true omits them, and a backtest built on a
-- live-only universe inherits survivorship bias that cannot be reconstructed
-- after the fact. See HANDOFF.md, "Survivorship bias will bite any backtest".
CREATE TABLE IF NOT EXISTS tickers (
  ticker            TEXT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  primary_exchange  TEXT,
  -- Zero-padded to 10 digits, ready for SEC EDGAR companyfacts.
  cik               CHAR(10),
  active            BOOLEAN NOT NULL,
  -- SEC SIC code and the filer's own description of it, from EDGAR
  -- submissions. Populated by scripts/sectors.ts; see lib/sic.ts for what the
  -- taxonomy is and is not good for. Null means never fetched, which is
  -- different from a filer that has no code -- the backfill is resumable and
  -- uses the null to know what is left.
  sic               TEXT,
  sic_description   TEXT,
  delisted_utc      TIMESTAMPTZ,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickers_active_idx ON tickers (active);
CREATE INDEX IF NOT EXISTS tickers_cik_idx    ON tickers (cik) WHERE cik IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Daily bars
-- ---------------------------------------------------------------------------

-- One row per (session, ticker). Column names mirror lib/types.ts Bar so the
-- mapping into barsByTicker() stays trivial.
CREATE TABLE IF NOT EXISTS daily_bars (
  session  DATE             NOT NULL,
  ticker   TEXT             NOT NULL,
  open     DOUBLE PRECISION,
  -- Intraday extremes, needed for the 52-week high/low in the trend template.
  -- They cannot be derived from closes, and grouped-daily returns them free.
  high     DOUBLE PRECISION,
  low      DOUBLE PRECISION,
  close    DOUBLE PRECISION NOT NULL,
  volume   DOUBLE PRECISION NOT NULL DEFAULT 0,
  vwap     DOUBLE PRECISION,
  PRIMARY KEY (session, ticker)
);

-- The screen fetches whole sessions at once, which the PK already serves.
-- This second index serves per-ticker history for backtests and charts.
CREATE INDEX IF NOT EXISTS daily_bars_ticker_idx ON daily_bars (ticker, session DESC);

-- ---------------------------------------------------------------------------
-- Session ledger
-- ---------------------------------------------------------------------------

-- Which sessions are actually stored, and which are confirmed non-sessions.
--
-- This exists so a resumed backfill asks "which dates are missing" rather than
-- "how far did the loop get". The two are not the same: the grouped endpoint
-- answers HTTP 200 with zero results on weekends and market holidays, so a
-- loop that equates "no error" with "stored" silently skips ~10 days a year.
-- Backfills may also be interrupted, leaving gaps that are not a contiguous
-- prefix.
CREATE TABLE IF NOT EXISTS sessions (
  session     DATE PRIMARY KEY,
  bar_count   INTEGER NOT NULL,
  -- false = confirmed market holiday or weekend (200 OK, zero results).
  is_trading  BOOLEAN NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dates known to be trading sessions with bars stored. A backfill computes its
-- work as (candidate sessions) MINUS (this view) and never assumes contiguity.
CREATE OR REPLACE VIEW stored_sessions AS
  SELECT session FROM sessions WHERE is_trading AND bar_count > 0;

-- ---------------------------------------------------------------------------
-- Refresh log
-- ---------------------------------------------------------------------------

-- Cron observability: whether the nightly refresh actually ran and what it did.
CREATE TABLE IF NOT EXISTS refresh_runs (
  id             BIGSERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  kind           TEXT NOT NULL,              -- 'backfill' | 'nightly' | 'manual'
  sessions_added INTEGER NOT NULL DEFAULT 0,
  bars_added     INTEGER NOT NULL DEFAULT 0,
  ok             BOOLEAN,
  error          TEXT
);

-- ---------------------------------------------------------------------------
-- Tier history
-- ---------------------------------------------------------------------------

-- One row per ticker per screen run, so tier CHANGES can be diffed for the
-- Resend alerts in build step 8. Without this the app can only ever show the
-- current state, and "LITE dropped from Strong Buy to Buy" is unanswerable.
CREATE TABLE IF NOT EXISTS tier_history (
  session  DATE             NOT NULL,
  ticker   TEXT             NOT NULL,
  rs_pct   DOUBLE PRECISION,
  vs_ma    DOUBLE PRECISION,
  tier     TEXT,                             -- 'Strong Buy' | 'Buy' | 'Hold'
  -- The tier before the stage, fundamental and cap overlays. Hysteresis
  -- compares against this, not the final tier: the overlays only ever demote,
  -- so comparing a capped tier to a fresh momentum tier would read every cap as
  -- a change and defeat the band.
  momentum_tier TEXT,
  weight   DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- How this row was produced. 'live' means the refresh computed it on the day
  -- from that day's data and nothing later; 'replay' means it was
  -- reconstructed afterwards by scripts/replay-tiers.ts.
  --
  -- The distinction is load-bearing twice over. Alerts refuse to fire against a
  -- replayed baseline, because a replay runs a slightly different ruleset (no
  -- fundamental gate) and diffing across the two reports changes that never
  -- happened -- which is exactly how two junk alerts went out on 2026-08-22.
  -- And the live rows are the ONLY genuinely out-of-sample evidence this
  -- project will ever accumulate, so the replay is forbidden from overwriting
  -- them; see the guarded ON CONFLICT in scripts/replay-tiers.ts.
  --
  -- Defaults to 'replay' on purpose: an unlabelled row must never be mistaken
  -- for out-of-sample evidence.
  source   TEXT             NOT NULL DEFAULT 'replay'
                            CHECK (source IN ('live', 'replay')),
  PRIMARY KEY (session, ticker)
);

CREATE INDEX IF NOT EXISTS tier_history_ticker_idx ON tier_history (ticker, session DESC);

-- ---------------------------------------------------------------------------
-- Storage note
-- ---------------------------------------------------------------------------
--
-- A full 250-session backfill of all ~12,500 names is ~3.1M rows. If Neon's
-- free tier gets tight, the lever is to store only names that cleared the
-- liquidity gate that session (price >= $5, dollar volume >= $10M), which is
-- ~2,200 names and drops the backfill to ~550k rows.
--
-- That is a real trade-off, not a free win: filtering at write time bakes
-- today's liquidity threshold into stored history, so a future backtest cannot
-- lower minDollarVolume without refetching. Decide deliberately.

-- ---------------------------------------------------------------------------

-- Splits whose price history has been re-fetched.
--
-- Polygon restates a ticker's whole price history when a split executes, and
-- scripts/backfill.ts never re-fetches a session it already stored -- its work
-- list is a set difference over SESSIONS, which cannot see that an existing
-- session's values changed. Without this ledger a 10:1 reverse split would
-- leave the pre-split bars on the old basis and manufacture a +900% twelve-month
-- return, sending that name to RS 99.
--
-- A ledger rather than a watermark on purpose: a high-water date assumes every
-- split before it was handled, so one failed repair in the middle is skipped
-- forever, and a split discovered later with an older execution date is never
-- done at all.
CREATE TABLE IF NOT EXISTS split_refetch (
  ticker         TEXT NOT NULL,
  execution_date DATE NOT NULL,
  done_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, execution_date)
);

-- ---------------------------------------------------------------------------

-- Emails actually delivered, so a second caller skips instead of re-sending.
--
-- vercel.json and .github/workflows/schedule.yml declare the SAME two
-- schedules on purpose: a Vercel cron is registered by a deployment, so a
-- blocked deploy silently leaves the old schedule live, and GitHub Actions runs
-- against whatever is already deployed. That redundancy is wanted. What it
-- costs, without this table, is duplicate delivery -- the routes are idempotent
-- in what they WRITE, but sending an email twice is not a write.
--
-- The two kinds key differently, and the asymmetry is the point:
--   digest:<utc-date>  -- one per DAY. The digest is a heartbeat and must
--                         arrive even when the data has not moved; keying it
--                         on the session would make a stalled pipeline send
--                         once and then go quiet, which is the exact failure
--                         the digest exists to reveal.
--   alert:<asOf>       -- one per SESSION. The alert diffs against the previous
--                         session, so re-running the refresh on the same asOf
--                         recomputes an identical change set and would report
--                         the morning's moves again in the afternoon.
--
-- A row is CLAIMED before the send (one atomic INSERT, so two schedulers
-- inside the same seconds cannot both win) and DELETED again if the send
-- fails, so a failed delivery never marks the day as done. See
-- claimMailSend / releaseMailSend in lib/db.ts.
CREATE TABLE IF NOT EXISTS mail_sends (
  kind       TEXT NOT NULL,              -- 'digest' | 'alert'
  dedupe_key TEXT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, dedupe_key)
);

-- EDGAR fundamentals for the fundamental gate, one row per ticker.
-- facts is lib/edgar.ts Fundamentals as JSON, or NULL for "fetched, no usable
-- SEC data" so foreign issuers are not re-fetched nightly. Rows older than
-- 7 days are re-fetched (lib/fundamentals-store.ts). Created by its consumer.
CREATE TABLE IF NOT EXISTS company_fundamentals (
  ticker     TEXT PRIMARY KEY,
  facts      JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Yesterday's hysteresis band tier for every ranked name OUTSIDE the AI book.
-- Kept apart from tier_history on purpose: tier_history feeds alerts, the
-- replay guard, turnover stats, the cohort view and the backtest, and none of
-- them should see market-wide rows. Pruned to the last 10 sessions.
CREATE TABLE IF NOT EXISTS market_band_tiers (
  session   DATE NOT NULL,
  ticker    TEXT NOT NULL,
  band_tier TEXT,
  PRIMARY KEY (session, ticker)
);

-- Signal Trader (paper only). Created by lib/signal-trader/store.ts ensureSchema.
-- One row per processed session; the PRIMARY KEY makes a second run for the
-- same session roll back its whole transaction (idempotency).
CREATE TABLE IF NOT EXISTS st_sessions (
  session      DATE PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT
);
CREATE TABLE IF NOT EXISTS st_account (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  cash   DOUBLE PRECISION NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS st_signals (
  session DATE NOT NULL, ticker TEXT NOT NULL, signal TEXT NOT NULL,
  acted BOOLEAN NOT NULL, note TEXT,
  PRIMARY KEY (session, ticker, signal)
);
CREATE TABLE IF NOT EXISTS st_picks (
  pick_key TEXT PRIMARY KEY, decided_session DATE NOT NULL, ticker TEXT NOT NULL,
  signal TEXT NOT NULL, window_days INTEGER NOT NULL, expected_move DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,               -- pending | open | closed | cancelled
  note TEXT
);
CREATE TABLE IF NOT EXISTS st_positions (
  pick_key TEXT PRIMARY KEY REFERENCES st_picks(pick_key), ticker TEXT NOT NULL,
  signal TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL, entry_price DOUBLE PRECISION NOT NULL,
  entry_session DATE NOT NULL, stop_price DOUBLE PRECISION NOT NULL,
  sessions_held INTEGER NOT NULL, window_days INTEGER NOT NULL,
  expected_move DOUBLE PRECISION NOT NULL, close_requested_at TIMESTAMPTZ,
  status TEXT NOT NULL,               -- open | closed
  exit_price DOUBLE PRECISION, exit_session DATE, exit_reason TEXT, realized_return DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS st_fills (
  pick_key TEXT NOT NULL, side TEXT NOT NULL, session DATE NOT NULL,
  qty DOUBLE PRECISION NOT NULL, price DOUBLE PRECISION NOT NULL, note TEXT,
  PRIMARY KEY (pick_key, side)
);
CREATE TABLE IF NOT EXISTS st_marks (
  pick_key TEXT NOT NULL, session DATE NOT NULL, price DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (pick_key, session)
);
CREATE TABLE IF NOT EXISTS st_grades (
  pick_key TEXT PRIMARY KEY, signal TEXT NOT NULL, ticker TEXT NOT NULL,
  entry_session DATE NOT NULL, exit_session DATE NOT NULL,
  realized_return DOUBLE PRECISION NOT NULL, spy_return DOUBLE PRECISION,
  excess_return DOUBLE PRECISION, hit BOOLEAN NOT NULL, pnl DOUBLE PRECISION NOT NULL,
  expected_move DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS st_runs (
  id BIGSERIAL PRIMARY KEY, job TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  status TEXT, note TEXT
);
