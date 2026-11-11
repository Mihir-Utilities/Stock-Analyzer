package instruments

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
)

// LoadCalendar reads the trading holidays around now (400 days back and forward) and reports whether
// the IST year of now has any trading-holiday row. It is the raw-SQL twin of Service.calendar for
// packages that only hold a DBTX (market, predict).
func LoadCalendar(ctx context.Context, db dbq.DBTX, now time.Time) (Calendar, bool, error) {
	ist := now.In(IST)
	var n int64
	if err := db.QueryRow(ctx, `SELECT count(*) FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= make_date($1::int, 1, 1) AND holiday_date < make_date($1::int + 1, 1, 1)`, ist.Year()).Scan(&n); err != nil {
		return Calendar{}, false, err
	}
	day := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	rows, err := db.Query(ctx, `SELECT holiday_date FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= $1::date AND holiday_date <= $2::date`,
		day.AddDate(0, 0, -400).Format(time.DateOnly), day.AddDate(0, 0, 400).Format(time.DateOnly))
	if err != nil {
		return Calendar{}, false, err
	}
	defer rows.Close()
	var hs []time.Time
	for rows.Next() {
		var d pgtype.Date
		if err := rows.Scan(&d); err != nil {
			return Calendar{}, false, err
		}
		if d.Valid {
			hs = append(hs, d.Time)
		}
	}
	if err := rows.Err(); err != nil {
		return Calendar{}, false, err
	}
	return NewCalendar(hs), n > 0, nil
}
