-- 02-database.sql  (Safe Edition; PostgreSQL 15+; verify on Neon: spike S10)
-- Conventions:
--  * Dates of market data are market dates in IST stored as DATE. Timestamps are timestamptz (UTC).
--  * Market prices: double precision. User money (portfolio): numeric(18,4).
--  * Natural-key upserts everywhere; every ingest is idempotent.
--  * Migrations are forward-only (goose). This file is the target end state of migrations 0001..N;
--    Claude Code must split it into ordered migrations, never edit an applied one.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy search (confirm availability on Neon)

-- ---------------------------------------------------------------------------
-- Settings and operations
-- ---------------------------------------------------------------------------
CREATE TABLE app_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE market_holiday (
  holiday_date date NOT NULL,
  segment      text NOT NULL DEFAULT 'trading' CHECK (segment IN ('trading','clearing')),
  description  text,
  PRIMARY KEY (holiday_date, segment)
);

CREATE TABLE ingestion_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job           text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed','skipped')),
  rows_written  integer NOT NULL DEFAULT 0,
  items_total   integer,
  items_failed  integer NOT NULL DEFAULT 0,
  error         text,
  details       jsonb
);
CREATE INDEX ingestion_run_job_started_idx ON ingestion_run (job, started_at DESC);
-- at most one running instance per job:
CREATE UNIQUE INDEX ingestion_run_one_running_uq ON ingestion_run (job) WHERE status = 'running';

CREATE TABLE source_health (
  source        text PRIMARY KEY,                 -- broker, mfapi, amfi, telegram
  checked_at    timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL,
  latency_ms    integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_until timestamptz,                     -- circuit breaker
  note          text
);

CREATE TABLE refresh_job (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('stock_refresh','stock_backfill','mf_refresh')),
  target        text NOT NULL,                    -- symbol or scheme code
  requested_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ok','partial','failed','cancelled')),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  result        jsonb
);
-- dedupe: one active job per (kind,target)
CREATE UNIQUE INDEX refresh_job_active_uq ON refresh_job (kind, target) WHERE status IN ('queued','running');
CREATE INDEX refresh_job_recent_idx ON refresh_job (kind, target, requested_at DESC);

