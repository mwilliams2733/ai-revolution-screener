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
  -- Intraday extremes. Needed for the 52-week high/low in the trend template;
  -- they cannot be derived from closes, and grouped-daily returns them free.
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
  weight   DOUBLE PRECISION NOT NULL DEFAULT 0,
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
