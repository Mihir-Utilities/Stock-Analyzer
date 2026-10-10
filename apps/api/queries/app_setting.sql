-- name: GetSetting :one
SELECT key, value, updated_at FROM app_setting WHERE key = $1;

-- name: ListSettings :many
SELECT key, value, updated_at FROM app_setting ORDER BY key;

-- name: UpsertSetting :exec
INSERT INTO app_setting (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Seed: never overwrite a value the owner already changed.
-- name: InsertDefaultSetting :execrows
INSERT INTO app_setting (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO NOTHING;
