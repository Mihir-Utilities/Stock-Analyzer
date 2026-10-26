// Package actions implements PATCH /stocks/{symbol}/actions/{id} (B07): the owner confirms or
// rejects a detected split/bonus candidate (docs/01 3.7, docs/03 section 14). Nothing is applied
// until the owner confirms (CLAUDE.md 7); the history re-adjustment itself is the worker's
// post_import job (D03-A5), queued after the commit.
package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/importers"
	"github.com/india-analyzer/api/internal/jobs"
)

// DB is the pool surface the service needs (pgxpool.Pool satisfies it).
type DB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Enqueuer queues post_import for target `action:<id>` (B09 EnqueuePostImportTarget, D03-A5).
type Enqueuer interface {
	EnqueuePostImportTarget(ctx context.Context, target string, symbols []string) (jobs.Job, bool, error)
}

// Service owns the confirm/reject state machine.
type Service struct {
	db  DB
	enq Enqueuer
	log zerolog.Logger
	// Now is the clock (tests replace it); ex-dates are compared as IST dates (ACT-10).
	Now func() time.Time
}

// New builds the service; enq may be nil (no job is queued).
func New(db DB, enq Enqueuer, log zerolog.Logger) *Service {
	return &Service{db: db, enq: enq, log: log, Now: time.Now}
}

// NotFoundError is a 404 (unknown symbol, unknown id, or an id of another stock: no IDOR).
type NotFoundError struct{ What string }

func (e *NotFoundError) Error() string { return e.What + " not found" }

// ConflictError is a 409.
type ConflictError struct{ Message string }

func (e *ConflictError) Error() string { return e.Message }

// Patch is the request body. ActionType and the ratios are optional for reject and required to
// confirm a detected candidate (the owner chooses split or bonus and the final numbers, docs/05 8.2).
type Patch struct {
	Status     string
	ActionType string
	RatioNum   string
	RatioDen   string
}

