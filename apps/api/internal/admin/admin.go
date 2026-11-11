// Package admin serves GET /admin/status (docs/03 section 15, docs/06 6.12): source health, the latest
// run per job, coverage, database size against DB_SOFT_LIMIT_MB with a warn level, and the years with
// no holiday list. Read only; manual price mode, so no broker session state is reported (D-1).
package admin

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/instruments"
	"github.com/india-analyzer/api/internal/logx"
)

const (
	mib = 1 << 20
	// RecentErrorLimit is the size of the recent-errors list (docs/06 6.12).
	RecentErrorLimit = 50
)

// Service reads the operational status.
type Service struct {
	db      dbq.DBTX
	limitMB int
	version string
	Now     func() time.Time
	// Scrub redacts secrets from free text read from the database (source_health.note,
	// ingestion_run.error) at read time; main wires the log scrubber. Never nil.
	Scrub func(string) string
}

// New builds a Service. limitMB is DB_SOFT_LIMIT_MB; version is the build's git sha ("" = unknown).
func New(db dbq.DBTX, limitMB int, version string) *Service {
	if version == "" {
		version = "unknown"
	}
	return &Service{db: db, limitMB: limitMB, version: version, Now: time.Now, Scrub: logx.NewScrubber().Scrub}
}

// Source is a source_health row (the broker is dormant in manual price mode and is not listed).
type Source struct {
	Source              string  `json:"source"`
	CheckedAt           string  `json:"checked_at"`
	OK                  bool    `json:"ok"`
	LatencyMS           *int32  `json:"latency_ms"`
	ConsecutiveFailures int32   `json:"consecutive_failures"`
	DisabledUntil       *string `json:"disabled_until"`
	Note                *string `json:"note"`
}

// Job is an ingestion_run row.
type Job struct {
	Job         string  `json:"job"`
	StartedAt   string  `json:"started_at"`
	FinishedAt  *string `json:"finished_at"`
	Status      string  `json:"status"`
	RowsWritten int32   `json:"rows_written"`
	ItemsTotal  *int32  `json:"items_total"`
	ItemsFailed int32   `json:"items_failed"`
	Error       *string `json:"error"`
	// LastSkippedAt is set on jobs[] only: a later run of the job that was skipped (already running).
	// A skipped run never replaces the last real result.
	LastSkippedAt *string `json:"last_skipped_at,omitempty"`
}

// Coverage counts instruments with data.
type Coverage struct {
	Instruments      int64 `json:"instruments"`
	Tracked          int64 `json:"tracked"`
	WithPrices       int64 `json:"with_prices"`
	WithFundamentals int64 `json:"with_fundamentals"`
	WithShareholding int64 `json:"with_shareholding"`
}

// Table is one relation with its total size (table + indexes) and the planner's row estimate.
type Table struct {
	Name string  `json:"name"`
	MB   float64 `json:"mb"`
	Rows *int64  `json:"rows"` // planner estimate; null when the table was never analyzed (reltuples < 0)
}

// DB is the database size block. warn_level is "ok", "70", "85", "95" or "limit".
type DB struct {
	SizeMB    float64  `json:"size_mb"`
	LimitMB   int      `json:"limit_mb"`
	UsedPct   *float64 `json:"used_pct"` // null when no limit is configured
	Tables    []Table  `json:"tables"`
	WarnLevel string   `json:"warn_level"`
}

// Status is data of GET /admin/status.
type Status struct {
	Sources                []Source       `json:"sources"`
	Jobs                   []Job          `json:"jobs"`
	RecentErrors           []Job          `json:"recent_errors"`
	Coverage               Coverage       `json:"coverage"`
	DB                     DB             `json:"db"`
	HolidayListMissingYear []int          `json:"holiday_list_missing_years"`
	Version                string         `json:"version"`
	StoragePolicy          map[string]any `json:"storage_policy"`
}

// WarnLevel maps usage to the documented thresholds (docs/04 3.10): 70, 85, 95 percent, then limit
// at 100 percent of the soft limit.
func WarnLevel(sizeBytes int64, limitMB int) string {
	if limitMB <= 0 {
		return "ok"
	}
	pct := float64(sizeBytes) / float64(int64(limitMB)*mib) * 100
	switch {
	case pct >= 100:
		return "limit"
	case pct >= 95:
		return "95"
	case pct >= 85:
		return "85"
	case pct >= 70:
		return "70"
	}
	return "ok"
}

func ts(t pgtype.Timestamptz) string { return t.Time.UTC().Format(time.RFC3339) }

func optTS(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	s := ts(t)
	return &s
}

