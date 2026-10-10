-- +goose Up
-- Source: docs/02-database.sql (split by T02; never edit once applied)

CREATE TABLE ingestion_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job           text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed','skipped')),
  rows_written  integer NOT NULL DEFAULT 0,
  items_total   integer,
  items_failed  integer NOT NULL DEFAULT 0,
  error         text,
  details       jsonb
);
CREATE INDEX ingestion_run_job_started_idx ON ingestion_run (job, started_at DESC);
-- at most one running instance per job:
CREATE UNIQUE INDEX ingestion_run_one_running_uq ON ingestion_run (job) WHERE status = 'running';

CREATE TABLE source_health (
  source        text PRIMARY KEY,                 -- broker, mfapi, amfi, telegram
  checked_at    timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL,
  latency_ms    integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_until timestamptz,                     -- circuit breaker
  note          text
);

CREATE TABLE refresh_job (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('stock_refresh','stock_backfill','mf_refresh','post_import')),
  target        text NOT NULL,                    -- symbol or scheme code; for post_import: 'batch:<import_batch.id>'
  requested_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ok','partial','failed','cancelled')),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  result        jsonb
);
-- dedupe: one active job per (kind,target)
CREATE UNIQUE INDEX refresh_job_active_uq ON refresh_job (kind, target) WHERE status IN ('queued','running');
CREATE INDEX refresh_job_recent_idx ON refresh_job (kind, target, requested_at DESC);

-- +goose Down
DROP TABLE IF EXISTS refresh_job;
DROP TABLE IF EXISTS source_health;
DROP TABLE IF EXISTS ingestion_run;
