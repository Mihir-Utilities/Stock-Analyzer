package ownerdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
)

// Errors the handlers map onto the envelope.
var ErrNotFound = errors.New("ownerdata: instrument not found")

// FieldError is a validation problem on one query parameter.
type FieldError struct{ Field, Message string }

// ValidationError carries 422 field problems.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "ownerdata: validation failed" }

// Staleness limits (docs/03 section 1).
const (
	fundamentalsStaleDays = 120
	shareholdingStaleDays = 135
)

var ist = time.FixedZone("IST", 5*3600+1800)

// Result is a computed payload plus what the envelope `meta` and `warnings[]` need.
type Result struct {
	Redirect      string // alias hit: answer {"redirect_symbol": ...} only
	Data          any
	AsOf          time.Time
	Source        string
	Stale         bool
	StaleAgeHours float64
	Warnings      []Warning
}

// Warning is one response-level warning.
type Warning struct{ Code, Message string }

// Service reads owner-entered data. It never writes (B06) and never computes derived metrics
// (worker D05b): derived values are read from analysis_snapshot.
type Service struct {
	q     *dbq.Queries
	links []LinkTemplate
	Now   func() time.Time
}

// New builds a Service over a pool; links are the validated research link templates.
func New(db dbq.DBTX, links []LinkTemplate) *Service {
	return &Service{q: dbq.New(db), links: links, Now: time.Now}
}

type target struct {
	id          int32
	symbol      string
	name        string
	companyType string
}

// resolve finds the instrument by symbol, then by alias. It has no side effects (unlike opening
// the stock profile): an alias yields a redirect.
func (s *Service) resolve(ctx context.Context, symbol string) (t target, redirect string, err error) {
	symbol = strings.TrimSpace(symbol)
	if symbol == "" {
		return t, "", ErrNotFound
	}
	row, err := s.q.FindInstrumentForOwnerData(ctx, symbol)
	if err == nil {
		return target{row.ID, row.Symbol, row.Name, row.CompanyType}, "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return t, "", err
	}
	alias, aerr := s.q.FindAliasTarget(ctx, symbol)
	if errors.Is(aerr, pgx.ErrNoRows) {
		return t, "", ErrNotFound
	}
	if aerr != nil {
		return t, "", aerr
	}
	return t, alias, nil
}

func ageHours(from, now time.Time) float64 {
	h := now.Sub(from).Hours()
	if h < 0 {
		return 0
	}
	return float64(int(h*10)) / 10
}

// Fundamentals serves GET /stocks/{symbol}/fundamentals. basis defaults to auto, period to Q.
func (s *Service) Fundamentals(ctx context.Context, symbol, basis, period string) (Result, error) {
	var fe []FieldError
	if basis == "" {
		basis = "auto"
	}
	if basis != "auto" && basis != "consolidated" && basis != "standalone" {
		fe = append(fe, FieldError{"basis", "must be one of consolidated, standalone, auto"})
	}
	if period == "" {
		period = "Q"
	}
	if period != "Q" && period != "A" {
		fe = append(fe, FieldError{"period", "must be Q or A"})
	}
	if len(fe) > 0 {
		return Result{}, &ValidationError{fe}
	}
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil {
		return Result{}, err
	}
	if redirect != "" {
		return Result{Redirect: redirect}, nil
	}
	bases, err := s.q.ListFundamentalBases(ctx, dbq.ListFundamentalBasesParams{InstrumentID: t.id, PeriodType: period})
	if err != nil {
		return Result{}, err
	}
	in := FundamentalsInput{Requested: basis, PeriodType: period, CompanyType: t.companyType}
	for _, b := range bases {
		in.Bases = append(in.Bases, BasisCount{Basis: b.Basis, Periods: int(b.Periods)})
	}
	var rowsErr error
	in.Rows = func(b string) []FundRow {
		rs, err := s.q.ListFundamentalValues(ctx, dbq.ListFundamentalValuesParams{InstrumentID: t.id, Basis: b, PeriodType: period})
		if err != nil {
			rowsErr = err
			return nil
		}
		out := make([]FundRow, 0, len(rs))
		for _, r := range rs {
			if !r.Value.Valid || !r.PeriodEnd.Valid {
				continue
			}
			out = append(out, FundRow{PeriodEnd: r.PeriodEnd.Time, Key: r.MetricKey, Value: r.Value.Float64,
				Unit: r.Unit, Source: r.Source, FetchedAt: r.FetchedAt.Time})
		}
		return out
	}
	meta, merr := s.q.GetFundamentalMeta(ctx, t.id)
	switch {
	case merr == nil:
		in.MetaStatus = meta.Status
	case !errors.Is(merr, pgx.ErrNoRows):
		return Result{}, merr
	}
	snap, serr := s.q.GetLatestSnapshotFundamentals(ctx, t.id)
	switch {
	case serr == nil:
		in.Snapshot = json.RawMessage(snap.Fundamentals)
	case !errors.Is(serr, pgx.ErrNoRows):
		return Result{}, serr
	}
	data, err := BuildFundamentals(in)
	if rowsErr != nil {
		return Result{}, rowsErr
	}
	if err != nil {
		return Result{}, err
	}
	now := s.Now()
	res := Result{Data: data, AsOf: now, Source: "none"}
	for _, w := range data.Warnings {
		res.Warnings = append(res.Warnings, Warning{"BASIS_NOT_MIXED", w})
	}
	if u := data.UpdatedAt(); !u.IsZero() {
		ref := u
		if meta.LastSuccess.Valid {
			ref = meta.LastSuccess.Time
		}
		res.AsOf, res.Source = u, "owner_entered"
		if data.LastUpdatedSource != nil {
			res.Source = *data.LastUpdatedSource
		}
		res.StaleAgeHours = ageHours(ref, now)
		res.Stale = now.Sub(ref) > fundamentalsStaleDays*24*time.Hour
	}
	return res, nil
}

