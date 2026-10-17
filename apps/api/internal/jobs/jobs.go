// Package jobs queues on-demand refresh jobs and signals worker-http (docs/03 section 7,
// docs/04 sections 3.12 and 4; manual price mode, decisions D-1/D-2).
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/dbq"
)

// Job kinds (refresh_job.kind).
const (
	KindStockRefresh  = "stock_refresh"
	KindStockBackfill = "stock_backfill"
	KindMFRefresh     = "mf_refresh"
	KindPostImport    = "post_import"
)

// ExpectedWaitSeconds is the hint returned with a new job (docs/03 section 7).
const ExpectedWaitSeconds = 90

var (
	// ErrPriceModeManual: stock_refresh and stock_backfill are not available without a broker.
	ErrPriceModeManual = errors.New("jobs: price mode is manual")
	// ErrNotFound: unknown job id.
	ErrNotFound = errors.New("jobs: not found")
)

// RateLimitedError carries the seconds until the owner may retry (429).
type RateLimitedError struct{ RetryAfterSeconds int }

func (e *RateLimitedError) Error() string { return "jobs: rate limited" }

// Job is one refresh_job row.
type Job struct {
	ID          int64
	Kind        string
	Target      string
	Status      string
	RequestedAt time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
	Error       *string
	Result      json.RawMessage // nil when the worker wrote none
}

// Signaler delivers the "run job N" signal to worker-http.
type Signaler interface {
	Trigger(ctx context.Context, jobID int64) error
}

// Config holds the tunables (REFRESH_COOLDOWN_MIN, REFRESH_GLOBAL_PER_HOUR).
type Config struct {
	Cooldown   time.Duration
	GlobalHour int
}

// Service creates and reads refresh jobs.
type Service struct {
	q   *dbq.Queries
	sig Signaler
	cfg Config
	log zerolog.Logger
	// Now is the clock (tests replace it).
	Now func() time.Time
	wg  sync.WaitGroup
	// signalTimeout bounds one worker signal.
	signalTimeout time.Duration
}

// New builds a Service over a pgx pool. sig may be nil (no signal is sent).
func New(db dbq.DBTX, sig Signaler, cfg Config, log zerolog.Logger) *Service {
	return &Service{q: dbq.New(db), sig: sig, cfg: cfg, log: log, Now: time.Now, signalTimeout: 15 * time.Second}
}

// Wait blocks until in-flight worker signals finish (graceful shutdown, tests).
func (s *Service) Wait() { s.wg.Wait() }

// Get returns one job.
func (s *Service) Get(ctx context.Context, id int64) (Job, error) {
	row, err := s.q.GetRefreshJob(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, err
	}
	return toJob(row), nil
}

// Enqueue queues an on-demand job. created is false when an active job for the same
// (kind, target) already exists and is returned instead (docs/03 section 7).
func (s *Service) Enqueue(ctx context.Context, kind, target string) (Job, bool, error) {
	switch kind {
	case KindStockRefresh, KindStockBackfill:
		return Job{}, false, ErrPriceModeManual
	case KindMFRefresh:
	default:
		return Job{}, false, fmt.Errorf("jobs: kind %q is not enqueued on demand", kind)
	}
	active, err := s.q.GetActiveRefreshJob(ctx, dbq.GetActiveRefreshJobParams{Kind: kind, Target: target})
	if err == nil {
		return toJob(active), false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, err
	}
	now := s.Now()
	last, err := s.q.LastFinishedRefreshJobAt(ctx, dbq.LastFinishedRefreshJobAtParams{Kind: kind, Target: target})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, err
	}
	if err == nil && last.Valid {
		if left := last.Time.Add(s.cfg.Cooldown).Sub(now); left > 0 {
			return Job{}, false, &RateLimitedError{RetryAfterSeconds: ceilSeconds(left)}
		}
	}
	times, err := s.q.ListRefreshJobTimesSince(ctx, pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true})
	if err != nil {
		return Job{}, false, err
	}
	if len(times) >= s.cfg.GlobalHour {
		// A slot frees when the (len-limit+1)-th oldest request ages out of the one-hour window.
		oldest := times[len(times)-s.cfg.GlobalHour].Time
		return Job{}, false, &RateLimitedError{RetryAfterSeconds: ceilSeconds(oldest.Add(time.Hour).Sub(now))}
	}
	return s.insert(ctx, kind, target, nil)
}

