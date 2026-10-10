-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy search (confirm availability on Neon)

-- Keys include PRICES_ALREADY_ADJUSTED (absent until the owner chooses; blocks prices commit while absent), RISK_FREE_RATE, DB_SOFT_LIMIT_MB, ...
CREATE TABLE app_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE market_holiday (
  holiday_date date NOT NULL,
  segment      text NOT NULL DEFAULT 'trading' CHECK (segment IN ('trading','clearing')),
  description  text,
  source       text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','import')),  -- no auto-detected holidays
  PRIMARY KEY (holiday_date, segment)
);

-- +goose Down
DROP TABLE IF EXISTS market_holiday;
DROP TABLE IF EXISTS app_setting;
DROP EXTENSION IF EXISTS pg_trgm;
