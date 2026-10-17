-- name: GetRefreshJob :one
SELECT id, kind, target, requested_at, status, started_at, finished_at, error, result
FROM refresh_job WHERE id = $1;

-- name: GetActiveRefreshJob :one
SELECT id, kind, target, requested_at, status, started_at, finished_at, error, result
FROM refresh_job
WHERE kind = $1 AND target = $2 AND status IN ('queued','running')
ORDER BY id DESC LIMIT 1;

-- Cooldown: when the last job for this target finished (docs/03 section 7).
-- name: LastFinishedRefreshJobAt :one
SELECT finished_at FROM refresh_job
WHERE kind = $1 AND target = $2 AND finished_at IS NOT NULL
ORDER BY finished_at DESC LIMIT 1;

-- Global limit: on-demand jobs requested since $1, oldest first (post_import is event-driven and not counted).
-- name: ListRefreshJobTimesSince :many
SELECT requested_at FROM refresh_job
WHERE requested_at > $1 AND kind IN ('stock_refresh','stock_backfill','mf_refresh')
ORDER BY requested_at ASC;

-- The partial unique index refresh_job_active_uq makes concurrent inserts for one (kind,target) collapse into one row.
-- name: InsertRefreshJob :one
INSERT INTO refresh_job (kind, target, result)
VALUES ($1, $2, sqlc.narg(result)::jsonb)
ON CONFLICT (kind, target) WHERE status IN ('queued','running') DO NOTHING
RETURNING id, kind, target, requested_at, status, started_at, finished_at, error, result;

-- name: MfSchemeExists :one
SELECT EXISTS (SELECT 1 FROM mf_scheme WHERE code = $1);
