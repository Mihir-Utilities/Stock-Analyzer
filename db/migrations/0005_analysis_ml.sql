-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

CREATE TABLE analysis_snapshot (
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  indicators    jsonb NOT NULL,
  scores        jsonb NOT NULL,                   -- trend, risk, quality, with components and coverage
  version       text NOT NULL,
  PRIMARY KEY (instrument_id, as_of)
);

CREATE TABLE screener_row (                       -- precomputed for the screener; one row per instrument
  instrument_id integer PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  metrics       jsonb NOT NULL                    -- keys whitelisted in 03-api-spec.md section 9
);

CREATE TABLE model_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_name    text NOT NULL,                    -- 'dir_5d','dir_21d','range_5d','range_21d'
  trained_at    timestamptz NOT NULL DEFAULT now(),
  train_start   date NOT NULL, train_end date NOT NULL,
  n_rows        integer NOT NULL,
  valid_metrics jsonb NOT NULL,
  baseline_metrics jsonb NOT NULL,
  guardrail_pass boolean NOT NULL,
  artifact      bytea,                            -- small model blob, or NULL if stored externally
  artifact_uri  text,
  status        text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','retired'))
);

CREATE TABLE prediction (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id integer NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         date NOT NULL,                    -- last trading date of data used
  horizon_days  smallint NOT NULL CHECK (horizon_days IN (5,21)),
  model_run_id  bigint NOT NULL REFERENCES model_run(id),
  p_up          real,
  ret_q10       real, ret_q50 real, ret_q90 real,
  ref_close     double precision NOT NULL,        -- adj_close at as_of
  shown         boolean NOT NULL DEFAULT false,   -- false if guardrail/insufficient data
  hidden_reason text,
  UNIQUE (instrument_id, as_of, horizon_days, model_run_id)
);

CREATE TABLE prediction_outcome (
  prediction_id bigint PRIMARY KEY REFERENCES prediction(id) ON DELETE CASCADE,
  resolved_on   date NOT NULL,
  realized_return real NOT NULL,
  direction_correct boolean,
  in_band       boolean
);

-- +goose Down
DROP TABLE IF EXISTS prediction_outcome;
DROP TABLE IF EXISTS prediction;
DROP TABLE IF EXISTS model_run;
DROP TABLE IF EXISTS screener_row;
DROP TABLE IF EXISTS analysis_snapshot;
