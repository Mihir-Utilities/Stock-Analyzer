package instruments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/pagination"
)

// Index flag bits (docs/03 section 3). Bit 1 (broker_ok) is always 0 in manual price mode (D-1).
const (
	FlagBrokerOK   = 1
	FlagTracked    = 2
	FlagSuspended  = 4
	FlagDelisted   = 8
	FlagNonEquity  = 16
	FlagFinancial  = 32
	FlagInNifty50  = 64
	FlagInNifty100 = 128
)

// Errors the handlers map onto the envelope.
var (
	ErrNotFound      = errors.New("instruments: not found")
	ErrInvalidCursor = pagination.ErrInvalidCursor
)

// FieldError is a validation problem on one query parameter.
type FieldError struct{ Field, Message string }

// ValidationError carries 422 field problems.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "instruments: validation failed" }

// Service is the stock list/search/profile use-case layer.
type Service struct {
	q   *dbq.Queries
	Now func() time.Time
}

// New builds a Service over a pool (or anything satisfying dbq.DBTX).
func New(db dbq.DBTX) *Service { return &Service{q: dbq.New(db), Now: time.Now} }

// IndexPayload is `data` of GET /stocks/index.
type IndexPayload struct {
	GeneratedAt string  `json:"generated_at"`
	Count       int     `json:"count"`
	Items       [][]any `json:"items"`
}

// Index returns the compact list and its ETag (a hash of the items only, so it is stable while the
// list is unchanged). The list is never empty-filtered; with zero instruments `count` is 0.
func (s *Service) Index(ctx context.Context) (IndexPayload, string, error) {
	rows, err := s.q.ListStockIndex(ctx)
	if err != nil {
		return IndexPayload{}, "", err
	}
	items := make([][]any, 0, len(rows))
	for _, r := range rows {
		items = append(items, []any{r.ID, r.Symbol, r.Name, r.Flags})
	}
	b, err := json.Marshal(items)
	if err != nil {
		return IndexPayload{}, "", err
	}
	sum := sha256.Sum256(b)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	return IndexPayload{
		GeneratedAt: s.Now().UTC().Format(time.RFC3339),
		Count:       len(items),
		Items:       items,
	}, etag, nil
}

// SearchParams are the validated query parameters of GET /stocks.
type SearchParams struct {
	Q      string // empty = browse alphabetically
	Index  string
	Sector string
	Kind   string
	Status string
	Page   pagination.Params
}

var (
	validKinds    = map[string]bool{"equity": true, "etf": true, "reit": true, "invit": true, "sme": true, "other": true}
	validStatuses = map[string]bool{"active": true, "suspended": true, "delisted": true, "symbol_changed": true}
)

const maxFilterLen = 100

// ParseSearch validates the query string of GET /stocks. A present but empty `q` is a 422 ("min 1
// char"); an absent `q` lists alphabetically.
func ParseSearch(v map[string][]string) (SearchParams, error) {
	get := func(k string) (string, bool) {
		if xs, ok := v[k]; ok && len(xs) > 0 {
			return xs[0], true
		}
		return "", false
	}
	var fe []FieldError
	p := SearchParams{Kind: "equity", Status: "active"}
	if q, ok := get("q"); ok {
		q = strings.TrimSpace(q)
		if q == "" {
			fe = append(fe, FieldError{"q", "must be at least 1 character"})
		} else if utf8.RuneCountInString(q) > maxFilterLen {
			fe = append(fe, FieldError{"q", "must be at most 100 characters"})
		}
		p.Q = q
	}
	for _, f := range []struct {
		key string
		dst *string
	}{{"index", &p.Index}, {"sector", &p.Sector}} {
		if x, ok := get(f.key); ok {
			x = strings.TrimSpace(x)
			if utf8.RuneCountInString(x) > maxFilterLen {
				fe = append(fe, FieldError{f.key, "must be at most 100 characters"})
			}
			*f.dst = x
		}
	}
	if k, ok := get("kind"); ok && k != "" {
		if !validKinds[k] {
			fe = append(fe, FieldError{"kind", "must be one of equity, etf, reit, invit, sme, other"})
		}
		p.Kind = k
	}
	if st, ok := get("status"); ok && st != "" {
		if !validStatuses[st] {
			fe = append(fe, FieldError{"status", "must be one of active, suspended, delisted, symbol_changed"})
		}
		p.Status = st
	}
	pg, err := pagination.Parse(v)
	switch {
	case errors.Is(err, pagination.ErrInvalidLimit):
		fe = append(fe, FieldError{"limit", "must be a positive integer"})
	case err != nil:
		return SearchParams{}, ErrInvalidCursor
	}
	p.Page = pg
	if len(fe) > 0 {
		return SearchParams{}, &ValidationError{Fields: fe}
	}
	return p, nil
}

