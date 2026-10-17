-- Alerts and Telegram linking (B12, docs/03 section 13). Parameterised only.

-- name: ResolveInstrumentBySymbol :one
SELECT id, symbol, name, status FROM instrument WHERE upper(symbol) = upper($1);

-- A renamed symbol still resolves through symbol_alias (docs/03 section 1).
-- name: ResolveInstrumentByAlias :one
SELECT i.id, i.symbol, i.name, i.status
FROM symbol_alias a JOIN instrument i ON i.id = a.instrument_id
WHERE upper(a.old_symbol) = upper($1)
ORDER BY a.changed_on DESC NULLS LAST
LIMIT 1;

-- name: ResolveMfScheme :one
SELECT code, name FROM mf_scheme WHERE code = $1;

-- Last imported bar (suspect bars are excluded, as in analytics).
-- name: LastStockBar :one
SELECT trade_date, close FROM price_daily
WHERE instrument_id = $1 AND NOT suspect
ORDER BY trade_date DESC LIMIT 1;

-- name: LastMfNav :one
SELECT nav_date, nav FROM mf_nav WHERE scheme_code = $1 ORDER BY nav_date DESC LIMIT 1;

-- Serialises changes to the number of active alerts (limit 200).
-- name: LockAlertLimit :exec
SELECT pg_advisory_xact_lock(1202);

-- name: CountActiveAlerts :one
SELECT count(*)::bigint FROM alert WHERE status = 'active';

-- name: InsertAlert :one
INSERT INTO alert (target_type, instrument_id, mf_scheme_code, kind, params, one_shot, cooldown_minutes, expires_on)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id;

-- name: GetAlertView :one
SELECT a.id, a.target_type, a.kind, a.params, a.status, a.one_shot, a.cooldown_minutes, a.expires_on,
       a.last_fired_at, a.created_at,
       i.symbol AS symbol, COALESCE(i.name, m.name, '')::text AS target_name, m.code AS mf_code
FROM alert a
LEFT JOIN instrument i ON i.id = a.instrument_id
LEFT JOIN mf_scheme m ON m.code = a.mf_scheme_code
WHERE a.id = $1;

-- name: GetAlertForUpdate :one
SELECT id, target_type, instrument_id, mf_scheme_code, kind, params, status FROM alert WHERE id = $1 FOR UPDATE;

-- Newest first, keyset on id.
-- name: ListAlertViews :many
SELECT a.id, a.target_type, a.kind, a.params, a.status, a.one_shot, a.cooldown_minutes, a.expires_on,
       a.last_fired_at, a.created_at,
       i.symbol AS symbol, COALESCE(i.name, m.name, '')::text AS target_name, m.code AS mf_code
FROM alert a
LEFT JOIN instrument i ON i.id = a.instrument_id
LEFT JOIN mf_scheme m ON m.code = a.mf_scheme_code
WHERE (sqlc.narg(status)::text IS NULL OR a.status = sqlc.narg(status)::text)
  AND (sqlc.narg(before_id)::bigint IS NULL OR a.id < sqlc.narg(before_id)::bigint)
ORDER BY a.id DESC
LIMIT sqlc.arg(row_limit)::int;

-- A parameter change clears the evaluator memory (last_state) so the new threshold starts clean.
-- name: UpdateAlertStatus :exec
UPDATE alert SET status = $2 WHERE id = $1;

-- name: UpdateAlertParams :exec
UPDATE alert SET params = $2, last_state = NULL WHERE id = $1;

-- name: DeleteAlert :execrows
DELETE FROM alert WHERE id = $1;

-- name: ListAlertEvents :many
SELECT e.id, e.alert_id, e.fired_at, e.payload, e.delivery_status, e.delivery_attempts, e.delivered_at, e.last_error,
       a.kind, a.target_type, i.symbol AS symbol, COALESCE(i.name, m.name, '')::text AS target_name, m.code AS mf_code
FROM alert_event e
JOIN alert a ON a.id = e.alert_id
LEFT JOIN instrument i ON i.id = a.instrument_id
LEFT JOIN mf_scheme m ON m.code = a.mf_scheme_code
WHERE (sqlc.narg(before_id)::bigint IS NULL OR e.id < sqlc.narg(before_id)::bigint)
ORDER BY e.id DESC
LIMIT sqlc.arg(row_limit)::int;

-- Telegram link codes: only the sha256 is stored (docs/03 section 13).
-- name: PurgeLinkCodes :exec
DELETE FROM telegram_link_code WHERE expires_at < sqlc.arg(now)::timestamptz - interval '1 day';

-- name: InsertLinkCode :exec
INSERT INTO telegram_link_code (code_hash, expires_at) VALUES ($1, $2);

-- Single use: the row is consumed by the UPDATE that wins; zero rows = unknown, used or expired.
-- name: ConsumeLinkCode :execrows
UPDATE telegram_link_code SET used_at = sqlc.arg(now)::timestamptz
WHERE code_hash = sqlc.arg(code_hash) AND used_at IS NULL AND expires_at > sqlc.arg(now)::timestamptz;

-- name: SetTelegramChat :exec
UPDATE app_user SET telegram_chat_id = $1 WHERE id = 1;

-- name: ClearTelegramChat :exec
UPDATE app_user SET telegram_chat_id = NULL WHERE id = 1;

-- name: GetTelegramChat :one
SELECT telegram_chat_id FROM app_user WHERE id = 1;