// Status builds the status document.
func (s *Service) Status(ctx context.Context) (Status, error) {
	st := Status{Version: s.version, Sources: []Source{}, Jobs: []Job{}, RecentErrors: []Job{}}
	var err error
	if st.Sources, err = s.sources(ctx); err != nil {
		return st, err
	}
	if st.Jobs, err = s.jobs(ctx, `SELECT DISTINCT ON (r.job) r.job, r.started_at, r.finished_at, r.status, r.rows_written, r.items_total, r.items_failed, r.error,
		(SELECT max(k.started_at) FROM ingestion_run k WHERE k.job = r.job AND k.status = 'skipped' AND k.started_at > r.started_at)
		FROM ingestion_run r WHERE r.status <> 'skipped' ORDER BY r.job, r.started_at DESC, r.id DESC`, nil); err != nil {
		return st, err
	}
	if st.RecentErrors, err = s.jobs(ctx, `SELECT job, started_at, finished_at, status, rows_written, items_total, items_failed, error
		FROM ingestion_run WHERE status IN ('failed','partial') AND error IS NOT NULL
		ORDER BY started_at DESC, id DESC LIMIT $1`, []any{RecentErrorLimit}); err != nil {
		return st, err
	}
	if err = s.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM instrument),
		(SELECT count(*) FROM instrument WHERE is_tracked),
		(SELECT count(*) FROM instrument i WHERE EXISTS (SELECT 1 FROM price_daily p WHERE p.instrument_id = i.id)),
		(SELECT count(*) FROM instrument i WHERE EXISTS (SELECT 1 FROM fundamental_value f WHERE f.instrument_id = i.id)),
		(SELECT count(*) FROM instrument i WHERE EXISTS (SELECT 1 FROM shareholding h WHERE h.instrument_id = i.id))`).
		Scan(&st.Coverage.Instruments, &st.Coverage.Tracked, &st.Coverage.WithPrices, &st.Coverage.WithFundamentals, &st.Coverage.WithShareholding); err != nil {
		return st, err
	}
	if st.DB, err = s.dbSize(ctx); err != nil {
		return st, err
	}
	if st.HolidayListMissingYear, err = s.missingHolidayYears(ctx); err != nil {
		return st, err
	}
	st.StoragePolicy = map[string]any{
		"price_mode":                     "manual",
		"db_soft_limit_mb":               s.limitMB,
		"warn_levels_pct":                "70/85/95",
		"imported_prices_auto_deleted":   false,
		"price_imports_blocked_at_limit": true,
	}
	return st, nil
}

func (s *Service) sources(ctx context.Context) ([]Source, error) {
	rows, err := s.db.Query(ctx, `SELECT source, checked_at, ok, latency_ms, consecutive_failures, disabled_until, note
		FROM source_health WHERE source <> 'broker' ORDER BY source`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Source{}
	for rows.Next() {
		var r Source
		var checked, disabled pgtype.Timestamptz
		if err := rows.Scan(&r.Source, &checked, &r.OK, &r.LatencyMS, &r.ConsecutiveFailures, &disabled, &r.Note); err != nil {
			return nil, err
		}
		r.Note = s.scrubbed(r.Note)
		r.CheckedAt, r.DisabledUntil = ts(checked), optTS(disabled)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) scrubbed(v *string) *string {
	if v == nil || s.Scrub == nil {
		return v
	}
	out := s.Scrub(*v)
	return &out
}

// jobs runs a query that selects the eight job columns, plus an optional ninth (last skipped start)
// when the query is the latest-run-per-job one.
func (s *Service) jobs(ctx context.Context, q string, args []any) ([]Job, error) {
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		var j Job
		var started, finished, skipped pgtype.Timestamptz
		dest := []any{&j.Job, &started, &finished, &j.Status, &j.RowsWritten, &j.ItemsTotal, &j.ItemsFailed, &j.Error}
		if len(rows.FieldDescriptions()) > len(dest) {
			dest = append(dest, &skipped)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		j.StartedAt, j.FinishedAt, j.LastSkippedAt = ts(started), optTS(finished), optTS(skipped)
		j.Error = s.scrubbed(j.Error)
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Service) dbSize(ctx context.Context) (DB, error) {
	var size int64
	if err := s.db.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&size); err != nil {
		return DB{}, err
	}
	out := DB{LimitMB: s.limitMB, Tables: []Table{}, WarnLevel: WarnLevel(size, s.limitMB)}
	out.SizeMB = round(float64(size)/mib, 2)
	if s.limitMB > 0 {
		out.UsedPct = ptr(round(float64(size)/float64(int64(s.limitMB)*mib)*100, 1))
	}
	rows, err := s.db.Query(ctx, `SELECT c.relname, pg_total_relation_size(c.oid),
		CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC, c.relname`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var t Table
		var b int64
		if err := rows.Scan(&t.Name, &b, &t.Rows); err != nil {
			return out, err
		}
		t.MB = round(float64(b)/mib, 2)
		out.Tables = append(out.Tables, t)
	}
	return out, rows.Err()
}

// missingHolidayYears lists the years that matter today with no trading-holiday row: the current IST
// year and the IST year of the newest imported bar (B14-3). Weekends-only rules apply to them.
func (s *Service) missingHolidayYears(ctx context.Context) ([]int, error) {
	years := map[int]bool{s.Now().In(instruments.IST).Year(): true}
	var last pgtype.Date
	if err := s.db.QueryRow(ctx, `SELECT max(trade_date) FROM price_daily`).Scan(&last); err != nil {
		return nil, err
	}
	if last.Valid {
		years[last.Time.Year()] = true
	}
	out := []int{}
	for y := range years {
		var n int64
		// Same rule as seed and the stock profile: only segment 'trading' counts (B08-9).
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM market_holiday WHERE segment = 'trading'
			AND holiday_date >= make_date($1::int, 1, 1) AND holiday_date < make_date($1::int + 1, 1, 1)`, y).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 {
			out = append(out, y)
		}
	}
	sort.Ints(out)
	return out, nil
}

func ptr[T any](v T) *T { return &v }

func round(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}
