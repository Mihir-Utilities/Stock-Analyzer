package prices

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/instruments"
	"github.com/india-analyzer/api/internal/validate"
)

// Errors the handlers map onto the envelope.
var (
	ErrNotFound = errors.New("prices: instrument not found")
	// ErrUnavailable carries a DATA_UNAVAILABLE reason.
	ErrUnavailable = errors.New("prices: data unavailable")
)

// UnavailableError is a valid target without data (DATA_UNAVAILABLE, details.reason).
type UnavailableError struct{ Reason string }

func (e *UnavailableError) Error() string   { return "prices: data unavailable: " + e.Reason }
func (e *UnavailableError) Is(t error) bool { return t == ErrUnavailable }

// Reasons (manual price mode, D-1): no bars imported, or bars exist but no snapshot yet.
const (
	ReasonNoPricesImported = "no_prices_imported"
	ReasonNoHistory        = "no_history"
)

// FieldError is a validation problem on one query parameter.
type FieldError struct{ Field, Message string }

// ValidationError carries 422 field problems.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "prices: validation failed" }

// Warning mirrors an envelope warning without importing the HTTP layer.
type Warning struct{ Code, Message string }

// Service reads bars and snapshots. Inst supplies the freshness calendar and the history rule.
type Service struct {
	q    *dbq.Queries
	Inst *instruments.Service
}

// New builds a Service.
func New(db dbq.DBTX, inst *instruments.Service) *Service {
	return &Service{q: dbq.New(db), Inst: inst}
}

// Params are the validated query parameters of GET /stocks/{symbol}/prices.
type Params struct {
	Range    string
	Adjusted bool
}