// StockItem is one row of GET /stocks.
type StockItem struct {
	ID             int32   `json:"id"`
	Symbol         string  `json:"symbol"`
	Name           string  `json:"name"`
	ISIN           *string `json:"isin"`
	Series         string  `json:"series"`
	Sector         *string `json:"sector"`
	Industry       *string `json:"industry"`
	CompanyType    string  `json:"company_type"`
	Status         string  `json:"status"`
	InstrumentKind string  `json:"instrument_kind"`
	Tracked        bool    `json:"tracked"`
}

type cursorKey struct {
	Rank   int32
	NegSim float64
	Symbol string
}

// Search runs the ranked search: exact symbol, symbol prefix, name prefix, trigram >= 0.3.
func (s *Service) Search(ctx context.Context, p SearchParams) (pagination.Page[StockItem], error) {
	arg := dbq.SearchStocksParams{
		Q: p.Q, Kind: p.Kind, Status: p.Status, Sector: p.Sector, IndexName: p.Index,
		RowLimit: int32(min(p.Page.Limit, pagination.MaxLimit) + 1), //nolint:gosec // bounded by pagination.MaxLimit
	}
	if p.Page.Cursor != "" {
		var raw [3]json.RawMessage
		if err := pagination.Decode(p.Page.Cursor, &raw); err != nil {
			return pagination.Page[StockItem]{}, ErrInvalidCursor
		}
		var k cursorKey
		if json.Unmarshal(raw[0], &k.Rank) != nil || json.Unmarshal(raw[1], &k.NegSim) != nil ||
			json.Unmarshal(raw[2], &k.Symbol) != nil || k.Rank < 0 || k.Rank > 3 {
			return pagination.Page[StockItem]{}, ErrInvalidCursor
		}
		arg.HasCursor, arg.CurRank, arg.CurNegSim, arg.CurSymbol = true, k.Rank, k.NegSim, k.Symbol
	}
	rows, err := s.q.SearchStocks(ctx, arg)
	if err != nil {
		return pagination.Page[StockItem]{}, err
	}
	page := pagination.Page[StockItem]{Items: make([]StockItem, 0, len(rows))}
	for i, r := range rows {
		if i == p.Page.Limit { // the extra row only proves there is a next page
			last := rows[i-1]
			c, err := pagination.Encode(last.Rank, -last.Sim, last.Symbol)
			if err != nil {
				return pagination.Page[StockItem]{}, err
			}
			page.NextCursor = &c
			break
		}
		page.Items = append(page.Items, StockItem{
			ID: r.ID, Symbol: r.Symbol, Name: r.Name, ISIN: text(r.Isin), Series: r.Series,
			Sector: text(r.Sector), Industry: text(r.Industry), CompanyType: r.CompanyType,
			Status: r.Status, InstrumentKind: r.InstrumentKind, Tracked: r.IsTracked,
		})
	}
	return page, nil
}

// Quote is the optional quote block; absent in manual price mode unless a row exists.
type Quote struct {
	LTP         float64  `json:"ltp"`
	PrevClose   *float64 `json:"prev_close"`
	Change      *float64 `json:"change"`
	ChangePct   *float64 `json:"change_pct"`
	DayHigh     *float64 `json:"day_high"`
	DayLow      *float64 `json:"day_low"`
	Wk52High    *float64 `json:"wk52_high"`
	Wk52Low     *float64 `json:"wk52_low"`
	Volume      *int64   `json:"volume"`
	MarketCapCr *float64 `json:"market_cap_cr"`
	QuoteTS     string   `json:"quote_ts"`
	Source      string   `json:"source"`
}

