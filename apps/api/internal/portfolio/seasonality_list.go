package portfolio

import (
	"context"
	"time"
)

// Scopes of GET /stocks/seasonality (docs/03 section 4a, INVA-1, D-INV2).
const (
	SeasonScopeAll       = "all"
	SeasonScopeWatchlist = "watchlist"
)

// SeasonStock is one row of GET /stocks/seasonality: a tracked stock with the same seasonality
// object as stocks[] of GET /watchlist, or null with the reason.
type SeasonStock struct {
	Symbol            string            `json:"symbol"`
	Name              string            `json:"name"`
	OnWatchlist       bool              `json:"on_watchlist"`
	Seasonality       *WatchSeasonality `json:"seasonality"`
	SeasonalityReason *string           `json:"seasonality_reason"`
}

// SeasonList is the data of GET /stocks/seasonality. Month is today's IST calendar month; AsOf is
// the newest seasonality as_of among the rows (null when no row has one).
type SeasonList struct {
	Month     int           `json:"month"`
	MonthName string        `json:"month_name"`
	AsOf      *string       `json:"as_of"`
	Scope     string        `json:"scope"`
	Stocks    []SeasonStock `json:"stocks"`
}

// SeasonalityList reads the latest analysis snapshot of every tracked stock (or the watchlisted
// ones) in one query and picks today's IST month from each stored block (same rule as GET /watchlist).
// Cost is linear in stocks: the jsonb path of each newest snapshot is detoasted once.
func (s *Service) SeasonalityList(ctx context.Context, scope string) (SeasonList, error) {
	if scope != SeasonScopeAll && scope != SeasonScopeWatchlist {
		return SeasonList{}, &ValidationError{Fields: []FieldError{{"scope", "must be all or watchlist"}}}
	}
	now := today(s.Now())
	out := SeasonList{Month: int(now.Month()), MonthName: now.Month().String(), Scope: scope, Stocks: []SeasonStock{}}
	rows, err := s.db.Query(ctx, `SELECT i.symbol, i.name, w.instrument_id IS NOT NULL,
		EXISTS (SELECT 1 FROM price_daily p WHERE p.instrument_id = i.id AND NOT p.suspect),
		a.as_of IS NOT NULL, a.seas::text
		FROM instrument i
		LEFT JOIN (SELECT DISTINCT instrument_id FROM watchlist_item WHERE instrument_id IS NOT NULL) w ON w.instrument_id = i.id
		LEFT JOIN LATERAL (SELECT as_of, indicators #> '{analysis,seasonality}' AS seas FROM analysis_snapshot
		  WHERE instrument_id = i.id ORDER BY as_of DESC LIMIT 1) a ON true
		WHERE i.is_tracked AND ($1 = 'all' OR w.instrument_id IS NOT NULL)
		ORDER BY i.symbol`, scope)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	var latest time.Time
	for rows.Next() {
		var st SeasonStock
		var hasPrice, hasSnap bool
		var seas *string
		if err := rows.Scan(&st.Symbol, &st.Name, &st.OnWatchlist, &hasPrice, &hasSnap, &seas); err != nil {
			return out, err
		}
		var raw []byte
		if seas != nil {
			raw = []byte(*seas)
		}
		st.Seasonality, st.SeasonalityReason = seasonalityFor(raw, hasSnap, hasPrice, now)
		if st.Seasonality != nil {
			if d, err := time.Parse("2006-01-02", st.Seasonality.AsOf); err == nil && d.After(latest) {
				latest = d
				out.AsOf = strp(st.Seasonality.AsOf)
			}
		}
		out.Stocks = append(out.Stocks, st)
	}
	return out, rows.Err()
}
