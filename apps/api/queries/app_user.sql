-- name: GetAppUser :one
SELECT id, password_hash, telegram_chat_id, quiet_hours, display_prefs, failed_logins, locked_until, created_at
FROM app_user WHERE id = 1;

-- Seed: the single owner row. Re-running never replaces an existing password hash.
-- name: InsertAppUser :execrows
INSERT INTO app_user (id, password_hash) VALUES (1, $1)
ON CONFLICT (id) DO NOTHING;

-- Serialises concurrent failed logins on the single owner row.
-- name: GetAppUserForUpdate :one
SELECT id, password_hash, telegram_chat_id, quiet_hours, display_prefs, failed_logins, locked_until, created_at
FROM app_user WHERE id = 1 FOR UPDATE;

-- name: SetLoginFailure :exec
UPDATE app_user SET failed_logins = $1, locked_until = $2 WHERE id = 1;

-- name: ResetLoginFailures :exec
UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = 1;

-- name: UpdatePasswordHash :exec
UPDATE app_user SET password_hash = $1 WHERE id = 1;