// Shareholding serves GET /stocks/{symbol}/shareholding.
func (s *Service) Shareholding(ctx context.Context, symbol string) (Result, error) {
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil {
		return Result{}, err
	}
	if redirect != "" {
		return Result{Redirect: redirect}, nil
	}
	rs, err := s.q.ListShareholding(ctx, t.id)
	if err != nil {
		return Result{}, err
	}
	rows := make([]SHRow, 0, len(rs))
	for _, r := range rs {
		row := SHRow{
			QuarterEnd: r.QuarterEnd.Time, Promoter: f32p(r.PromoterPct), FII: f32p(r.FiiPct), DII: f32p(r.DiiPct),
			MF: f32p(r.MfPct), Insurance: f32p(r.InsurancePct), Govt: f32p(r.GovtPct), Public: f32p(r.PublicPct),
			Pledged: f32p(r.PromoterPledgedPct), Source: r.Source, FetchedAt: r.FetchedAt.Time,
		}
		if r.FiledOn.Valid {
			d := r.FiledOn.Time
			row.FiledOn = &d
		}
		rows = append(rows, row)
	}
	data := BuildShareholding(rows)
	now := s.Now()
	res := Result{Data: data, AsOf: now, Source: "none"}
	if data.LatestQuarterEnd != nil {
		res.AsOf = data.UpdatedAt
		res.Source = *data.Source
		res.StaleAgeHours = ageHours(*data.LatestQuarterEnd, now)
		res.Stale = now.Sub(*data.LatestQuarterEnd) > shareholdingStaleDays*24*time.Hour
	}
	return res, nil
}

func f32p(v pgtype.Float4) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float32
	return f32(&f)
}

// Action is one corporate action row (docs/03 section 5; status and source added so detected and
// rejected rows are distinguishable).
type Action struct {
	ID             int64    `json:"id"`
	ExDate         string   `json:"ex_date"`
	RecordDate     *string  `json:"record_date"`
	Type           string   `json:"type"`
	Status         string   `json:"status"`
	RatioNum       *float64 `json:"ratio_num"`
	RatioDen       *float64 `json:"ratio_den"`
	AmountPerShare *float64 `json:"amount_per_share"`
	PurposeText    string   `json:"purpose_text"`
	Source         string   `json:"source"`
}

// CalendarEvent is one upcoming/past owner-entered event.
type CalendarEvent struct {
	EventDate string  `json:"event_date"`
	Type      string  `json:"type"`
	Details   *string `json:"details"`
	Source    string  `json:"source"`
}

// Events is `data` of GET /stocks/{symbol}/events.
type Events struct {
	Actions   []Action        `json:"actions"`
	Calendar  []CalendarEvent `json:"calendar"`
	Reason    *string         `json:"reason"`
	EntryHint *string         `json:"entry_hint"`
}

var farFuture = time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)

func parseDate(field, v string, fe *[]FieldError) (time.Time, bool) {
	if v == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.DateOnly, v)
	if err != nil {
		*fe = append(*fe, FieldError{field, "must be a date YYYY-MM-DD"})
		return time.Time{}, false
	}
	return t, true
}

