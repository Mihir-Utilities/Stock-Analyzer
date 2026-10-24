-- +goose Up
-- Source: docs/02-database.sql (B11, docs/03 section 1 Idempotency)

CREATE TABLE idempotency_key (
  key          uuid PRIMARY KEY,
  scope        text NOT NULL,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_key_created_idx ON idempotency_key (created_at);

-- +goose Down
DROP TABLE idempotency_key;
