-- name: GetAppUser :one
SELECT id, password_hash, telegram_chat_id, quiet_hours, display_prefs, failed_logins, locked_until, created_at
FROM app_user WHERE id = 1;

-- Seed: the single owner row. Re-running never replaces an existing password hash.
-- name: InsertAppUser :execrows
INSERT INTO app_user (id, password_hash) VALUES (1, $1)
ON CONFLICT (id) DO NOTHING;