// PostImportResult is the initial refresh_job.result of a post_import job (docs/04 3.12).
type PostImportResult struct {
	SymbolsTotal int      `json:"symbols_total"`
	SymbolsDone  int      `json:"symbols_done"`
	Remaining    []string `json:"remaining"`
}

// EnqueuePostImport queues post_import for target `batch:<id>` with the ordered symbol list in
// result.remaining (docs/04 3.12). Event-driven, so no cooldown or global limit applies. An
// active job for the same target is returned instead of a second one (created=false).
func (s *Service) EnqueuePostImport(ctx context.Context, batchID int64, symbols []string) (Job, bool, error) {
	return s.EnqueuePostImportTarget(ctx, "batch:"+strconv.FormatInt(batchID, 10), symbols)
}

// EnqueuePostImportTarget is EnqueuePostImport for another target form such as `action:<id>` (D03-A5).
func (s *Service) EnqueuePostImportTarget(ctx context.Context, target string, symbols []string) (Job, bool, error) {
	if symbols == nil {
		symbols = []string{}
	}
	res, err := json.Marshal(PostImportResult{SymbolsTotal: len(symbols), Remaining: symbols})
	if err != nil {
		return Job{}, false, err
	}
	return s.insert(ctx, KindPostImport, target, res)
}

// MFSchemeExists reports whether an AMFI scheme code is known.
func (s *Service) MFSchemeExists(ctx context.Context, code int32) (bool, error) {
	return s.q.MfSchemeExists(ctx, code)
}

func (s *Service) insert(ctx context.Context, kind, target string, result []byte) (Job, bool, error) {
	row, err := s.q.InsertRefreshJob(ctx, dbq.InsertRefreshJobParams{Kind: kind, Target: target, Result: result})
	if errors.Is(err, pgx.ErrNoRows) { // lost the race: the unique active-job index kept one row (API-06)
		active, aerr := s.q.GetActiveRefreshJob(ctx, dbq.GetActiveRefreshJobParams{Kind: kind, Target: target})
		if aerr != nil {
			return Job{}, false, aerr
		}
		return toJob(active), false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	j := toJob(row)
	s.fire(j.ID)
	return j, true, nil
}

// fire signals worker-http without blocking the request. A failure only logs: the row stays
// queued and process_queued_jobs picks it up (docs/03 section 7, docs/04 3.13).
func (s *Service) fire(id int64) {
	if s.sig == nil {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), s.signalTimeout)
		defer cancel()
		if err := s.sig.Trigger(ctx, id); err != nil {
			s.log.Warn().Err(err).Int64("job_id", id).Msg("worker signal failed; job stays queued")
		}
	}()
}

func ceilSeconds(d time.Duration) int {
	n := int((d + time.Second - 1) / time.Second)
	if n < 1 {
		return 1
	}
	return n
}

func toJob(r dbq.RefreshJob) Job {
	j := Job{ID: r.ID, Kind: r.Kind, Target: r.Target, Status: r.Status, RequestedAt: r.RequestedAt.Time}
	if r.StartedAt.Valid {
		t := r.StartedAt.Time
		j.StartedAt = &t
	}
	if r.FinishedAt.Valid {
		t := r.FinishedAt.Time
		j.FinishedAt = &t
	}
	if r.Error.Valid {
		e := r.Error.String
		j.Error = &e
	}
	if len(r.Result) > 0 {
		j.Result = json.RawMessage(r.Result)
	}
	return j
}
