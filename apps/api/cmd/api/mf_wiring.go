package main

import (
	"context"
	"strconv"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/jobs"
	"github.com/india-analyzer/api/internal/mf"
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

func mfService(db dbq.DBTX, j *jobs.Service) *mf.Service {
	return mf.New(db, mfBackfiller{jobs: j})
}
