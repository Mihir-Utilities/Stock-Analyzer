-- Read side of owner-supplied fundamentals, shareholding, events (B05; docs/03 section 5).

-- name: FindInstrumentForOwnerData :one
SELECT id, symbol, name, company_type FROM instrument WHERE upper(symbol) = upper($1::text)
ORDER BY (symbol = $1::text) DESC, id LIMIT 1;

-- name: ListFundamentalBases :many
SELECT basis, count(DISTINCT period_end)::int AS periods
FROM fundamental_value
WHERE instrument_id = $1 AND period_type = $2 AND source <> 'derived' AND value IS NOT NULL
GROUP BY basis ORDER BY basis;

-- name: ListFundamentalValues :many
SELECT period_end, metric_key, value, unit, source, fetched_at
FROM fundamental_value
WHERE instrument_id = $1 AND basis = $2 AND period_type = $3 AND source <> 'derived' AND value IS NOT NULL
ORDER BY period_end, metric_key;

-- name: GetFundamentalMeta :one
SELECT status, last_success, last_fetched FROM fundamental_meta WHERE instrument_id = $1;

-- name: GetLatestSnapshotFundamentals :one
SELECT as_of, (indicators -> 'fundamentals')::jsonb AS fundamentals
FROM analysis_snapshot WHERE instrument_id = $1 ORDER BY as_of DESC LIMIT 1;

-- name: ListShareholding :many
SELECT quarter_end, promoter_pct, fii_pct, dii_pct, mf_pct, insurance_pct, govt_pct, public_pct,
       promoter_pledged_pct, filed_on, source, fetched_at
FROM shareholding WHERE instrument_id = $1 ORDER BY quarter_end;

-- name: ListCorporateActions :many
SELECT id, ex_date, record_date, action_type, status, ratio_num, ratio_den, amount_per_share,
       purpose_text, source
FROM corporate_action
WHERE instrument_id = $1 AND ex_date >= sqlc.arg(from_date)::date AND ex_date <= sqlc.arg(to_date)::date
ORDER BY ex_date DESC, id DESC;

-- name: ListCalendarEvents :many
SELECT event_date, event_type, details, source
FROM event_calendar
WHERE instrument_id = $1 AND event_date >= sqlc.arg(from_date)::date AND event_date <= sqlc.arg(to_date)::date
ORDER BY event_date, id;