var rangeMonths = map[string]int{"1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "MAX": 0}

// ParseParams validates range (default 1Y), adjusted (default true) and downsample (only `auto`).
func ParseParams(v map[string][]string) (Params, error) {
	get := func(k string) (string, bool) {
		if xs, ok := v[k]; ok && len(xs) > 0 {
			return xs[0], true
		}
		return "", false
	}
	p := Params{Range: "1Y", Adjusted: true}
	var fe []FieldError
	if r, ok := get("range"); ok {
		if _, valid := rangeMonths[r]; !valid {
			fe = append(fe, FieldError{"range", "must be one of 1M, 3M, 6M, 1Y, 3Y, 5Y, MAX"})
		}
		p.Range = r
	}
	if a, ok := get("adjusted"); ok {
		b, err := strconv.ParseBool(a)
		if err != nil || (a != "true" && a != "false") {
			fe = append(fe, FieldError{"adjusted", "must be true or false"})
		}
		p.Adjusted = b
	}
	if d, ok := get("downsample"); ok && d != "auto" {
		fe = append(fe, FieldError{"downsample", "must be auto"})
	}
	if len(fe) > 0 {
		return Params{}, &ValidationError{Fields: fe}
	}
	return p, nil
}

// Action is a chart marker for a confirmed split/bonus.
type Action struct {
	Date  string `json:"date"`
	Type  string `json:"type"`
	Label string `json:"label"`
}

// Depth states how much history exists (BRK-06).
type Depth struct {
	FirstBar string `json:"first_bar"`
	LastBar  string `json:"last_bar"`
	Bars     int    `json:"bars"`
}

// PricesPayload is `data` of GET /stocks/{symbol}/prices.
type PricesPayload struct {
	Bars           [][]any  `json:"bars"`
	Adjusted       bool     `json:"adjusted"`
	Actions        []Action `json:"actions"`
	Range          string   `json:"range"`
	LimitedHistory bool     `json:"limited_history"`
	Depth          Depth    `json:"depth"`
}

// Result wraps a payload with what the envelope needs.
type Result[T any] struct {
	RedirectSymbol string
	Data           T
	AsOf           time.Time
	Interval       string
	Stale          instruments.Staleness
	Warnings       []Warning
}

type target struct {
	id      int32
	listing pgtype.Date
}

func (s *Service) resolve(ctx context.Context, symbol string) (target, string, error) {
	symbol = strings.TrimSpace(symbol)
	if symbol == "" || !validate.Text(symbol) {
		return target{}, "", ErrNotFound
	}
	found, err := s.q.FindInstrumentBySymbol(ctx, symbol)
	if errors.Is(err, pgx.ErrNoRows) {
		alias, aerr := s.q.FindAliasTarget(ctx, symbol)
		if errors.Is(aerr, pgx.ErrNoRows) {
			return target{}, "", ErrNotFound
		}
		return target{}, alias, aerr
	}
	if err != nil {
		return target{}, "", err
	}
	inst, err := s.q.GetInstrumentListing(ctx, found.ID)
	if err != nil {
		return target{}, "", err
	}
	return target{id: inst.ID, listing: inst.ListingDate}, "", nil
}

func rd(v float64) float64 { return math.Round(v*1e4) / 1e4 }

// Prices serves the bars of one stock. Anchor of the range is the last valid bar (not today), so a
// stale import still shows its latest window. Empty -> UnavailableError{no_prices_imported}.
func (s *Service) Prices(ctx context.Context, symbol string, p Params) (Result[PricesPayload], error) {
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil || redirect != "" {
		return Result[PricesPayload]{RedirectSymbol: redirect}, err
	}
	rng, err := s.q.GetValidBarRange(ctx, t.id)
	if err != nil {
		return Result[PricesPayload]{}, err
	}
	if rng.Bars == 0 || !rng.LastBar.Valid {
		return Result[PricesPayload]{}, &UnavailableError{Reason: ReasonNoPricesImported}
	}
	last, first := rng.LastBar.Time, rng.FirstBar.Time
	from := first
	if m := rangeMonths[p.Range]; m > 0 {
		from = last.AddDate(0, -m, 0)
	}
	rows, err := s.q.ListValidBars(ctx, dbq.ListValidBarsParams{
		InstrumentID: t.id, TradeDate: pgtype.Date{Time: from, Valid: true},
	})
	if err != nil {
		return Result[PricesPayload]{}, err
	}
	daily := make([]Bar, 0, len(rows))
	for _, r := range rows {
		b := Bar{Date: r.TradeDate.Time, Open: r.Open, High: r.High, Low: r.Low, Close: r.Close, Volume: r.Volume}
		if p.Adjusted && r.Close > 0 {
			f := r.AdjClose / r.Close
			b.Open, b.High, b.Low, b.Close = r.Open*f, r.High*f, r.Low*f, r.AdjClose
		}
		daily = append(daily, b)
	}
	reduced, interval := Reduce(daily)
	out := make([][]any, 0, len(reduced))
	for _, b := range reduced {
		out = append(out, []any{b.Date.Format(time.DateOnly), rd(b.Open), rd(b.High), rd(b.Low), rd(b.Close), b.Volume})
	}
	actions, warns, err := s.actions(ctx, t.id, from)
	if err != nil {
		return Result[PricesPayload]{}, err
	}
	stale, err := s.Inst.Staleness(ctx, &last)
	if err != nil {
		return Result[PricesPayload]{}, err
	}
	return Result[PricesPayload]{
		Data: PricesPayload{
			Bars: out, Adjusted: p.Adjusted, Actions: actions, Range: p.Range,
			LimitedHistory: s.Inst.LimitedHistory(ctx, &first, t.listing),
			Depth: Depth{FirstBar: first.Format(time.DateOnly), LastBar: last.Format(time.DateOnly),
				Bars: int(rng.Bars)},
		},
		AsOf: last, Interval: interval, Stale: stale, Warnings: warns,
	}, nil
}

// Indicators serves the latest analysis_snapshot with the series expanded to date/value pairs.
func (s *Service) Indicators(ctx context.Context, symbol string) (Result[map[string]any], error) {
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil || redirect != "" {
		return Result[map[string]any]{RedirectSymbol: redirect}, err
	}
	snap, err := s.q.GetLatestSnapshot(ctx, t.id)
	if errors.Is(err, pgx.ErrNoRows) {
		rng, rerr := s.q.GetValidBarRange(ctx, t.id)
		if rerr != nil {
			return Result[map[string]any]{}, rerr
		}
		if rng.Bars == 0 {
			return Result[map[string]any]{}, &UnavailableError{Reason: ReasonNoPricesImported}
		}
		// Bars exist but fewer than the minimum, or the recompute has not run yet.
		return Result[map[string]any]{}, &UnavailableError{Reason: ReasonNoHistory}
	}
	if err != nil {
		return Result[map[string]any]{}, err
	}
	data, err := ExpandIndicators(snap.Indicators, snap.Scores)
	if err != nil {
		return Result[map[string]any]{}, err
	}
	asOf := snap.AsOf.Time
	stale, err := s.Inst.Staleness(ctx, &asOf)
	if err != nil {
		return Result[map[string]any]{}, err
	}
	_, warns, err := s.actions(ctx, t.id, time.Time{})
	if err != nil {
		return Result[map[string]any]{}, err
	}
	return Result[map[string]any]{Data: data, AsOf: asOf, Stale: stale, Warnings: warns}, nil
}

// actions returns the confirmed markers and an UNCONFIRMED_ACTION warning per detected candidate
// (never applied until the owner confirms, docs/03 section 1).
func (s *Service) actions(ctx context.Context, id int32, from time.Time) ([]Action, []Warning, error) {
	if from.IsZero() {
		from = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	rows, err := s.q.ListPriceActions(ctx, dbq.ListPriceActionsParams{
		InstrumentID: id, ExDate: pgtype.Date{Time: from, Valid: true},
	})
	if err != nil {
		return nil, nil, err
	}
	acts := []Action{}
	var warns []Warning
	for _, r := range rows {
		day := r.ExDate.Time.Format(time.DateOnly)
		if r.Status == "detected" {
			warns = append(warns, Warning{Code: "UNCONFIRMED_ACTION",
				Message: fmt.Sprintf("Possible %s on %s not yet confirmed", kindWord(r.ActionType), day)})
			continue
		}
		acts = append(acts, Action{Date: day, Type: r.ActionType, Label: label(r)})
	}
	return acts, warns, nil
}

func kindWord(t string) string {
	if t == "split_or_bonus" {
		return "split or bonus"
	}
	return t
}

func label(r dbq.ListPriceActionsRow) string {
	w := kindWord(r.ActionType)
	if r.RatioNum.Valid && r.RatioDen.Valid {
		return r.RatioNum.Decimal.String() + ":" + r.RatioDen.Decimal.String() + " " + w
	}
	return w
}
