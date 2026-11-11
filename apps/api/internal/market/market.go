// Package market serves GET /market/overview and GET /market/holidays (docs/03 section 8). Indices
// come only from the owner-imported `market_series` (reserved prices.csv symbols), movers from the
// owner's imported daily bars, and market status from the holiday list. Nothing is fetched.
package market

import (
	"context"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/instruments"
)

// Market hours, IST (docs/03 section 8).
const (
	openHour, openMin   = 9, 15
	closeHour, closeMin = 15, 30
	// MoverLimit is the number of gainers and losers returned.
	MoverLimit = 10
	// MinMoverTurnoverCr is the minimum value traded on the latest day (INR crore) for a stock to
	// qualify as a mover; the spec says "min volume filter" without a number (B14-4).
	MinMoverTurnoverCr = 0.5
	vixCode            = "INDIAVIX"
)

var indexNames = map[string]string{"NIFTY50": "Nifty 50", "INDIAVIX": "India VIX"}

// Service reads the market overview.
type Service struct {
	db  dbq.DBTX
	Now func() time.Time
}

// New builds a Service.
func New(db dbq.DBTX) *Service { return &Service{db: db, Now: time.Now} }

// IndexQuote is one index or the VIX. change and change_pct are null with change_reason when there is
// no previous value. change_pct is a percent number (1.5 = 1.5%).
type IndexQuote struct {
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Value        float64  `json:"value"`
	Change       *float64 `json:"change"`
	ChangePct    *float64 `json:"change_pct"`
	ChangeReason *string  `json:"change_reason,omitempty"`
	AsOf         string   `json:"as_of"`
	Source       string   `json:"source"`
	Unit         string   `json:"unit"`
}

// Mover is one gainer or loser (day change on adjusted closes, percent number).
type Mover struct {
	Symbol    string  `json:"symbol"`
	Name      string  `json:"name"`
	Close     float64 `json:"close"`
	ChangePct float64 `json:"change_pct"`
	Volume    int64   `json:"volume"`
	AsOf      string  `json:"as_of"`
}

// Movers lists the top gainers and losers among tracked stocks.
type Movers struct {
	Gainers []Mover `json:"gainers"`
	Losers  []Mover `json:"losers"`
}

// Status is the market status from the holiday list and the clock.
type Status struct {
	IsOpen            bool    `json:"is_open"`
	NextOpen          string  `json:"next_open"`
	Holiday           *string `json:"holiday"`
	HolidayListLoaded bool    `json:"holiday_list_loaded"`
}

// Overview is data of GET /market/overview.
type Overview struct {
	Indices       []IndexQuote `json:"indices"`
	IndicesReason *string      `json:"indices_reason,omitempty"`
	VIX           *IndexQuote  `json:"vix"`
	VIXReason     *string      `json:"vix_reason,omitempty"`
	Movers        Movers       `json:"movers"`
	MoversReason  *string      `json:"movers_reason,omitempty"`
	MarketStatus  Status       `json:"market_status"`

	AsOf time.Time `json:"-"` // newest index or mover date, else now
}

func ptr[T any](v T) *T { return &v }

// Overview builds the overview.
func (s *Service) Overview(ctx context.Context) (Overview, error) {
	now := s.Now()
	o := Overview{Indices: []IndexQuote{}, Movers: Movers{Gainers: []Mover{}, Losers: []Mover{}}, AsOf: now}

	codes, err := s.seriesCodes(ctx)
	if err != nil {
		return o, err
	}
	for _, code := range codes {
		q, err := s.quote(ctx, code)
		if err != nil {
			return o, err
		}
		if q == nil {
			continue
		}
		if code == vixCode {
			o.VIX = q
		} else {
			o.Indices = append(o.Indices, *q)
		}
	}
	if len(o.Indices) == 0 {
		o.IndicesReason = ptr("no_index_series")
	}
	if o.VIX == nil {
		o.VIXReason = ptr("no_index_series")
	}
	if o.Movers, o.AsOf, err = s.movers(ctx, o.AsOf); err != nil {
		return o, err
	}
	if len(o.Movers.Gainers)+len(o.Movers.Losers) == 0 {
		o.MoversReason = ptr("no_prices_imported")
	}
	if o.MarketStatus, err = s.status(ctx, now); err != nil {
		return o, err
	}
	return o, nil
}

