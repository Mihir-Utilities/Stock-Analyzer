package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/jobs"
)

// JobService is the refresh-job use-case surface (docs/03 section 7); *jobs.Service implements it.
type JobService interface {
	Get(ctx context.Context, id int64) (jobs.Job, error)
	Enqueue(ctx context.Context, kind, target string) (jobs.Job, bool, error)
	MFSchemeExists(ctx context.Context, code int32) (bool, error)
}

// ErrPriceModeManual is the 422 for stock_refresh and stock_backfill in manual price mode (BRK-12).
func ErrPriceModeManual() *AppError {
	return NewError(http.StatusUnprocessableEntity, "PRICE_MODE_MANUAL",
		"Prices are imported manually; refresh is not available. Use the prices import.", nil)
}

func jobHandler(d Deps, kind handlerKind) http.Handler {
	if d.Jobs == nil {
		return Adapt(func(http.ResponseWriter, *http.Request) error {
			return NewError(http.StatusNotImplemented, CodeNotImplemented, "Not implemented yet", nil)
		})
	}
	switch kind {
	case kindJobStockRefresh:
		return Adapt(func(http.ResponseWriter, *http.Request) error { return ErrPriceModeManual() })
	case kindJobMFRefresh:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return mfRefresh(d.Jobs, w, r) })
	default:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return getJob(d.Jobs, w, r) })
	}
}

func mfRefresh(svc JobService, w http.ResponseWriter, r *http.Request) error {
	raw := chi.URLParam(r, "code")
	n, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || n < 1 {
		return ErrValidation(FieldError{Field: "code", Message: "must be a positive integer scheme code"})
	}
	ok, err := svc.MFSchemeExists(r.Context(), int32(n))
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound("Scheme not found", map[string]any{"code": n})
	}
	job, created, err := svc.Enqueue(r.Context(), jobs.KindMFRefresh, strconv.FormatInt(n, 10))
	var rl *jobs.RateLimitedError
	switch {
	case errors.As(err, &rl):
		return ErrRateLimited(rl.RetryAfterSeconds)
	case err != nil:
		return err
	}
	if !created { // an active job exists: return it (docs/03 section 7)
		WriteData(w, http.StatusOK, jobView(job))
		return nil
	}
	WriteData(w, http.StatusAccepted, map[string]any{
		"job_id": job.ID, "status": job.Status, "expected_wait_seconds": jobs.ExpectedWaitSeconds,
	})
	return nil
}

func getJob(svc JobService, w http.ResponseWriter, r *http.Request) error {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		return ErrValidation(FieldError{Field: "id", Message: "must be a positive integer"})
	}
	job, err := svc.Get(r.Context(), id)
	if errors.Is(err, jobs.ErrNotFound) {
		return ErrNotFound("Job not found", map[string]any{"id": id})
	}
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, jobView(job))
	return nil
}

func jobView(j jobs.Job) map[string]any {
	var result any // JSON null when the worker has written nothing
	if len(j.Result) > 0 {
		result = j.Result
	}
	ts := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	var errText any
	if j.Error != nil {
		errText = *j.Error
	}
	return map[string]any{
		"id": j.ID, "kind": j.Kind, "target": j.Target, "status": j.Status,
		"requested_at": j.RequestedAt.UTC().Format(time.RFC3339),
		"started_at":   ts(j.StartedAt), "finished_at": ts(j.FinishedAt),
		"error": errText, "result": result,
	}
}