CREATE TABLE broker_session (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  broker        text NOT NULL,                    -- 'angelone','fyers','upstox','dhan' (chosen in spike S1)
  token_enc     bytea NOT NULL,                   -- AES-256-GCM(nonce||ciphertext||tag) of the access token; key from env BROKER_TOKEN_KEY
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX broker_session_one_active_uq ON broker_session (broker) WHERE status = 'active';

CREATE TABLE broker_oauth_state (
  state_hash    bytea PRIMARY KEY,                -- sha256 of the random state
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

CREATE TABLE import_batch (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('prices','results_quarterly','results_annual','balance_cashflow','fundamentals_long','shareholding','corporate_actions','instrument_meta','screener_xlsx','manual_form')),
  filename      text,
  sha256        bytea,
  row_count     integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  note          text,                             -- e.g. 'as per company filing dated 2026-08-12'
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Instruments (stocks)
-- ---------------------------------------------------------------------------
CREATE TABLE instrument (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol          text NOT NULL,                  -- NSE symbol exactly as listed, e.g. 'M&M', 'BAJAJ-AUTO'
  name            text NOT NULL,
  isin            text,
  series          text NOT NULL DEFAULT 'EQ',     -- EQ, BE, BZ, SM, ...
  listing_date    date,
  face_value      numeric(10,2),
  sector          text,                           -- from owner's instrument_meta import only
  industry        text,
  company_type    text NOT NULL DEFAULT 'general' CHECK (company_type IN ('general','financial')),
  broker_key      text,                           -- instrument key in the chosen broker's master (e.g. 'NSE_EQ|INE...'); NULL in manual price mode
  broker_ok       boolean NOT NULL DEFAULT false, -- broker served candles for this instrument at last probe
  broker_checked_at timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','delisted','symbol_changed')),
  instrument_kind text NOT NULL DEFAULT 'equity' CHECK (instrument_kind IN ('equity','etf','reit','invit','sme','other')),
  is_tracked      boolean NOT NULL DEFAULT false, -- nightly price updates + history retained
  tracked_reason  text CHECK (tracked_reason IN ('training_basket','watchlist','portfolio','opened')),
  last_opened_at  timestamptz,
  last_seen_in_master date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instrument_symbol_uq UNIQUE (symbol)
);
CREATE INDEX instrument_symbol_trgm ON instrument USING gin (symbol gin_trgm_ops);
CREATE INDEX instrument_name_trgm   ON instrument USING gin (name gin_trgm_ops);
CREATE INDEX instrument_tracked_idx ON instrument (is_tracked) WHERE is_tracked;
CREATE INDEX instrument_sector_idx  ON instrument (sector, industry);

CREATE TABLE symbol_alias (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  old_symbol    text NOT NULL,
  changed_on    date,
  PRIMARY KEY (instrument_id, old_symbol)
);
CREATE INDEX symbol_alias_old_idx ON symbol_alias (old_symbol);

CREATE TABLE index_constituent (
  index_name    text NOT NULL,                    -- 'NIFTY 50','NIFTY NEXT 50','NIFTY 500', sector indices
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  PRIMARY KEY (index_name, instrument_id)
);

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------
CREATE TABLE price_daily (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  trade_date    date NOT NULL,
  open          double precision NOT NULL,
  high          double precision NOT NULL,
  low           double precision NOT NULL,
  close         double precision NOT NULL,        -- as stored from source (raw unless BROKER_PRICES_ADJUSTED=true)
  adj_close     double precision NOT NULL,        -- close x cumulative factor of CONFIRMED split/bonus actions after the date; dividends NOT adjusted
  volume        bigint NOT NULL DEFAULT 0,
  source        text NOT NULL CHECK (source IN ('broker','import')),
  suspect       boolean NOT NULL DEFAULT false,   -- failed a sanity rule; excluded from analytics
  PRIMARY KEY (instrument_id, trade_date),
  CONSTRAINT price_positive CHECK (open > 0 AND high > 0 AND low > 0 AND close > 0 AND adj_close > 0),
  CONSTRAINT price_ohlc_consistent CHECK (high >= low)
);

CREATE TABLE quote_latest (
  instrument_id integer PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
  quote_ts      timestamptz NOT NULL,             -- when the source says the quote is from
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  ltp           double precision NOT NULL,
  prev_close    double precision,
  day_open      double precision,
  day_high      double precision,
  day_low       double precision,
  volume        bigint,
  wk52_high     double precision,
  wk52_low      double precision,
  market_cap_cr double precision,
  source        text NOT NULL
);

CREATE TABLE market_series (
  code          text NOT NULL,                    -- NIFTY50, INDIAVIX (and other index codes only if the broker serves them)
  trade_date    date NOT NULL,
  value         double precision NOT NULL,
  PRIMARY KEY (code, trade_date)
);

-- ---------------------------------------------------------------------------
-- Fundamentals (long format, one winning row per natural key; see 05-analytics-spec.md section 2)
-- ---------------------------------------------------------------------------
CREATE TABLE fundamental_value (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  basis         text NOT NULL CHECK (basis IN ('consolidated','standalone')),
  period_type   text NOT NULL CHECK (period_type IN ('Q','A')),
  period_end    date NOT NULL,                    -- fiscal period end date, e.g. 2026-09-30
  metric_key    text NOT NULL,                    -- canonical key e.g. 'pnl.revenue'
  value         double precision,                 -- NULL means reported-but-missing
  unit          text NOT NULL DEFAULT 'INR_CR' CHECK (unit IN ('INR_CR','INR','PERCENT','RATIO','SHARES','COUNT')),
  source        text NOT NULL CHECK (source IN ('manual','csv_import','screener_import','derived')),
  import_batch_id bigint,                         -- FK added after import_batch is created
  filed_on      date,                             -- when it became public (for no-lookahead ML)
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, basis, period_type, period_end, metric_key, source)
);
CREATE INDEX fundamental_lookup_idx ON fundamental_value (instrument_id, period_type, metric_key, period_end DESC);

CREATE TABLE fundamental_meta (
  instrument_id integer PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
  basis_used    text CHECK (basis_used IN ('consolidated','standalone')),
  last_fetched  timestamptz,
  last_success  timestamptz,
  parse_version text,
  status        text NOT NULL DEFAULT 'none' CHECK (status IN ('none','ok','partial','parse_error','source_error')),
  periods_q     integer NOT NULL DEFAULT 0,
  periods_a     integer NOT NULL DEFAULT 0,
  error         text
);

CREATE TABLE top_ratio (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  key           text NOT NULL,                    -- 'market_cap','pe','pb','roe','roce','dividend_yield','book_value','face_value'
  value_num     double precision,
  value_text    text,
  source        text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, key)
);