// Freshness is the profile freshness block.
type Freshness struct {
	PricesStale      bool    `json:"prices_stale"`
	HolidaysMissing  bool    `json:"holidays_missing"`
	PricesAsOf       *string `json:"prices_as_of"`
	FundamentalsAsOf *string `json:"fundamentals_as_of"`
	ShareholdingAsOf *string `json:"shareholding_as_of"`
	PredictionsAsOf  *string `json:"predictions_as_of"`
}

// Flags is the profile flags block. SeriesWarning is the exchange series code when it is not EQ
// (the UI owns the wording), else null.
type Flags struct {
	NoPrices       bool    `json:"no_prices"`
	LimitedHistory bool    `json:"limited_history"`
	SeriesWarning  *string `json:"series_warning"`
}

// Profile is `data` of GET /stocks/{symbol}.
type Profile struct {
	ID             int32     `json:"id"`
	Symbol         string    `json:"symbol"`
	Name           string    `json:"name"`
	ISIN           *string   `json:"isin"`
	Series         string    `json:"series"`
	Sector         *string   `json:"sector"`
	Industry       *string   `json:"industry"`
	CompanyType    string    `json:"company_type"`
	Status         string    `json:"status"`
	InstrumentKind string    `json:"instrument_kind"`
	ListingDate    *string   `json:"listing_date"`
	BrokerOK       *bool     `json:"broker_ok"`
	Tracked        bool      `json:"tracked"`
	PriceMode      string    `json:"price_mode"`
	Quote          *Quote    `json:"quote"`
	Freshness      Freshness `json:"freshness"`
	Flags          Flags     `json:"flags"`
	// Hint is set when there are no prices (docs/03 section 3, BRK-07).
	Hint *string `json:"hint,omitempty"`
}

// ProfileResult is either a redirect (alias) or a profile, plus the staleness for `meta`.
type ProfileResult struct {
	RedirectSymbol string
	Profile        *Profile
	Stale          Staleness
}

// Open resolves a symbol (instrument first, then alias), stamps last_opened_at, tracks the stock
// when it was untracked, and assembles the profile. Manual price mode: no backfill job is ever
// enqueued (D-1). An alias answers with the redirect and has no side effects.
func (s *Service) Open(ctx context.Context, symbol string) (ProfileResult, error) {
	symbol = strings.TrimSpace(symbol)
	if symbol == "" {
		return ProfileResult{}, ErrNotFound
	}
	found, err := s.q.FindInstrumentBySymbol(ctx, symbol)
	if errors.Is(err, pgx.ErrNoRows) {
		target, aerr := s.q.FindAliasTarget(ctx, symbol)
		if errors.Is(aerr, pgx.ErrNoRows) {
			return ProfileResult{}, ErrNotFound
		}
		if aerr != nil {
			return ProfileResult{}, aerr
		}
		return ProfileResult{RedirectSymbol: target}, nil
	}
	if err != nil {
		return ProfileResult{}, err
	}
	inst, err := s.q.TouchOpenedInstrument(ctx, found.ID)
	if err != nil {
		return ProfileResult{}, err
	}
	now := s.Now()
	stats, err := s.q.GetPriceStats(ctx, inst.ID)
	if err != nil {
		return ProfileResult{}, err
	}
	var lastBar, firstBar *time.Time
	if stats.Bars > 0 && stats.LastBar.Valid {
		lb, fb := stats.LastBar.Time, stats.FirstBar.Time
		lastBar, firstBar = &lb, &fb
	}
	cal, holidaysForYear, err := s.calendar(ctx, now)
	if err != nil {
		return ProfileResult{}, err
	}
	stale := cal.PricesStaleness(now, lastBar, holidaysForYear)

	p := &Profile{
		ID: inst.ID, Symbol: inst.Symbol, Name: inst.Name, ISIN: text(inst.Isin), Series: inst.Series,
		Sector: text(inst.Sector), Industry: text(inst.Industry), CompanyType: inst.CompanyType,
		Status: inst.Status, InstrumentKind: inst.InstrumentKind, ListingDate: date(inst.ListingDate),
		Tracked: inst.IsTracked, PriceMode: "manual",
		Freshness: Freshness{PricesStale: stale.Stale, HolidaysMissing: stale.HolidaysMissed},
	}
	if lastBar != nil {
		d := lastBar.Format(time.DateOnly)
		p.Freshness.PricesAsOf = &d
	} else {
		p.Flags.NoPrices = true
		h := "Import prices.csv for " + inst.Symbol
		p.Hint = &h
	}
	p.Flags.LimitedHistory = s.limitedHistory(ctx, now, firstBar, inst.ListingDate)
	if inst.Series != "EQ" {
		sw := inst.Series
		p.Flags.SeriesWarning = &sw
	}
	if v, err := s.q.GetFundamentalsAsOf(ctx, inst.ID); err == nil {
		p.Freshness.FundamentalsAsOf = date(v)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ProfileResult{}, err
	}
	if v, err := s.q.GetShareholdingAsOf(ctx, inst.ID); err == nil {
		p.Freshness.ShareholdingAsOf = date(v)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ProfileResult{}, err
	}
	if v, err := s.q.GetPredictionsAsOf(ctx, inst.ID); err == nil {
		p.Freshness.PredictionsAsOf = date(v)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ProfileResult{}, err
	}
	if qr, err := s.q.GetQuoteLatest(ctx, inst.ID); err == nil {
		p.Quote = quote(qr)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ProfileResult{}, err
	}
	return ProfileResult{Profile: p, Stale: stale}, nil
}

