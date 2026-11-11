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
	// MinMoverADVCr is the minimum 60-day average traded value (INR crore, docs/05 10.6
	// adv_value_60) for a stock to qualify as a mover. The spec says "min volume filter" without
	// a number; the docs/05 liquidity number is used and the owner confirms it (B14-4).
	MinMoverADVCr = 0.5
	vixCode       = "INDIAVIX"
	niftyCode     = "NIFTY50"
)

// indexNames is also the whitelist of market_series codes the overview shows.
var indexNames = map[string]string{niftyCode: "Nifty 50", vixCode: "India VIX"}

// Movers reasons (movers_reason).
const (
	ReasonNoPrices      = "no_prices_imported"
	ReasonNoCommonDates = "no_common_dates"
	ReasonNoQualifying  = "no_qualifying_movers"
)

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

	// AsOf is the newest index or mover date (never the clock); nil when there is no data.
	AsOf          *time.Time `json:"-"`
	Stale         bool       `json:"-"`
	StaleAgeHours float64    `json:"-"`
}

func ptr[T any](v T) *T { return &v }

// Overview builds the overview.
func (s *Service) Overview(ctx context.Context) (Overview, error) {
	now := s.Now()
	o := Overview{Indices: []IndexQuote{}, Movers: Movers{Gainers: []Mover{}, Losers: []Mover{}}}

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
		if d, perr := time.Parse(time.DateOnly, q.AsOf); perr == nil {
			o.AsOf = later(o.AsOf, d)
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
	cal, loaded, err := instruments.LoadCalendar(ctx, s.db, now)
	if err != nil {
		return o, err
	}
	var moverDate *time.Time
	if o.Movers, o.MoversReason, moverDate, err = s.movers(ctx, cal); err != nil {
		return o, err
	}
	if moverDate != nil {
		o.AsOf = later(o.AsOf, *moverDate)
	}
	if o.AsOf != nil {
		st := cal.PricesStaleness(now, o.AsOf, loaded)
		o.Stale, o.StaleAgeHours = st.Stale, st.AgeHours
	}
	if o.MarketStatus, err = s.status(ctx, now); err != nil {
		return o, err
	}
	return o, nil
}

// later returns the newer of a (may be nil) and d.
func later(a *time.Time, d time.Time) *time.Time {
	if a == nil || d.After(*a) {
		return &d
	}
	return a
}

func (s *Service) seriesCodes(ctx context.Context) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT code FROM market_series WHERE code = ANY($1::text[]) ORDER BY code`,
		[]string{niftyCode, vixCode})
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
	q := &IndexQuote{Code: code, Name: name, Value: vals[0], AsOf: dates[0].Format(time.DateOnly), Source: "import", Unit: unitOf(code)}
	if len(vals) < 2 || vals[1] == 0 || !finite(vals[0]) || !finite(vals[1]) {
		q.ChangeReason = ptr("no_previous_value")
		return q, nil
	}
	q.Change = ptr(round(vals[0]-vals[1], 4))
	q.ChangePct = ptr(round((vals[0]/vals[1]-1)*100, 4))
	return q, nil
}

// unitOf: the VIX is an annualised implied volatility (percent), not an index level in points.
func unitOf(code string) string {
	if code == vixCode {
		return "percent (annualised implied volatility)"
	}
	return "index points"
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

// moversSQL ranks tracked stocks by the day change between the newest bar date ($3) and the trading
// day just before it ($4). A stock needs a bar on both dates (never a multi-day gap), a 60-day average
// traded value of at least $1 crore over its last 60 bars, and no unconfirmed (detected) corporate
// action in between, because the unadjusted gap would be a false move.
const moversSQL = `
WITH chg AS (
  SELECT i.id, i.symbol, i.name, c.close, c.volume, c.trade_date,
         (c.adj_close / q.adj_close - 1) * 100 AS pct
  FROM price_daily c
  JOIN price_daily q ON q.instrument_id = c.instrument_id AND q.trade_date = $4::date AND NOT q.suspect AND q.adj_close > 0
  JOIN instrument i ON i.id = c.instrument_id AND i.is_tracked AND i.status = 'active' AND i.instrument_kind = 'equity'
  WHERE c.trade_date = $3::date AND NOT c.suspect AND c.volume > 0
    AND NOT EXISTS (SELECT 1 FROM corporate_action a WHERE a.instrument_id = i.id AND a.status = 'detected'
                    AND a.ex_date > $4::date AND a.ex_date <= $3::date)
), liq AS (
  SELECT chg.* FROM chg
  JOIN LATERAL (SELECT count(x.close * x.volume) AS n, avg(x.close * x.volume) / 1e7 AS adv
                FROM (SELECT p.close, p.volume FROM price_daily p
                      WHERE p.instrument_id = chg.id AND NOT p.suspect AND p.trade_date <= $3::date
                      ORDER BY p.trade_date DESC LIMIT 60) x) a ON a.n = 60 AND a.adv >= $1
)
(SELECT 'g', symbol, name, close, volume, trade_date, pct FROM liq WHERE pct > 0 ORDER BY pct DESC, symbol LIMIT $2)
UNION ALL
(SELECT 'l', symbol, name, close, volume, trade_date, pct FROM liq WHERE pct < 0 ORDER BY pct ASC, symbol LIMIT $2)`

// pairCountSQL counts the eligible stocks that have a bar on both movers dates ($1 newest, $2 previous).
const pairCountSQL = `SELECT count(*) FROM price_daily c
  JOIN price_daily q ON q.instrument_id = c.instrument_id AND q.trade_date = $2::date AND NOT q.suspect
  JOIN instrument i ON i.id = c.instrument_id AND i.is_tracked AND i.status = 'active' AND i.instrument_kind = 'equity'
  WHERE c.trade_date = $1::date AND NOT c.suspect`

// movers returns the lists, the movers_reason (nil when there are movers) and the newest bar date.
func (s *Service) movers(ctx context.Context, cal instruments.Calendar) (Movers, *string, *time.Time, error) {
	m := Movers{Gainers: []Mover{}, Losers: []Mover{}}
	var last pgtype.Date
	if err := s.db.QueryRow(ctx, `SELECT max(p.trade_date) FROM price_daily p JOIN instrument i ON i.id = p.instrument_id
		WHERE i.is_tracked AND NOT p.suspect`).Scan(&last); err != nil {
		return m, nil, nil, err
	}
	if !last.Valid {
		return m, ptr(ReasonNoPrices), nil, nil
	}
	lastD := last.Time
	prev := cal.PreviousTradingDate(lastD)
	rows, err := s.db.Query(ctx, moversSQL, MinMoverADVCr, MoverLimit, lastD.Format(time.DateOnly), prev.Format(time.DateOnly))
	if err != nil {
		return m, nil, &lastD, err
	}
	defer rows.Close()
	for rows.Next() {
		var side string
		var mv Mover
		var d pgtype.Date
		if err := rows.Scan(&side, &mv.Symbol, &mv.Name, &mv.Close, &mv.Volume, &d, &mv.ChangePct); err != nil {
			return m, nil, &lastD, err
		}
		if !finite(mv.ChangePct) {
			continue
		}
		mv.ChangePct = round(mv.ChangePct, 4)
		mv.AsOf = d.Time.Format(time.DateOnly)
		if side == "g" {
			m.Gainers = append(m.Gainers, mv)
		} else {
			m.Losers = append(m.Losers, mv)
		}
	}
	if err := rows.Err(); err != nil {
		return m, nil, &lastD, err
	}
	if len(m.Gainers)+len(m.Losers) > 0 {
		return m, nil, &lastD, nil
	}
	var pairs int64
	if err := s.db.QueryRow(ctx, pairCountSQL, lastD.Format(time.DateOnly), prev.Format(time.DateOnly)).Scan(&pairs); err != nil {
		return m, nil, &lastD, err
	}
	if pairs == 0 {
		return m, ptr(ReasonNoCommonDates), &lastD, nil
	}
	return m, ptr(ReasonNoQualifying), &lastD, nil
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
