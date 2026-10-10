-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

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

-- Validated uploads awaiting commit. UNLOGGED (cheap, truncated after a crash; the owner re-uploads). 1 h TTL; deleted on commit and by housekeeping.
CREATE UNLOGGED TABLE import_upload (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL,
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX import_upload_expires_idx ON import_upload (expires_at);

CREATE TABLE import_batch (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('prices','results_quarterly','results_annual','balance_cashflow','fundamentals_long','shareholding','corporate_actions','instrument_meta','instruments','holidays','screener_xlsx','manual_form')),
  upload_group  uuid,                             -- logical batch when a large prices file is split in the browser (S9 fallback); one transaction at commit
  filename      text,
  sha256        bytea,
  row_count     integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  note          text,                             -- e.g. 'as per company filing dated 2026-08-12'
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);

-- +goose Down
DROP TABLE IF EXISTS import_batch;
DROP TABLE IF EXISTS import_upload;
DROP TABLE IF EXISTS broker_oauth_state;
DROP TABLE IF EXISTS broker_session;
