-- name: CreateSession :one
INSERT INTO session (token_hash, expires_at, ip, user_agent)
VALUES ($1, $2, $3, $4)
RETURNING id, created_at, expires_at;

-- name: GetSessionByHash :one
SELECT id, last_seen_at, expires_at, revoked_at FROM session WHERE token_hash = $1;

-- Sliding expiry: at most once per hour (docs/03 section 2); the guard keeps concurrent requests idempotent.
-- name: TouchSession :exec
UPDATE session SET last_seen_at = sqlc.arg(now)::timestamptz, expires_at = sqlc.arg(expires_at)
WHERE id = sqlc.arg(id) AND revoked_at IS NULL AND last_seen_at <= sqlc.arg(now)::timestamptz - interval '1 hour';

-- name: RevokeSession :exec
UPDATE session SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeAllSessions :execrows
UPDATE session SET revoked_at = $1 WHERE revoked_at IS NULL;

-- name: RevokeOtherSessions :execrows
UPDATE session SET revoked_at = $2 WHERE id <> $1 AND revoked_at IS NULL;

-- Housekeeping helper (used by tests and the hourly purge in a later task).
-- name: DeleteExpiredSessions :execrows
DELETE FROM session WHERE expires_at < $1 OR revoked_at < $1;
