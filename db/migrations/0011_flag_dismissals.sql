-- +goose Up
-- Source: docs/02-database.sql (D03, decision D-U)

CREATE TABLE flag_dismissals (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  flag_type     text NOT NULL,
  trade_date    date NOT NULL,
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, flag_type, trade_date)
);

-- +goose Down
DROP TABLE flag_dismissals;
