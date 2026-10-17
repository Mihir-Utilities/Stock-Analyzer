-- B03: compact index, server search, profile. Parameterised only; no string concatenation.
-- Index names are compared without spaces and case (owner index_tags may read NIFTY50 or 'NIFTY 50').

-- name: ListStockIndex :many
SELECT i.id, i.symbol, i.name,
  (CASE WHEN i.is_tracked THEN 2 ELSE 0 END
   | CASE WHEN i.status = 'suspended' THEN 4 ELSE 0 END
   | CASE WHEN i.status = 'delisted' THEN 8 ELSE 0 END
   | CASE WHEN i.instrument_kind <> 'equity' THEN 16 ELSE 0 END
   | CASE WHEN i.company_type = 'financial' THEN 32 ELSE 0 END
   | CASE WHEN EXISTS (SELECT 1 FROM index_constituent c WHERE c.instrument_id = i.id
                       AND upper(replace(c.index_name, ' ', '')) = 'NIFTY50') THEN 64 ELSE 0 END
   | CASE WHEN EXISTS (SELECT 1 FROM index_constituent c WHERE c.instrument_id = i.id
                       AND upper(replace(c.index_name, ' ', '')) IN ('NIFTY50', 'NIFTY100', 'NIFTYNEXT50')) THEN 128 ELSE 0 END
  )::int AS flags
FROM instrument i
ORDER BY i.symbol;

-- Ranking: 0 exact symbol, 1 symbol prefix, 2 name prefix, 3 trigram similarity on name >= 0.3.
-- Order: rank, similarity desc (rank 3 only), symbol. The keyset cursor carries (rank, -similarity, symbol).
-- name: SearchStocks :many
WITH base AS (
  SELECT i.*,
    CASE
      WHEN sqlc.arg(q)::text = '' THEN 0
      WHEN upper(i.symbol) = upper(sqlc.arg(q)::text) THEN 0
      WHEN starts_with(upper(i.symbol), upper(sqlc.arg(q)::text)) THEN 1
      WHEN starts_with(upper(i.name), upper(sqlc.arg(q)::text)) THEN 2
      WHEN similarity(i.name, sqlc.arg(q)::text) >= 0.3 THEN 3
      ELSE NULL
    END AS rank,
    CASE WHEN sqlc.arg(q)::text <> '' AND NOT (upper(i.symbol) = upper(sqlc.arg(q)::text)
                OR starts_with(upper(i.symbol), upper(sqlc.arg(q)::text))
                OR starts_with(upper(i.name), upper(sqlc.arg(q)::text)))
         THEN similarity(i.name, sqlc.arg(q)::text)::float8 ELSE 0::float8 END AS sim
  FROM instrument i
  WHERE i.instrument_kind = sqlc.arg(kind)::text
    AND i.status = sqlc.arg(status)::text
    AND (sqlc.arg(sector)::text = '' OR upper(i.sector) = upper(sqlc.arg(sector)::text))
    AND (sqlc.arg(index_name)::text = '' OR EXISTS (
          SELECT 1 FROM index_constituent c WHERE c.instrument_id = i.id
            AND upper(replace(c.index_name, ' ', '')) = upper(replace(sqlc.arg(index_name)::text, ' ', ''))))
)
SELECT b.id, b.symbol, b.name, b.isin, b.series, b.sector, b.industry, b.company_type, b.status,
       b.instrument_kind, b.is_tracked, b.rank::int AS rank, b.sim AS sim
FROM base b
WHERE b.rank IS NOT NULL
  AND (NOT sqlc.arg(has_cursor)::bool
       OR b.rank > sqlc.arg(cur_rank)::int
       OR (b.rank = sqlc.arg(cur_rank)::int AND (-b.sim) > sqlc.arg(cur_neg_sim)::float8)
       OR (b.rank = sqlc.arg(cur_rank)::int AND (-b.sim) = sqlc.arg(cur_neg_sim)::float8
           AND b.symbol > sqlc.arg(cur_symbol)::text))
ORDER BY b.rank, b.sim DESC, b.symbol
LIMIT sqlc.arg(row_limit)::int;

-- name: FindInstrumentBySymbol :one
SELECT id, symbol FROM instrument WHERE upper(symbol) = upper($1::text)
ORDER BY (symbol = $1::text) DESC, id LIMIT 1;

-- name: FindAliasTarget :one
SELECT i.symbol FROM symbol_alias a JOIN instrument i ON i.id = a.instrument_id
WHERE upper(a.old_symbol) = upper($1::text)
ORDER BY a.changed_on DESC NULLS LAST, i.id LIMIT 1;

-- Opening a stock: stamp last_opened_at; an untracked stock becomes tracked with reason 'opened'
-- (a tracked one keeps its reason). The API owns the tracked set (docs/03 section 3).
-- name: TouchOpenedInstrument :one
UPDATE instrument SET
  last_opened_at = now(),
  tracked_reason = CASE WHEN is_tracked THEN tracked_reason ELSE 'opened' END,
  is_tracked = true
WHERE id = $1
RETURNING id, symbol, name, isin, series, listing_date, sector, industry, company_type, status,
          instrument_kind, is_tracked;

-- name: GetPriceStats :one
SELECT max(trade_date)::date AS last_bar, min(trade_date)::date AS first_bar, count(*)::int AS bars
FROM price_daily WHERE instrument_id = $1;

-- name: GetQuoteLatest :one
SELECT quote_ts, ltp, prev_close, day_high, day_low, volume, wk52_high, wk52_low, market_cap_cr, source
FROM quote_latest WHERE instrument_id = $1;

-- name: GetFundamentalsAsOf :one
SELECT (last_success AT TIME ZONE 'Asia/Kolkata')::date AS as_of FROM fundamental_meta WHERE instrument_id = $1;

-- name: GetShareholdingAsOf :one
SELECT max(quarter_end)::date AS as_of FROM shareholding WHERE instrument_id = $1;

-- name: GetPredictionsAsOf :one
SELECT max(as_of)::date AS as_of FROM prediction WHERE instrument_id = $1 AND shown;

-- name: ListHolidayDatesForYears :many
SELECT DISTINCT holiday_date FROM market_holiday
WHERE segment = 'trading' AND holiday_date >= $1 AND holiday_date <= $2;
