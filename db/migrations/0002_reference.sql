-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

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
  tracked_reason  text CHECK (tracked_reason IN ('watchlist','portfolio','opened','imported')),
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

-- +goose Down
DROP TABLE IF EXISTS index_constituent;
DROP TABLE IF EXISTS symbol_alias;
DROP TABLE IF EXISTS instrument;
