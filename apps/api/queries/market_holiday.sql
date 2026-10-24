-- name: CountHolidaysForYear :one
SELECT count(*) FROM market_holiday WHERE segment = 'trading' AND holiday_date >= make_date(sqlc.arg(year)::int, 1, 1) AND holiday_date < make_date(sqlc.arg(year)::int + 1, 1, 1);

-- name: ListHolidays :many
SELECT holiday_date, segment, description, source FROM market_holiday ORDER BY holiday_date, segment;

-- name: InsertSeedHoliday :execrows
INSERT INTO market_holiday (holiday_date, segment, description, source) VALUES ($1, 'trading', $2, 'seed')
ON CONFLICT (holiday_date, segment) DO NOTHING;
