-- Mutual fund reads (B10). The Go API never calls mfapi/AMFI; rows are filled by the worker (D04).

-- name: GetMFScheme :one
SELECT code, name, fund_house, scheme_type, category, plan, option_type, isin_growth,
       isin_div_reinvest, status, is_tracked, last_nav_date, updated_at
FROM mf_scheme WHERE code = $1;

-- name: TouchMFSchemeOpened :exec
UPDATE mf_scheme SET last_opened_at = now() WHERE code = $1;

-- name: GetMFNavStats :one
SELECT count(*)::bigint AS nav_count, min(nav_date)::date AS first_nav_date, max(nav_date)::date AS last_nav_date
FROM mf_nav WHERE scheme_code = $1;

-- name: GetMFLatestNav :one
SELECT nav_date, nav FROM mf_nav WHERE scheme_code = $1 ORDER BY nav_date DESC LIMIT 1;

-- name: ListMFNavRange :many
SELECT nav_date, nav FROM mf_nav
WHERE scheme_code = $1 AND nav_date >= $2 AND nav_date <= $3
ORDER BY nav_date;

-- name: GetMFReturnCache :one
SELECT as_of, metrics FROM mf_return_cache WHERE scheme_code = $1;

-- name: ListMFCategories :many
SELECT DISTINCT category FROM mf_scheme
WHERE category IS NOT NULL AND category <> '' AND status = 'active'
ORDER BY category;

-- name: SuggestMFSchemes :many
SELECT code, name FROM mf_scheme
WHERE code::text LIKE $1::text || '%' AND status = 'active'
ORDER BY code LIMIT 5;