func (s *Service) seriesCodes(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT code FROM market_series ORDER BY code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) quote(ctx context.Context, code string) (*IndexQuote, error) {
	rows, err := s.db.Query(ctx, `SELECT trade_date, value FROM market_series WHERE code = $1
		ORDER BY trade_date DESC LIMIT 2`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var dates []time.Time
	var vals []float64
	for rows.Next() {
		var d pgtype.Date
		var v float64
		if err := rows.Scan(&d, &v); err != nil {
			return nil, err
		}
		dates, vals = append(dates, d.Time), append(vals, v)
	}
	if err := rows.Err(); err != nil || len(vals) == 0 {
		return nil, err
	}
	name := indexNames[code]
	if name == "" {
		name = code
	}
	q := &IndexQuote{Code: code, Name: name, Value: vals[0], AsOf: dates[0].Format(time.DateOnly), Source: "import", Unit: "index points"}
	if len(vals) < 2 || vals[1] == 0 || !finite(vals[0]) || !finite(vals[1]) {
		q.ChangeReason = ptr("no_previous_value")
		return q, nil
	}
	q.Change = ptr(round(vals[0]-vals[1], 4))
	q.ChangePct = ptr(round((vals[0]/vals[1]-1)*100, 4))
	return q, nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

// moversSQL ranks tracked stocks by the day change between the two newest dates that carry bars.
// Stocks need bars on both dates, a volume above the turnover floor, and no unconfirmed
// (detected) corporate action in between, because the unadjusted gap would be a false move.
const moversSQL = `
WITH d AS (
  SELECT (SELECT max(p.trade_date) FROM price_daily p JOIN instrument i ON i.id = p.instrument_id
          WHERE i.is_tracked AND NOT p.suspect) AS last_d
), d2 AS (
  SELECT d.last_d, (SELECT max(p.trade_date) FROM price_daily p JOIN instrument i ON i.id = p.instrument_id
          WHERE i.is_tracked AND NOT p.suspect AND p.trade_date < d.last_d) AS prev_d FROM d
), chg AS (
  SELECT i.symbol, i.name, c.close, c.volume, c.trade_date,
         (c.adj_close / q.adj_close - 1) * 100 AS pct
  FROM d2
  JOIN price_daily c ON c.trade_date = d2.last_d AND NOT c.suspect
  JOIN price_daily q ON q.instrument_id = c.instrument_id AND q.trade_date = d2.prev_d AND NOT q.suspect
  JOIN instrument i ON i.id = c.instrument_id AND i.is_tracked AND i.status = 'active' AND i.instrument_kind = 'equity'
  WHERE c.volume > 0 AND c.close * c.volume / 1e7 >= $1
    AND NOT EXISTS (SELECT 1 FROM corporate_action a WHERE a.instrument_id = i.id AND a.status = 'detected'
                    AND a.ex_date > d2.prev_d AND a.ex_date <= d2.last_d)
)
(SELECT 'g', symbol, name, close, volume, trade_date, pct FROM chg WHERE pct > 0 ORDER BY pct DESC, symbol LIMIT $2)
UNION ALL
(SELECT 'l', symbol, name, close, volume, trade_date, pct FROM chg WHERE pct < 0 ORDER BY pct ASC, symbol LIMIT $2)`

func (s *Service) movers(ctx context.Context, fallback time.Time) (Movers, time.Time, error) {
	m := Movers{Gainers: []Mover{}, Losers: []Mover{}}
	rows, err := s.db.Query(ctx, moversSQL, MinMoverTurnoverCr, MoverLimit)
	if err != nil {
		return m, fallback, err
	}
	defer rows.Close()
	asOf := fallback
	for rows.Next() {
		var side string
		var mv Mover
		var d pgtype.Date
		if err := rows.Scan(&side, &mv.Symbol, &mv.Name, &mv.Close, &mv.Volume, &d, &mv.ChangePct); err != nil {
			return m, fallback, err
		}
		if !finite(mv.ChangePct) {
			continue
		}
		mv.ChangePct = round(mv.ChangePct, 4)
		mv.AsOf = d.Time.Format(time.DateOnly)
		asOf = d.Time
		if side == "g" {
			m.Gainers = append(m.Gainers, mv)
		} else {
			m.Losers = append(m.Losers, mv)
		}
	}
	return m, asOf, rows.Err()
}

// Holiday is one row of GET /market/holidays.
type Holiday struct {
	Date        string  `json:"date"`
	Description *string `json:"description"`
}

// HolidayList is data of GET /market/holidays.
type HolidayList struct {
	Year       int       `json:"year"`
	Holidays   []Holiday `json:"holidays"`
	YearLoaded bool      `json:"year_loaded"`
	Note       *string   `json:"note,omitempty"`
}

// Holidays lists the trading holidays of a year (0 means the current IST year).
func (s *Service) Holidays(ctx context.Context, year int) (HolidayList, error) {
	if year == 0 {
		year = s.Now().In(instruments.IST).Year()
	}
	out := HolidayList{Year: year, Holidays: []Holiday{}}
	rows, err := s.db.Query(ctx, `SELECT holiday_date, description FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= make_date($1::int, 1, 1) AND holiday_date < make_date($1::int + 1, 1, 1)
		ORDER BY holiday_date`, year)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var d pgtype.Date
		var desc *string
		if err := rows.Scan(&d, &desc); err != nil {
			return out, err
		}
		out.Holidays = append(out.Holidays, Holiday{Date: d.Time.Format(time.DateOnly), Description: desc})
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.YearLoaded = len(out.Holidays) > 0
	if !out.YearLoaded {
		out.Note = ptr("No holiday list for this year: only weekends are treated as closed. Import holidays.csv.")
	}
	return out, nil
}

// status computes is_open, next_open (UTC) and today's holiday from the stored list.
func (s *Service) status(ctx context.Context, now time.Time) (Status, error) {
	ist := now.In(instruments.IST)
	from := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 21)
	rows, err := s.db.Query(ctx, `SELECT holiday_date, description FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= $1::date AND holiday_date <= $2::date`, from.Format(time.DateOnly), to.Format(time.DateOnly))
	if err != nil {
		return Status{}, err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var d pgtype.Date
		var desc *string
		if err := rows.Scan(&d, &desc); err != nil {
			return Status{}, err
		}
		n := "Market holiday"
		if desc != nil && *desc != "" {
			n = *desc
		}
		names[d.Time.Format(time.DateOnly)] = n
	}
	if err := rows.Err(); err != nil {
		return Status{}, err
	}
	var loaded bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= make_date($1::int, 1, 1) AND holiday_date < make_date($1::int + 1, 1, 1))`, ist.Year()).Scan(&loaded); err != nil {
		return Status{}, err
	}
	return ComputeStatus(now, names, loaded), nil
}

// ComputeStatus is the pure rule: open 09:15-15:30 IST Mon-Fri unless the date is a trading holiday
// (names keyed YYYY-MM-DD). next_open is the next 09:15 IST on a trading day after now (or today
// when the market has not opened yet), as RFC 3339 UTC.
func ComputeStatus(now time.Time, holidays map[string]string, listLoaded bool) Status {
	ist := now.In(instruments.IST)
	trading := func(d time.Time) bool {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			return false
		}
		_, h := holidays[d.Format(time.DateOnly)]
		return !h
	}
	day := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	st := Status{HolidayListLoaded: listLoaded}
	if name, ok := holidays[day.Format(time.DateOnly)]; ok {
		st.Holiday = &name
	}
	mins := ist.Hour()*60 + ist.Minute()
	st.IsOpen = trading(day) && mins >= openHour*60+openMin && mins < closeHour*60+closeMin
	d := day
	if !trading(d) || mins >= openHour*60+openMin {
		d = d.AddDate(0, 0, 1)
		for i := 0; i < 366 && !trading(d); i++ {
			d = d.AddDate(0, 0, 1)
		}
	}
	open := time.Date(d.Year(), d.Month(), d.Day(), openHour, openMin, 0, 0, instruments.IST)
	st.NextOpen = open.UTC().Format(time.RFC3339)
	return st
}