// Warning is a non-blocking notice.
type Warning struct {
	Field   string `json:"field,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Result is the response data.
type Result struct {
	ID              int64     `json:"id"`
	Symbol          string    `json:"symbol"`
	ExDate          string    `json:"ex_date"`
	ActionType      string    `json:"action_type"`
	Status          string    `json:"status"`
	RatioNum        *string   `json:"ratio_num"`
	RatioDen        *string   `json:"ratio_den"`
	Multiplier      *string   `json:"multiplier"`
	FutureExDate    bool      `json:"future_ex_date"`
	Changed         bool      `json:"changed"`
	Warnings        []Warning `json:"warnings"`
	PostImportJobID *int64    `json:"post_import_job_id"`
}

// Tolerance is the 3% band of docs/05 8.2 between the owner's multiplier and the detected 1/r.
var Tolerance = decimal.RequireFromString("0.03")

// ExtremeHigh and ExtremeLow bound a plausible multiplier; outside them RATIO_EXTREME is raised
// (B07R-2, interim thresholds; the ratio is still accepted).
var (
	ExtremeHigh = decimal.NewFromInt(100)
	ExtremeLow  = decimal.RequireFromString("0.01")
)

// Multiplier is the quantity multiplier of docs/05 8.2: split num/den, bonus (num+den)/den.
func Multiplier(actionType string, num, den decimal.Decimal) (decimal.Decimal, bool) {
	if !num.IsPositive() || !den.IsPositive() {
		return decimal.Zero, false
	}
	switch actionType {
	case "split":
		return num.Div(den), true
	case "bonus":
		return num.Add(den).Div(den), true
	}
	return decimal.Zero, false
}

// DisagreesWithDetected reports whether the owner's multiplier differs from the detector's
// implied multiplier 1/r (r = ratio_num/ratio_den of the detected row) by more than 3% (ACT-06).
func DisagreesWithDetected(mult, detNum, detDen decimal.Decimal) bool {
	if !detNum.IsPositive() || !detDen.IsPositive() {
		return false
	}
	implied := detDen.Div(detNum)
	return mult.Sub(implied).Abs().Div(implied).GreaterThan(Tolerance)
}

type row struct {
	instID     int32
	symbol     string
	exDate     time.Time
	actionType string
	status     string
	num, den   *decimal.Decimal
	source     string
	purpose    string
}

var ist = time.FixedZone("IST", 5*3600+1800)

// Patch confirms or rejects an action. It is idempotent: repeating the same request returns the
// same state (Changed=false); a rejected date can never be confirmed (sticky, ACT-04) and a
// confirmed action cannot be rejected. A row lock serialises concurrent requests, so a double
// confirm cannot adjust twice.
func (s *Service) Patch(ctx context.Context, symbol string, id int64, in Patch) (*Result, error) {
	status := strings.ToLower(strings.TrimSpace(in.Status))
	if status != "confirmed" && status != "rejected" {
		return nil, validation("status", "status must be confirmed or rejected")
	}
	typ := strings.ToLower(strings.TrimSpace(in.ActionType))
	if status == "rejected" && (typ != "" || strings.TrimSpace(in.RatioNum) != "" || strings.TrimSpace(in.RatioDen) != "") {
		return nil, validation("status", "action_type and ratios apply only when confirming")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialise with manual/CSV inserts for the same (instrument, ex-date) before any row lock, so
	// the duplicate check below cannot be raced (B07R-1). The ex-date of a row never changes.
	var lockInst int32
	var lockDay time.Time
	err = tx.QueryRow(ctx, `SELECT a.instrument_id, a.ex_date FROM corporate_action a JOIN instrument i ON i.id = a.instrument_id
		WHERE a.id = $1 AND i.symbol = $2`, id, strings.ToUpper(strings.TrimSpace(symbol))).Scan(&lockInst, &lockDay)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &NotFoundError{What: "corporate action"}
	}
	if err != nil {
		return nil, err
	}
	if err := importers.LockActionDate(ctx, tx, lockInst, lockDay); err != nil {
		return nil, err
	}

	var r row
	var n, d *string
	err = tx.QueryRow(ctx, `SELECT a.instrument_id, i.symbol, a.ex_date, a.action_type, a.status, a.ratio_num::text, a.ratio_den::text,
			a.source, a.purpose_text
		FROM corporate_action a JOIN instrument i ON i.id = a.instrument_id
		WHERE a.id = $1 AND i.symbol = $2 FOR UPDATE OF a`, id, strings.ToUpper(strings.TrimSpace(symbol))).
		Scan(&r.instID, &r.symbol, &r.exDate, &r.actionType, &r.status, &n, &d, &r.source, &r.purpose)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &NotFoundError{What: "corporate action"}
	}
	if err != nil {
		return nil, err
	}
	if r.num, err = parseDec(n); err != nil {
		return nil, err
	}
	if r.den, err = parseDec(d); err != nil {
		return nil, err
	}

	res := &Result{ID: id, Symbol: r.symbol, ExDate: r.exDate.Format(time.DateOnly), Warnings: []Warning{}}
	if status == "rejected" {
		err = s.reject(ctx, tx, id, &r, res)
	} else {
		err = s.confirm(ctx, tx, id, &r, typ, in, res)
	}
	if err != nil {
		return nil, err
	}
	if status == "confirmed" {
		if err := s.skippedSrcAdjusted(ctx, tx, &r, res); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// A repeat after a failed queueing retries the enqueue; an active job for the target is reused.
	s.queue(ctx, id, r.symbol, res)
	return res, nil
}

func (s *Service) reject(ctx context.Context, tx pgx.Tx, id int64, r *row, res *Result) error {
	switch r.status {
	case "rejected":
	case "detected":
		if _, err := tx.Exec(ctx, `UPDATE corporate_action SET status = 'rejected' WHERE id = $1`, id); err != nil {
			return err
		}
		res.Changed = true
	default:
		return &ConflictError{Message: "Only a detected action can be rejected; this action is " + r.status}
	}
	fill(res, r, "rejected")
	return nil
}

func (s *Service) confirm(ctx context.Context, tx pgx.Tx, id int64, r *row, typ string, in Patch, res *Result) error {
	if r.status == "rejected" {
		return &ConflictError{Message: "This candidate was rejected and a rejected date stays rejected. Add the action manually if it is real"}
	}
	plain := typ == "" && strings.TrimSpace(in.RatioNum) == "" && strings.TrimSpace(in.RatioDen) == ""
	if r.status == "confirmed" && plain {
		fill(res, r, "confirmed")
		s.flagFuture(r, res)
		return nil
	}
	if r.status == "confirmed" && r.source != "detected" {
		return &ConflictError{Message: "This action was entered by you and is already confirmed; re-enter it to change it"}
	}
	wasDetected := r.status == "detected"
	// The importers' validator is the single validator of every owner-entered action.
	exDate := r.exDate.Format(time.DateOnly)
	norm, errs, _ := importers.ValidateAction(importers.ActionInput{ExDate: exDate, Type: typ, RatioNum: in.RatioNum, RatioDen: in.RatioDen, Purpose: r.purpose})
	if typ != "split" && typ != "bonus" && !hasField(errs, "type") {
		errs = append(errs, importers.FieldIssue{Field: "type", Code: "TYPE_INVALID", Message: "choose split or bonus to confirm"})
	}
	if len(errs) > 0 {
		return &importers.ValidationError{Fields: errs}
	}
	num, _ := decimal.NewFromString(*norm.RatioNum)
	den, _ := decimal.NewFromString(*norm.RatioDen)
	mult, ok := Multiplier(typ, num, den)
	if !ok {
		return validation("ratio_num", "ratios must be greater than 0")
	}
	if !wasDetected { // already confirmed from a candidate: only the same numbers are a repeat
		if r.actionType == typ && r.num != nil && r.den != nil && r.num.Equal(num) && r.den.Equal(den) {
			fill(res, r, "confirmed")
			s.flagFuture(r, res)
			return nil
		}
		return &ConflictError{Message: "This action is already confirmed with different numbers; the history was adjusted with them"}
	}
	// Never adjust twice: another confirmed split/bonus on the same ex-date (B06b-12) blocks it.
	var twins int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM corporate_action WHERE instrument_id = $1 AND ex_date = $2 AND id <> $3
		AND status = 'confirmed' AND action_type IN ('split','bonus')`, r.instID, r.exDate, id).Scan(&twins); err != nil {
		return err
	}
	if twins > 0 {
		return &ConflictError{Message: fmt.Sprintf("A confirmed split or bonus already exists for %s on %s; confirming this candidate too would adjust the history twice. Reject this candidate instead", r.symbol, exDate)}
	}
	if _, err := tx.Exec(ctx, `UPDATE corporate_action SET status = 'confirmed', action_type = $2, ratio_num = $3::numeric, ratio_den = $4::numeric
		WHERE id = $1`, id, typ, *norm.RatioNum, *norm.RatioDen); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return &ConflictError{Message: "An action of that type already exists for this ex-date"}
		}
		return err
	}
	if r.num != nil && r.den != nil && DisagreesWithDetected(mult, *r.num, *r.den) {
		res.Warnings = append(res.Warnings, Warning{Field: "ratio_num", Code: "RATIO_DISAGREES_WITH_DETECTED",
			Message: "The multiplier " + mult.StringFixed(4) + " differs by more than 3% from the one implied by the detected price change (" +
				r.den.Div(*r.num).StringFixed(4) + "). Check the ratio"})
	}
	if mult.GreaterThan(ExtremeHigh) || mult.LessThan(ExtremeLow) {
		res.Warnings = append(res.Warnings, Warning{Field: "ratio_num", Code: "RATIO_EXTREME",
			Message: "The multiplier " + mult.StringFixed(4) + " is outside " + ExtremeLow.String() + " to " + ExtremeHigh.String() + ". Check the ratio"})
	}
	r.actionType, r.num, r.den = typ, &num, &den
	res.Changed = true
	fill(res, r, "confirmed")
	s.flagFuture(r, res)
	return nil
}