func (s *Service) calendar(ctx context.Context, now time.Time) (Calendar, bool, error) {
	ist := now.In(IST)
	n, err := s.q.CountHolidaysForYear(ctx, int32(ist.Year())) //nolint:gosec // a calendar year
	if err != nil {
		return Calendar{}, false, err
	}
	from := time.Date(ist.Year(), ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -400)
	dates, err := s.q.ListHolidayDatesForYears(ctx, dbq.ListHolidayDatesForYearsParams{
		HolidayDate:   pgtype.Date{Time: from, Valid: true},
		HolidayDate_2: pgtype.Date{Time: from.AddDate(0, 0, 400), Valid: true},
	})
	if err != nil {
		return Calendar{}, false, err
	}
	hs := make([]time.Time, 0, len(dates))
	for _, d := range dates {
		if d.Valid {
			hs = append(hs, d.Time)
		}
	}
	return NewCalendar(hs), n > 0, nil
}

// limitedHistory: imported history starts clearly later than the depth the analytics expect
// (PRICE_HISTORY_YEARS_TRACKED years, or the listing date when the stock is younger). Grace of 7
// days for weekends and holidays at the start.
func (s *Service) limitedHistory(ctx context.Context, now time.Time, first *time.Time, listing pgtype.Date) bool {
	if first == nil {
		return false
	}
	years := s.historyYears(ctx)
	ist := now.In(IST)
	want := time.Date(ist.Year()-years, ist.Month(), ist.Day(), 0, 0, 0, 0, time.UTC)
	if listing.Valid && listing.Time.After(want) {
		want = listing.Time
	}
	return first.After(want.AddDate(0, 0, 7))
}

func (s *Service) historyYears(ctx context.Context) int {
	row, err := s.q.GetSetting(ctx, "PRICE_HISTORY_YEARS_TRACKED")
	if err != nil {
		return 5
	}
	raw := strings.Trim(strings.TrimSpace(string(row.Value)), `"`)
	if n, err := strconv.Atoi(raw); err == nil && n > 0 && n < 100 {
		return n
	}
	return 5
}

func quote(r dbq.GetQuoteLatestRow) *Quote {
	q := &Quote{LTP: r.Ltp, QuoteTS: r.QuoteTs.Time.UTC().Format(time.RFC3339), Source: r.Source,
		PrevClose: f8(r.PrevClose), DayHigh: f8(r.DayHigh), DayLow: f8(r.DayLow),
		Wk52High: f8(r.Wk52High), Wk52Low: f8(r.Wk52Low), MarketCapCr: f8(r.MarketCapCr)}
	if r.Volume.Valid {
		v := r.Volume.Int64
		q.Volume = &v
	}
	if r.PrevClose.Valid && r.PrevClose.Float64 > 0 {
		ch := r.Ltp - r.PrevClose.Float64
		pct := ch / r.PrevClose.Float64 * 100
		q.Change, q.ChangePct = &ch, &pct
	}
	return q
}

func f8(v pgtype.Float8) *float64 {
	if !v.Valid {
		return nil
	}
	x := v.Float64
	return &x
}

func text(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func date(v pgtype.Date) *string {
	if !v.Valid {
		return nil
	}
	s := v.Time.Format(time.DateOnly)
	return &s
}