-- ---------------------------------------------------------------------------
-- Ownership, actions, events
-- ---------------------------------------------------------------------------
CREATE TABLE shareholding (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  quarter_end   date NOT NULL,
  promoter_pct  real, fii_pct real, dii_pct real, mf_pct real, insurance_pct real,
  govt_pct      real, public_pct real, other_pct real,
  promoter_pledged_pct real,                      -- % of promoter holding pledged (NULL = unknown, never 0 by default)
  shareholders_count integer,
  filed_on      date,
  revision      integer NOT NULL DEFAULT 0,
  source        text NOT NULL CHECK (source IN ('manual','csv_import','screener_import')),
  import_batch_id bigint,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, quarter_end)
);

CREATE TABLE corporate_action (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  ex_date       date NOT NULL,
  record_date   date,
  action_type   text NOT NULL CHECK (action_type IN ('split','bonus','split_or_bonus','dividend','rights','buyback','merger','demerger','other')),
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('detected','confirmed','rejected')),  -- 'detected' = heuristic from price gap, needs owner confirmation
  ratio_num     numeric(12,4),                    -- see 05-analytics-spec.md section 8 for meaning
  ratio_den     numeric(12,4),
  amount_per_share numeric(14,4),                 -- dividends
  purpose_text  text NOT NULL DEFAULT '',         -- owner's note/purpose text
  parsed_ok     boolean NOT NULL DEFAULT true,
  source        text NOT NULL CHECK (source IN ('manual','csv_import','detected')),
  import_batch_id bigint,
  UNIQUE (instrument_id, ex_date, action_type, purpose_text)
);
CREATE INDEX corporate_action_idx ON corporate_action (instrument_id, ex_date DESC);

CREATE TABLE event_calendar (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  event_date    date NOT NULL,
  event_type    text NOT NULL CHECK (event_type IN ('results','board_meeting','dividend','agm','other')),
  details       text,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv_import')),
  UNIQUE (instrument_id, event_date, event_type)
);
CREATE INDEX event_calendar_date_idx ON event_calendar (event_date);

-- ---------------------------------------------------------------------------
-- Analysis and ML
-- ---------------------------------------------------------------------------
CREATE TABLE analysis_snapshot (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  indicators    jsonb NOT NULL,
  scores        jsonb NOT NULL,                   -- trend, risk, quality, with components and coverage
  version       text NOT NULL,
  PRIMARY KEY (instrument_id, as_of)
);

CREATE TABLE screener_row (                       -- precomputed for the screener; one row per instrument
  instrument_id integer PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  metrics       jsonb NOT NULL                    -- keys whitelisted in 03-api-spec.md section 9
);

CREATE TABLE model_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_name    text NOT NULL,                    -- 'dir_5d','dir_21d','range_5d','range_21d'
  trained_at    timestamptz NOT NULL DEFAULT now(),
  train_start   date NOT NULL, train_end date NOT NULL,
  n_rows        integer NOT NULL,
  valid_metrics jsonb NOT NULL,
  baseline_metrics jsonb NOT NULL,
  guardrail_pass boolean NOT NULL,
  artifact      bytea,                            -- small model blob, or NULL if stored externally
  artifact_uri  text,
  status        text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','retired'))
);

CREATE TABLE prediction (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,                    -- last trading date of data used
  horizon_days  smallint NOT NULL CHECK (horizon_days IN (5,21)),
  model_run_id  bigint NOT NULL REFERENCES model_run(id),
  p_up          real,
  ret_q10       real, ret_q50 real, ret_q90 real,
  ref_close     double precision NOT NULL,        -- adj_close at as_of
  shown         boolean NOT NULL DEFAULT false,   -- false if guardrail/insufficient data
  hidden_reason text,
  UNIQUE (instrument_id, as_of, horizon_days, model_run_id)
);

CREATE TABLE prediction_outcome (
  prediction_id bigint PRIMARY KEY REFERENCES prediction(id) ON DELETE CASCADE,
  resolved_on   date NOT NULL,
  realized_return real NOT NULL,
  direction_correct boolean,
  in_band       boolean
);