// skippedSrcAdjusted adds ADJUSTMENT_SKIPPED_SRC_ADJUSTED when a bar at the ex-date or the bar
// before it was imported as already adjusted: the worker never multiplies those bars (D-K), so the
// confirmation is a no-op on prices there (B07R-3, interim; same bars as ADJUSTMENT_CONFLICT).
func (s *Service) skippedSrcAdjusted(ctx context.Context, tx pgx.Tx, r *row, res *Result) error {
	var skipped bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM price_daily p WHERE p.instrument_id = $1 AND p.src_adjusted
		AND p.trade_date IN ($2::date, (SELECT max(q.trade_date) FROM price_daily q WHERE q.instrument_id = $1 AND q.trade_date < $2::date)))`,
		r.instID, r.exDate).Scan(&skipped); err != nil {
		return err
	}
	if skipped {
		res.Warnings = append(res.Warnings, Warning{Code: "ADJUSTMENT_SKIPPED_SRC_ADJUSTED",
			Message: "Prices around " + r.exDate.Format(time.DateOnly) + " were imported as already adjusted, so confirming does not change them. Check which file is raw"})
	}
	return nil
}

func hasField(errs []importers.FieldIssue, f string) bool {
	for _, e := range errs {
		if e.Field == f {
			return true
		}
	}
	return false
}

// flagFuture marks an ex-date after today (IST): stored and confirmed, applied by the worker only
// once ex_date <= as_of (ACT-10).
func (s *Service) flagFuture(r *row, res *Result) {
	res.FutureExDate = r.exDate.Format(time.DateOnly) > s.Now().In(ist).Format(time.DateOnly)
}

func fill(res *Result, r *row, status string) {
	res.ActionType, res.Status = r.actionType, status
	if r.num != nil {
		v := r.num.StringFixed(4)
		res.RatioNum = &v
	}
	if r.den != nil {
		v := r.den.StringFixed(4)
		res.RatioDen = &v
	}
	if r.num != nil && r.den != nil && status == "confirmed" {
		if m, ok := Multiplier(r.actionType, *r.num, *r.den); ok {
			v := m.StringFixed(4)
			res.Multiplier = &v
		}
	}
}

// queue enqueues the re-adjust and analysis chain (worker post_import re-adjusts, then analyses).
// A failure never fails the owner's decision: it adds a warning and a repeat retries.
func (s *Service) queue(ctx context.Context, id int64, symbol string, res *Result) {
	if s.enq == nil {
		return
	}
	job, _, err := s.enq.EnqueuePostImportTarget(ctx, fmt.Sprintf("action:%d", id), []string{symbol})
	if err != nil {
		s.log.Warn().Err(err).Int64("action_id", id).Msg("post_import could not be queued")
		res.Warnings = append(res.Warnings, Warning{Code: "POST_IMPORT_NOT_QUEUED",
			Message: "The decision is saved but the recompute could not be queued; repeat the request to retry"})
		return
	}
	res.PostImportJobID = &job.ID
}

func parseDec(s *string) (*decimal.Decimal, error) {
	if s == nil {
		return nil, nil
	}
	d, err := decimal.NewFromString(*s)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func validation(field, msg string) error {
	return &importers.ValidationError{Fields: []importers.FieldIssue{{Field: field, Message: msg}}}
}
