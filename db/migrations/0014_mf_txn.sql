-- +goose Up
-- Source: docs/02-database.sql (B15, decisions D-MF, D-MF3; questions MFH-2, MFH-6, MFH-12, MFH-23, MFH-24)

CREATE TABLE mf_txn (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheme_code     integer NOT NULL REFERENCES mf_scheme(code) ON DELETE RESTRICT,
  folio           text NOT NULL CHECK (length(btrim(folio)) BETWEEN 1 AND 40),
  txn_type        text NOT NULL CHECK (txn_type IN ('purchase','sip','redemption','switch_in','switch_out','idcw_payout','idcw_reinvest','bonus_merger')),
  txn_date        date NOT NULL,
  units           numeric(18,4) NOT NULL CHECK (units > 0),
  nav             numeric(18,4) NOT NULL CHECK (nav > 0),
  amount          numeric(18,4) NOT NULL CHECK (amount > 0),
  stamp_duty      numeric(18,4) NOT NULL DEFAULT 0 CHECK (stamp_duty >= 0),
  source          text NOT NULL CHECK (source IN ('manual','import')),
  external_ref    text,
  fund_name       text,
  fund_name_key   text,
  dedupe_key      text,
  import_batch_id bigint REFERENCES import_batch(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mf_txn_seq_idx ON mf_txn (scheme_code, folio, txn_date, id);
CREATE INDEX mf_txn_date_idx ON mf_txn (txn_date, id);
CREATE UNIQUE INDEX mf_txn_dedupe_uq ON mf_txn (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX mf_txn_batch_idx ON mf_txn (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX mf_txn_fundkey_idx ON mf_txn (fund_name_key) WHERE fund_name_key IS NOT NULL;

CREATE TABLE mf_fund_name_map (
  fund_name_key text PRIMARY KEY,
  fund_name     text NOT NULL,
  scheme_code   integer NOT NULL REFERENCES mf_scheme(code) ON DELETE RESTRICT,
  audit_note    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mf_scheme_isin_growth_idx ON mf_scheme (isin_growth) WHERE isin_growth IS NOT NULL;
CREATE INDEX mf_scheme_isin_reinv_idx ON mf_scheme (isin_div_reinvest) WHERE isin_div_reinvest IS NOT NULL;

ALTER TABLE import_batch DROP CONSTRAINT import_batch_kind_check;
ALTER TABLE import_batch ADD CONSTRAINT import_batch_kind_check CHECK (kind IN ('prices','results_quarterly','results_annual','balance_cashflow','fundamentals_long','shareholding','corporate_actions','instrument_meta','instruments','holidays','screener_xlsx','manual_form','mf_statement'));

-- +goose Down
DELETE FROM import_batch WHERE kind = 'mf_statement';
ALTER TABLE import_batch DROP CONSTRAINT import_batch_kind_check;
ALTER TABLE import_batch ADD CONSTRAINT import_batch_kind_check CHECK (kind IN ('prices','results_quarterly','results_annual','balance_cashflow','fundamentals_long','shareholding','corporate_actions','instrument_meta','instruments','holidays','screener_xlsx','manual_form'));
DROP INDEX mf_scheme_isin_reinv_idx;
DROP INDEX mf_scheme_isin_growth_idx;
DROP TABLE mf_fund_name_map;
DROP TABLE mf_txn;
