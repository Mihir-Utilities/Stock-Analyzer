-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

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

-- +goose Down
DROP TABLE IF EXISTS alert_event;
DROP TABLE IF EXISTS alert;
DROP TABLE IF EXISTS portfolio_adjustment;
DROP TABLE IF EXISTS portfolio_txn;
DROP TABLE IF EXISTS watchlist_item;
DROP TABLE IF EXISTS telegram_link_code;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS app_user;
