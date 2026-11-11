package main

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/jobs"
	"github.com/india-analyzer/api/internal/mf"
	"github.com/india-analyzer/api/internal/mfhold"
)

// mfBackfiller adapts the jobs service to mf.Backfiller (docs/03 section 10: a scheme without NAV
// rows enqueues mf_refresh). The API only records the job; the worker fetches the data.
type mfBackfiller struct{ jobs *jobs.Service }

func (b mfBackfiller) EnqueueMFRefresh(ctx context.Context, code int32) (mf.Backfill, error) {
	job, _, err := b.jobs.Enqueue(ctx, jobs.KindMFRefresh, strconv.FormatInt(int64(code), 10))
	if err != nil {
		// Cooldown / hourly limit: the refresh is not queued by this request.
		return mf.Backfill{Status: "none"}, err
	}
	status := "queued"
	if job.Status == "running" {
		status = "running"
	}
	id := job.ID
	return mf.Backfill{Status: status, JobID: &id}, nil
}

// mfRefresher adapts the jobs service to mfhold.Refresher and importers.MFRefresher: a scheme that has
// transactions but no NAV rows enqueues mf_refresh (the API only records the job).
type mfRefresher struct{ jobs *jobs.Service }

func (r mfRefresher) EnqueueMFRefresh(ctx context.Context, code int32) error {
	_, _, err := r.jobs.Enqueue(ctx, jobs.KindMFRefresh, strconv.FormatInt(int64(code), 10))
	return err
}

// mfHoldingsService wires the mutual fund ledger (B15).
func mfHoldingsService(pool *pgxpool.Pool, j *jobs.Service) *mfhold.Service {
	s := mfhold.New(pool)
	s.Refresh = mfRefresher{jobs: j}
	return s
}

func mfService(db dbq.DBTX, j *jobs.Service) *mf.Service {
	return mf.New(db, mfBackfiller{jobs: j})
}
