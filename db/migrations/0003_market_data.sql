-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

CREATE TABLE price_daily (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  trade_date    date NOT NULL,
  open          double precision NOT NULL,
  high          double precision NOT NULL,
  low           double precision NOT NULL,
  close         double precision NOT NULL,        -- as stored from source (raw or adjusted according to src_adjusted)
  adj_close     double precision NOT NULL,        -- close x cumulative factor of CONFIRMED split/bonus actions after the date; dividends NOT adjusted
  volume        bigint NOT NULL DEFAULT 0,
  source        text NOT NULL CHECK (source IN ('broker','import')),
  src_adjusted  boolean NOT NULL DEFAULT false,   -- copy of app_setting PRICES_ALREADY_ADJUSTED at import time; true => adj_close = close, never multiplied by action factors
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
  code          text NOT NULL,                    -- NIFTY50, INDIAVIX: filled from the reserved symbols in prices.csv (manual price mode)
  trade_date    date NOT NULL,
  value         double precision NOT NULL,
  PRIMARY KEY (code, trade_date)
);

-- +goose Down
DROP TABLE IF EXISTS market_series;
DROP TABLE IF EXISTS quote_latest;
DROP TABLE IF EXISTS price_daily;
