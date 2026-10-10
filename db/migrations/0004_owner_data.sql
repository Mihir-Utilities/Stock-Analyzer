-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

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

-- +goose Down
DROP TABLE IF EXISTS event_calendar;
DROP TABLE IF EXISTS corporate_action;
DROP TABLE IF EXISTS shareholding;
DROP TABLE IF EXISTS top_ratio;
DROP TABLE IF EXISTS fundamental_meta;
DROP TABLE IF EXISTS fundamental_value;
