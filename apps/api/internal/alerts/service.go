package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/telegram"
)

// Limits and windows of docs/03 section 13.
const (
	MaxActive       = 200
	LinkCodeTTL     = 15 * time.Minute
	TestMessageGap  = time.Minute
	DefaultCooldown = 1440
)

// Statuses of an alert (DDL CHECK).
const (
	StatusActive  = "active"
	StatusPaused  = "paused"
	StatusFired   = "fired"
	StatusExpired = "expired"
)

// ist is Asia/Kolkata (no daylight saving), used for "today" in market dates.
var ist = time.FixedZone("IST", 5*3600+1800)

// Errors the HTTP layer maps onto the envelope.
var (
	ErrNotFound      = errors.New("alerts: not found")
	ErrLimitReached  = errors.New("alerts: active alert limit reached")
	ErrNotEditable   = errors.New("alerts: fired or expired alerts cannot be changed")
	ErrNotLinked     = errors.New("alerts: telegram is not linked")
	ErrNoTelegram    = errors.New("alerts: telegram is not configured")
	ErrSendFailed    = errors.New("alerts: telegram send failed")
	ErrInvalidCursor = pagination.ErrInvalidCursor
)

// ValidationError carries `details.fields[]`.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "alerts: validation failed" }

// NotFoundTargetError means the symbol or scheme code resolves to nothing.
type NotFoundTargetError struct {
	Type   string
	Symbol string
	Code   int64
}

func (e *NotFoundTargetError) Error() string { return "alerts: target not found" }

// ThresholdMetError is the 422 THRESHOLD_ALREADY_MET (ALR-01).
type ThresholdMetError struct {
	Kind      string
	Threshold float64
	Value     float64
	AsOf      string // market date of the last imported bar or NAV
	IsNAV     bool
}

func (e *ThresholdMetError) Error() string {
	if e.IsNAV {
		return fmt.Sprintf("already true at the latest imported NAV of %s", e.AsOf)
	}
	return fmt.Sprintf("already true at the last imported bar of %s", e.AsOf)
}

// RateLimitedError is the 1-per-minute test message gate.
type RateLimitedError struct{ RetryAfterSeconds int }

func (e *RateLimitedError) Error() string { return "alerts: rate limited" }

