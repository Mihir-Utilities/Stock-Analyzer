-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

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

-- +goose Down
DROP TABLE IF EXISTS mf_return_cache;
DROP TABLE IF EXISTS mf_nav;
DROP TABLE IF EXISTS mf_scheme;