-- ---------------------------------------------------------------------------
-- Mutual funds
-- ---------------------------------------------------------------------------
CREATE TABLE mf_scheme (
  code          integer PRIMARY KEY,              -- AMFI scheme code
  name          text NOT NULL,
  fund_house    text,
  scheme_type   text,
  category      text,
  plan          text CHECK (plan IN ('direct','regular','unknown')),
  option_type   text CHECK (option_type IN ('growth','idcw','unknown')),
  isin_growth   text, isin_div_reinvest text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_tracked    boolean NOT NULL DEFAULT false,
  last_opened_at timestamptz,
  last_nav_date date,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mf_scheme_name_trgm ON mf_scheme USING gin (name gin_trgm_ops);
CREATE INDEX mf_scheme_cat_idx ON mf_scheme (category, plan, option_type);

CREATE TABLE mf_nav (
  scheme_code   integer NOT NULL REFERENCES mf_scheme(code) ON DELETE CASCADE,
  nav_date      date NOT NULL,
  nav           double precision NOT NULL CHECK (nav > 0),
  PRIMARY KEY (scheme_code, nav_date)
);

CREATE TABLE mf_return_cache (
  scheme_code   integer PRIMARY KEY REFERENCES mf_scheme(code) ON DELETE CASCADE,
  as_of         date NOT NULL,
  metrics       jsonb NOT NULL
);

-- ---------------------------------------------------------------------------
-- User features (single user, user_id kept for future-proofing)
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- exactly one user
  password_hash text NOT NULL,                    -- argon2id encoded string
  telegram_chat_id bigint,
  quiet_hours   jsonb,                            -- {"start":"22:00","end":"07:00","tz":"Asia/Kolkata"}
  display_prefs jsonb NOT NULL DEFAULT '{"number_format":"indian","theme":"dark","show_experimental":true}',
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    bytea NOT NULL UNIQUE,            -- sha256 of the random token
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            inet,
  user_agent    text,
  revoked_at    timestamptz
);

CREATE TABLE telegram_link_code (
  code_hash     bytea PRIMARY KEY,                -- sha256 of the one-time code
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

CREATE TABLE watchlist_item (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer REFERENCES instrument(id) ON DELETE CASCADE,
  mf_scheme_code integer REFERENCES mf_scheme(code) ON DELETE CASCADE,
  note          text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchlist_exactly_one CHECK ((instrument_id IS NOT NULL)::int + (mf_scheme_code IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX watchlist_stock_uq ON watchlist_item (instrument_id) WHERE instrument_id IS NOT NULL;
CREATE UNIQUE INDEX watchlist_mf_uq    ON watchlist_item (mf_scheme_code) WHERE mf_scheme_code IS NOT NULL;

CREATE TABLE portfolio_txn (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id),
  side          text NOT NULL CHECK (side IN ('buy','sell')),
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),
  price         numeric(18,4) NOT NULL CHECK (price > 0),   -- per share, as at trade date (pre-split units)
  fees          numeric(18,4) NOT NULL DEFAULT 0 CHECK (fees >= 0),
  trade_date    date NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portfolio_txn_idx ON portfolio_txn (instrument_id, trade_date, id);

CREATE TABLE portfolio_adjustment (               -- user overrides of auto corporate-action adjustments
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id),
  corporate_action_id bigint REFERENCES corporate_action(id),
  effective_date date NOT NULL,
  qty_multiplier numeric(18,8) NOT NULL CHECK (qty_multiplier > 0),
  note          text,
  UNIQUE (instrument_id, effective_date, corporate_action_id)
);

CREATE TABLE alert (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_type   text NOT NULL CHECK (target_type IN ('stock','mf')),
  instrument_id integer REFERENCES instrument(id) ON DELETE CASCADE,
  mf_scheme_code integer REFERENCES mf_scheme(code) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'price_above','price_below','day_change_pct','wk52_high','wk52_low','ma_cross',
                  'rsi_above','rsi_below','results_upcoming','results_declared',
                  'holding_change','nav_above','nav_below')),
  params        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','fired','expired')),
  one_shot      boolean NOT NULL DEFAULT true,
  cooldown_minutes integer NOT NULL DEFAULT 1440 CHECK (cooldown_minutes >= 0),
  expires_on    date,
  last_fired_at timestamptz,
  last_state    jsonb,                            -- evaluator memory (e.g., previous side of the threshold)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_target_chk CHECK (
    (target_type = 'stock' AND instrument_id IS NOT NULL AND mf_scheme_code IS NULL) OR
    (target_type = 'mf'    AND mf_scheme_code IS NOT NULL AND instrument_id IS NULL))
);
CREATE INDEX alert_active_idx ON alert (status) WHERE status = 'active';

CREATE TABLE alert_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id      bigint NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  dedupe_key    text NOT NULL,                    -- e.g. alert_id|kind|market_date|threshold
  payload       jsonb NOT NULL,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','failed','skipped_quiet_hours')),
  delivery_attempts integer NOT NULL DEFAULT 0,
  delivered_at  timestamptz,
  last_error    text,
  UNIQUE (alert_id, dedupe_key)
);

-- Foreign keys to import_batch added after all tables exist (keeps ordering simple)
ALTER TABLE fundamental_value ADD CONSTRAINT fundamental_value_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;
ALTER TABLE shareholding      ADD CONSTRAINT shareholding_batch_fk      FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;
ALTER TABLE corporate_action  ADD CONSTRAINT corporate_action_batch_fk  FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE SET NULL;