// DB is the pool surface the service needs (pgxpool.Pool satisfies it).
type DB interface {
	dbq.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service is the alerts and Telegram-link use-case layer.
type Service struct {
	db  DB
	q   *dbq.Queries
	log zerolog.Logger

	// Sender is nil until the owner creates the bot (D-9); BotUsername is optional.
	Sender      telegram.Sender
	BotUsername string
	// Now is overridable in tests.
	Now func() time.Time

	testMu   sync.Mutex
	lastTest time.Time

	linkMu     sync.Mutex // failed /start attempts in the current window (link.go)
	linkWindow time.Time
	linkFails  int
}

// New builds a Service.
func New(db DB, log zerolog.Logger) *Service {
	return &Service{db: db, q: dbq.New(db), log: log, Now: func() time.Time { return time.Now().UTC() }}
}

// Target identifies what an alert watches.
type Target struct {
	Type   string  `json:"type"`
	Symbol *string `json:"symbol,omitempty"`
	Code   *int64  `json:"code,omitempty"`
	Name   string  `json:"name,omitempty"`
}

// Alert is the API representation of one alert.
type Alert struct {
	ID              int64           `json:"id"`
	Target          Target          `json:"target"`
	Kind            string          `json:"kind"`
	Params          json.RawMessage `json:"params"`
	Status          string          `json:"status"`
	OneShot         bool            `json:"one_shot"`
	CooldownMinutes int32           `json:"cooldown_minutes"`
	ExpiresOn       *string         `json:"expires_on"`
	LastFiredAt     *string         `json:"last_fired_at"`
	CreatedAt       string          `json:"created_at"`
}

// Event is one row of the alert history.
type Event struct {
	ID               int64           `json:"id"`
	AlertID          int64           `json:"alert_id"`
	Kind             string          `json:"kind"`
	Target           Target          `json:"target"`
	FiredAt          string          `json:"fired_at"`
	Payload          json.RawMessage `json:"payload"`
	DeliveryStatus   string          `json:"delivery_status"`
	DeliveryAttempts int32           `json:"delivery_attempts"`
	DeliveredAt      *string         `json:"delivered_at"`
	LastError        *string         `json:"last_error"`
}

// CreateInput is the body of POST /alerts.
type CreateInput struct {
	Target struct {
		Type   string  `json:"type"`
		Symbol *string `json:"symbol"`
		Code   *int64  `json:"code"`
	} `json:"target"`
	Kind            string          `json:"kind"`
	Params          json.RawMessage `json:"params"`
	OneShot         *bool           `json:"one_shot"`
	CooldownMinutes *int64          `json:"cooldown_minutes"`
	ExpiresOn       *string         `json:"expires_on"`
}

// PatchInput is the body of PATCH /alerts/{id}: status and/or params.
type PatchInput struct {
	Status *string         `json:"status"`
	Params json.RawMessage `json:"params"`
}

type resolved struct {
	instrumentID int32
	mfCode       int32
	typ          string
}

func (s *Service) resolveTarget(ctx context.Context, in *CreateInput) (resolved, error) {
	switch in.Target.Type {
	case "stock":
		sym := *in.Target.Symbol
		r, err := s.q.ResolveInstrumentBySymbol(ctx, sym)
		if errors.Is(err, pgx.ErrNoRows) {
			r2, err2 := s.q.ResolveInstrumentByAlias(ctx, sym)
			if errors.Is(err2, pgx.ErrNoRows) {
				return resolved{}, &NotFoundTargetError{Type: "stock", Symbol: sym}
			}
			if err2 != nil {
				return resolved{}, err2
			}
			return resolved{instrumentID: r2.ID, typ: "stock"}, nil
		}
		if err != nil {
			return resolved{}, err
		}
		return resolved{instrumentID: r.ID, typ: "stock"}, nil
	default:
		_, err := s.q.ResolveMfScheme(ctx, int32(*in.Target.Code)) //nolint:gosec // range checked in validateCreate
		if errors.Is(err, pgx.ErrNoRows) {
			return resolved{}, &NotFoundTargetError{Type: "mf", Code: *in.Target.Code}
		}
		if err != nil {
			return resolved{}, err
		}
		return resolved{mfCode: int32(*in.Target.Code), typ: "mf"}, nil //nolint:gosec // range checked
	}
}

func (s *Service) today() time.Time {
	n := s.Now().In(ist)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

// validateCreate checks everything that does not need the database.
func (s *Service) validateCreate(in *CreateInput) (params []byte, expires pgtype.Date, cooldown int32, oneShot bool, errs []FieldError) {
	want := TargetFor(in.Kind)
	switch {
	case want == "":
		errs = append(errs, FieldError{Field: "kind", Message: "unknown alert kind"})
	case in.Target.Type != want:
		errs = append(errs, FieldError{Field: "target.type", Message: fmt.Sprintf("kind %s needs a %s target", in.Kind, want)})
	}
	switch in.Target.Type {
	case "stock":
		if in.Target.Symbol == nil || *in.Target.Symbol == "" || len(*in.Target.Symbol) > 40 || in.Target.Code != nil {
			errs = append(errs, FieldError{Field: "target.symbol", Message: "is required for a stock target (1 to 40 characters) and code must be absent"})
		}
	case "mf":
		if in.Target.Code == nil || *in.Target.Code < 1 || *in.Target.Code > 2147483647 || in.Target.Symbol != nil {
			errs = append(errs, FieldError{Field: "target.code", Message: "is required for a mf target (positive integer) and symbol must be absent"})
		}
	default:
		errs = append(errs, FieldError{Field: "target.type", Message: "must be stock or mf"})
	}
	if want != "" {
		p, pe := ValidateParams(in.Kind, in.Params)
		params = p
		errs = append(errs, pe...)
	}
	oneShot = true
	if in.OneShot != nil {
		oneShot = *in.OneShot
	}
	cooldown = DefaultCooldown
	if in.CooldownMinutes != nil {
		if *in.CooldownMinutes < 0 || *in.CooldownMinutes > 2147483647 {
			errs = append(errs, FieldError{Field: "cooldown_minutes", Message: "must be an integer >= 0"})
		} else {
			cooldown = int32(*in.CooldownMinutes) //nolint:gosec // range checked
		}
	}
	if in.ExpiresOn != nil {
		t, err := time.Parse("2006-01-02", *in.ExpiresOn)
		switch {
		case err != nil:
			errs = append(errs, FieldError{Field: "expires_on", Message: "must be a date YYYY-MM-DD"})
		case t.Before(s.today()):
			errs = append(errs, FieldError{Field: "expires_on", Message: "must not be in the past"})
		default:
			expires = pgtype.Date{Time: t, Valid: true}
		}
	}
	return params, expires, cooldown, oneShot, errs
}

// thresholdMet compares in decimal (shortest float representation, no binary noise at the
// boundary): above is value >= threshold, below is value <= threshold.
func thresholdMet(above bool, value, threshold float64) bool {
	v, t := decimal.NewFromFloat(value), decimal.NewFromFloat(threshold)
	if above {
		return v.GreaterThanOrEqual(t)
	}
	return v.LessThanOrEqual(t)
}

// checkThreshold is the creation-time THRESHOLD_ALREADY_MET rule (ALR-01, D-D): price_above/below
// against the last imported bar close, nav_above/below against the latest imported NAV. With no
// bar or NAV yet nothing can be said, so the alert is accepted.
func (s *Service) checkThreshold(ctx context.Context, q *dbq.Queries, kind string, r resolved, params []byte) error {
	var p struct {
		Price float64 `json:"price"`
		NAV   float64 `json:"nav"`
	}
	switch kind {
	case "price_above", "price_below":
		if err := json.Unmarshal(params, &p); err != nil {
			return err
		}
		bar, err := q.LastStockBar(ctx, r.instrumentID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if thresholdMet(kind == "price_above", bar.Close, p.Price) {
			return &ThresholdMetError{Kind: kind, Threshold: p.Price, Value: bar.Close, AsOf: bar.TradeDate.Time.Format("2006-01-02")}
		}
	case "nav_above", "nav_below":
		if err := json.Unmarshal(params, &p); err != nil {
			return err
		}
		nav, err := q.LastMfNav(ctx, r.mfCode)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if thresholdMet(kind == "nav_above", nav.Nav, p.NAV) {
			return &ThresholdMetError{Kind: kind, Threshold: p.NAV, Value: nav.Nav, AsOf: nav.NavDate.Time.Format("2006-01-02"), IsNAV: true}
		}
	}
	return nil
}

// Create validates and stores a new active alert.
func (s *Service) Create(ctx context.Context, in CreateInput) (Alert, error) {
	params, expires, cooldown, oneShot, errs := s.validateCreate(&in)
	if len(errs) > 0 {
		return Alert{}, &ValidationError{Fields: errs}
	}
	r, err := s.resolveTarget(ctx, &in)
	if err != nil {
		return Alert{}, err
	}
	if err := s.checkThreshold(ctx, s.q, in.Kind, r, params); err != nil {
		return Alert{}, err
	}
	var id int64
	err = s.inTx(ctx, func(q *dbq.Queries) error {
		if err := q.LockAlertLimit(ctx); err != nil {
			return err
		}
		n, err := q.CountActiveAlerts(ctx)
		if err != nil {
			return err
		}
		if n >= MaxActive {
			return ErrLimitReached
		}
		arg := dbq.InsertAlertParams{
			TargetType: r.typ, Kind: in.Kind, Params: params, OneShot: oneShot, CooldownMinutes: cooldown, ExpiresOn: expires,
		}
		if r.typ == "stock" {
			arg.InstrumentID = pgtype.Int4{Int32: r.instrumentID, Valid: true}
		} else {
			arg.MfSchemeCode = pgtype.Int4{Int32: r.mfCode, Valid: true}
		}
		id, err = q.InsertAlert(ctx, arg)
		return err
	})
	if err != nil {
		return Alert{}, err
	}
	return s.Get(ctx, id)
}

// Get returns one alert.
func (s *Service) Get(ctx context.Context, id int64) (Alert, error) {
	row, err := s.q.GetAlertView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Alert{}, ErrNotFound
	}
	if err != nil {
		return Alert{}, err
	}
	return toAlert(row.ID, row.TargetType, row.Kind, row.Params, row.Status, row.OneShot, row.CooldownMinutes,
		row.ExpiresOn, row.LastFiredAt, row.CreatedAt, row.Symbol, row.TargetName, row.MfCode), nil
}

func toAlert(id int64, typ, kind string, params []byte, status string, oneShot bool, cooldown int32,
	expires pgtype.Date, fired, created pgtype.Timestamptz, symbol pgtype.Text, name string, mf pgtype.Int4) Alert {
	a := Alert{
		ID: id, Target: target(typ, symbol, name, mf), Kind: kind, Params: json.RawMessage(params), Status: status,
		OneShot: oneShot, CooldownMinutes: cooldown, CreatedAt: created.Time.UTC().Format(time.RFC3339),
	}
	if len(a.Params) == 0 {
		a.Params = json.RawMessage(`{}`)
	}
	if expires.Valid {
		d := expires.Time.Format("2006-01-02")
		a.ExpiresOn = &d
	}
	if fired.Valid {
		f := fired.Time.UTC().Format(time.RFC3339)
		a.LastFiredAt = &f
	}
	return a
}

func target(typ string, symbol pgtype.Text, name string, mf pgtype.Int4) Target {
	t := Target{Type: typ, Name: name}
	if symbol.Valid {
		s := symbol.String
		t.Symbol = &s
	}
	if mf.Valid {
		c := int64(mf.Int32)
		t.Code = &c
	}
	return t
}

// Page is a keyset page (newest first).
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func decodeBefore(cursor string) (pgtype.Int8, error) {
	if cursor == "" {
		return pgtype.Int8{}, nil
	}
	var k []int64
	if err := pagination.Decode(cursor, &k); err != nil || len(k) != 1 || k[0] < 1 {
		return pgtype.Int8{}, ErrInvalidCursor
	}
	return pgtype.Int8{Int64: k[0], Valid: true}, nil
}

func nextCursor(lastID int64) (*string, error) {
	c, err := pagination.Encode(lastID)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// List returns alerts, newest first. status "" means all.
func (s *Service) List(ctx context.Context, status string, p pagination.Params) (Page[Alert], error) {
	if status != "" && status != StatusActive && status != StatusPaused && status != StatusFired && status != StatusExpired {
		return Page[Alert]{}, &ValidationError{Fields: []FieldError{{Field: "status", Message: "must be active, paused, fired or expired"}}}
	}
	before, err := decodeBefore(p.Cursor)
	if err != nil {
		return Page[Alert]{}, err
	}
	arg := dbq.ListAlertViewsParams{BeforeID: before, RowLimit: int32(p.Limit + 1)} //nolint:gosec // limit <= 200
	if status != "" {
		arg.Status = pgtype.Text{String: status, Valid: true}
	}
	rows, err := s.q.ListAlertViews(ctx, arg)
	if err != nil {
		return Page[Alert]{}, err
	}
	out := Page[Alert]{Items: []Alert{}}
	for i, r := range rows {
		if i == p.Limit {
			if out.NextCursor, err = nextCursor(rows[i-1].ID); err != nil {
				return Page[Alert]{}, err
			}
			break
		}
		out.Items = append(out.Items, toAlert(r.ID, r.TargetType, r.Kind, r.Params, r.Status, r.OneShot, r.CooldownMinutes,
			r.ExpiresOn, r.LastFiredAt, r.CreatedAt, r.Symbol, r.TargetName, r.MfCode))
	}
	return out, nil
}

// Events returns the alert history, newest first.
func (s *Service) Events(ctx context.Context, p pagination.Params) (Page[Event], error) {
	before, err := decodeBefore(p.Cursor)
	if err != nil {
		return Page[Event]{}, err
	}
	rows, err := s.q.ListAlertEvents(ctx, dbq.ListAlertEventsParams{BeforeID: before, RowLimit: int32(p.Limit + 1)}) //nolint:gosec // limit <= 200
	if err != nil {
		return Page[Event]{}, err
	}
	out := Page[Event]{Items: []Event{}}
	for i, r := range rows {
		if i == p.Limit {
			if out.NextCursor, err = nextCursor(rows[i-1].ID); err != nil {
				return Page[Event]{}, err
			}
			break
		}
		e := Event{
			ID: r.ID, AlertID: r.AlertID, Kind: r.Kind, Target: target(r.TargetType, r.Symbol, r.TargetName, r.MfCode),
			FiredAt: r.FiredAt.Time.UTC().Format(time.RFC3339), Payload: json.RawMessage(r.Payload),
			DeliveryStatus: r.DeliveryStatus, DeliveryAttempts: r.DeliveryAttempts,
		}
		if len(e.Payload) == 0 {
			e.Payload = json.RawMessage(`{}`)
		}
		if r.DeliveredAt.Valid {
			d := r.DeliveredAt.Time.UTC().Format(time.RFC3339)
			e.DeliveredAt = &d
		}
		if r.LastError.Valid {
			le := r.LastError.String
			e.LastError = &le
		}
		out.Items = append(out.Items, e)
	}
	return out, nil
}

// Patch pauses/resumes an alert and/or replaces its params. Fired and expired alerts are final.
func (s *Service) Patch(ctx context.Context, id int64, in PatchInput) (Alert, error) {
	var errs []FieldError
	if in.Status == nil && len(in.Params) == 0 {
		errs = append(errs, FieldError{Field: "status", Message: "send status and/or params"})
	}
	if in.Status != nil && *in.Status != StatusActive && *in.Status != StatusPaused {
		errs = append(errs, FieldError{Field: "status", Message: "must be active or paused"})
	}
	if len(errs) > 0 {
		return Alert{}, &ValidationError{Fields: errs}
	}
	err := s.inTx(ctx, func(q *dbq.Queries) error {
		if err := q.LockAlertLimit(ctx); err != nil {
			return err
		}
		cur, err := q.GetAlertForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if cur.Status != StatusActive && cur.Status != StatusPaused {
			return ErrNotEditable
		}
		if len(in.Params) > 0 {
			params, pe := ValidateParams(cur.Kind, in.Params)
			if len(pe) > 0 {
				return &ValidationError{Fields: pe}
			}
			r := resolved{instrumentID: cur.InstrumentID.Int32, mfCode: cur.MfSchemeCode.Int32}
			if err := s.checkThreshold(ctx, q, cur.Kind, r, params); err != nil {
				return err
			}
			if err := q.UpdateAlertParams(ctx, dbq.UpdateAlertParamsParams{ID: id, Params: params}); err != nil {
				return err
			}
		}
		if in.Status != nil && *in.Status != cur.Status {
			if *in.Status == StatusActive {
				n, err := q.CountActiveAlerts(ctx)
				if err != nil {
					return err
				}
				if n >= MaxActive {
					return ErrLimitReached
				}
			}
			return q.UpdateAlertStatus(ctx, dbq.UpdateAlertStatusParams{ID: id, Status: *in.Status})
		}
		return nil
	})
	if err != nil {
		return Alert{}, err
	}
	return s.Get(ctx, id)
}

// Delete removes an alert and, by cascade, its events.
func (s *Service) Delete(ctx context.Context, id int64) error {
	n, err := s.q.DeleteAlert(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Service) inTx(ctx context.Context, fn func(q *dbq.Queries) error) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(s.q.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
