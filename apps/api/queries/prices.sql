-- B04: price bars and the latest analysis snapshot. Parameterised only.

-- name: GetInstrumentListing :one
SELECT id, symbol, listing_date FROM instrument WHERE id = $1;

-- Valid (non-suspect) bar range; suspect rows are never served (BRK-08).
-- name: GetValidBarRange :one
SELECT max(trade_date)::date AS last_bar, min(trade_date)::date AS first_bar, count(*)::int AS bars
FROM price_daily WHERE instrument_id = $1 AND NOT suspect;

-- name: ListValidBars :many
SELECT trade_date, open, high, low, close, adj_close, volume
FROM price_daily
WHERE instrument_id = $1 AND NOT suspect AND trade_date >= $2
ORDER BY trade_date;

-- Split-like actions for chart markers (confirmed) and the unconfirmed warning (detected).
-- name: ListPriceActions :many
SELECT ex_date, action_type, status, ratio_num, ratio_den
FROM corporate_action
WHERE instrument_id = $1 AND ex_date >= $2
  AND status IN ('confirmed', 'detected')
  AND action_type IN ('split', 'bonus', 'split_or_bonus')
ORDER BY ex_date, id;

-- name: GetLatestSnapshot :one
SELECT as_of, indicators, scores, version
FROM analysis_snapshot WHERE instrument_id = $1 ORDER BY as_of DESC LIMIT 1;
