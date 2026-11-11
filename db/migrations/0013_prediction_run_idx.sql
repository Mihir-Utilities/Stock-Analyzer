-- +goose Up
-- B14 review: the live track record aggregates predictions per model run (docs/05 10.7). The unique key
-- starts with instrument_id, so a by-run scan was a sequential scan of the whole prediction table.
-- prediction_outcome is joined on its primary key (prediction_id), which is already indexed.

CREATE INDEX prediction_model_run_idx ON prediction (model_run_id) WHERE p_up IS NOT NULL;

-- +goose Down
DROP INDEX prediction_model_run_idx;