// Events serves GET /stocks/{symbol}/events?from=&to=. Defaults: actions of the last 5 years (no
// upper bound, so a coming ex-date shows), calendar of the next 90 days. Detected and rejected
// actions are included with their status; detected ones add an UNCONFIRMED_ACTION warning.
func (s *Service) Events(ctx context.Context, symbol, from, to string) (Result, error) {
	var fe []FieldError
	fromT, hasFrom := parseDate("from", from, &fe)
	toT, hasTo := parseDate("to", to, &fe)
	if hasFrom && hasTo && toT.Before(fromT) {
		fe = append(fe, FieldError{"to", "must not be before from"})
	}
	if len(fe) > 0 {
		return Result{}, &ValidationError{fe}
	}
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil {
		return Result{}, err
	}
	if redirect != "" {
		return Result{Redirect: redirect}, nil
	}
	now := s.Now().In(ist)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	aFrom, aTo := today.AddDate(-5, 0, 0), farFuture
	cFrom, cTo := today, today.AddDate(0, 0, 90)
	if hasFrom {
		aFrom, cFrom = fromT, fromT
	}
	if hasTo {
		aTo, cTo = toT, toT
	}
	acts, err := s.q.ListCorporateActions(ctx, dbq.ListCorporateActionsParams{
		InstrumentID: t.id, FromDate: pgDate(aFrom), ToDate: pgDate(aTo)})
	if err != nil {
		return Result{}, err
	}
	cal, err := s.q.ListCalendarEvents(ctx, dbq.ListCalendarEventsParams{
		InstrumentID: t.id, FromDate: pgDate(cFrom), ToDate: pgDate(cTo)})
	if err != nil {
		return Result{}, err
	}
	out := Events{Actions: []Action{}, Calendar: []CalendarEvent{}}
	res := Result{AsOf: now.UTC(), Source: "owner_entered"}
	for _, a := range acts {
		item := Action{ID: a.ID, ExDate: a.ExDate.Time.Format(time.DateOnly), Type: a.ActionType, Status: a.Status,
			PurposeText: a.PurposeText, Source: a.Source}
		if a.RecordDate.Valid {
			d := a.RecordDate.Time.Format(time.DateOnly)
			item.RecordDate = &d
		}
		item.RatioNum, item.RatioDen, item.AmountPerShare = nf(a.RatioNum.Valid, a.RatioNum.Decimal.InexactFloat64()),
			nf(a.RatioDen.Valid, a.RatioDen.Decimal.InexactFloat64()),
			nf(a.AmountPerShare.Valid, a.AmountPerShare.Decimal.InexactFloat64())
		out.Actions = append(out.Actions, item)
		if a.Status == "detected" {
			res.Warnings = append(res.Warnings, Warning{"UNCONFIRMED_ACTION", fmt.Sprintf(
				"Possible %s on %s not yet confirmed", strings.ReplaceAll(a.ActionType, "_", " "), item.ExDate)})
		}
	}
	for _, c := range cal {
		item := CalendarEvent{EventDate: c.EventDate.Time.Format(time.DateOnly), Type: c.EventType, Source: c.Source}
		if c.Details.Valid {
			d := c.Details.String
			item.Details = &d
		}
		out.Calendar = append(out.Calendar, item)
	}
	if len(out.Actions) == 0 && len(out.Calendar) == 0 {
		r, h := ReasonNoData, "Add corporate actions via Import or the manual form"
		out.Reason, out.EntryHint = &r, &h
		res.Source = "none"
	}
	res.Data = out
	return res, nil
}

func nf(valid bool, v float64) *float64 {
	if !valid {
		return nil
	}
	return &v
}

func pgDate(t time.Time) pgtype.Date { return pgtype.Date{Time: t, Valid: true} }

// Links serves GET /stocks/{symbol}/links. Pure string rendering: nothing is requested (SAF-06).
func (s *Service) Links(ctx context.Context, symbol string) (Result, error) {
	t, redirect, err := s.resolve(ctx, symbol)
	if err != nil {
		return Result{}, err
	}
	if redirect != "" {
		return Result{Redirect: redirect}, nil
	}
	return Result{
		Data:   map[string]any{"links": RenderLinks(s.links, t.symbol, t.name)},
		AsOf:   s.Now().UTC(),
		Source: "config",
	}, nil
}
