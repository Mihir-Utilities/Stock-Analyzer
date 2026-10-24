package importers

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/dbq"
)

// ErrTooLarge: the file exceeds the byte limit of its kind (HTTP 413).
var ErrTooLarge = errors.New("importers: file too large")

// ValidateResult is the body of POST /imports/{kind}/validate (docs/03 section 14).
type ValidateResult struct {
	UploadID              string           `json:"upload_id"`
	UploadGroup           *string          `json:"upload_group"`
	Rows                  int              `json:"rows"`
	Preview               []map[string]any `json:"preview"`
	Errors                []RowIssue       `json:"errors"`
	Warnings              []RowIssue       `json:"warnings"`
	ErrorCount            int              `json:"error_count"`
	WarningCount          int              `json:"warning_count"`
	EstimatedGrowthMB     *float64         `json:"estimated_growth_mb"`
	PricesAlreadyAdjusted *bool            `json:"prices_already_adjusted"`
}

// CommitRequest is the body of POST /imports/{kind}/commit.
type CommitRequest struct {
	UploadIDs   []string
	UploadGroup string
	Note        string
}

// CommitResult is the commit response (docs/03 section 14).
type CommitResult struct {
	BatchID         int64    `json:"batch_id"`
	Inserted        int      `json:"inserted"`
	Updated         int      `json:"updated"`
	Renamed         int      `json:"renamed"`
	PostImportJobID *int64   `json:"post_import_job_id"`
	Warnings        []string `json:"warnings"`
}

// Validate parses and checks a file without writing any data, then stores it in import_upload so a
// later commit can use it (it survives an API restart). group is the optional browser-split group id.
func (s *Service) Validate(ctx context.Context, kind string, content []byte, group string) (*ValidateResult, error) {
	if !Implemented(kind) {
		return nil, ErrKindNotBuilt
	}
	lim := s.Limits(kind)
	if int64(len(content)) > lim.MaxBytes {
		return nil, ErrTooLarge
	}
	if group != "" && !IsUUID(group) {
		return nil, validation("upload_group", "must be a UUID")
	}
	idx, err := loadIndex(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	res := &ValidateResult{Preview: []map[string]any{}, Errors: []RowIssue{}, Warnings: []RowIssue{}}
	var rep *scanReport
	var hdr []RowIssue
	switch kind {
	case KindPrices:
		hol, err := loadHolidays(ctx, s.pool)
		if err != nil {
			return nil, err
		}
		env := priceEnv{idx: idx, holidays: hol, today: s.today(), seen: map[dupKey]uint64{}}
		rep, hdr, err = scanPrices(content, env, lim, nil)
		if err != nil {
			return nil, err
		}
		adj, err := readAdjustment(ctx, s.pool)
		if err != nil {
			return nil, err
		}
		res.PricesAlreadyAdjusted = adj.Value
		if rep != nil {
			newRows, err := newRowCount(ctx, s.pool, env.seen)
			if err != nil {
				return nil, err
			}
			if err := s.priceGuards(ctx, idx, rep, res, newRows); err != nil {
				return nil, err
			}
		}
	case KindInstruments:
		rep, hdr, err = scanInstruments(content, idx, lim, nil)
		if err != nil {
			return nil, err
		}
	default: // the B06b kinds (ownerscan.go)
		rep, hdr, err = scanOwner(kind, content, ownerEnv{idx: idx, today: s.today()}, lim, nil)
		if err != nil {
			return nil, err
		}
	}
	if hdr != nil {
		res.Errors, res.ErrorCount = hdr, len(hdr)
	}
	if rep != nil {
		res.Rows = rep.Rows
		res.Preview = append(res.Preview, rep.Preview...)
		res.Errors = append(res.Errors, rep.Errors.items...)
		res.ErrorCount += rep.Errors.total
		res.Warnings = append(res.Warnings, rep.Warnings.items...)
		res.WarningCount += rep.Warnings.total
	}
	id, err := s.putUpload(ctx, kind, content)
	if err != nil {
		return nil, err
	}
	res.UploadID = id
	if group != "" {
		res.UploadGroup = &group
	}
	return res, nil
}

// priceGuards fills the projected growth and the non-blocking warnings of the validate step.
func (s *Service) priceGuards(ctx context.Context, idx *instrumentIndex, rep *scanReport, res *ValidateResult, newRows int) error {
	mb := roundTo(float64(newRows)*bytesPerRow/float64(mib), 2)
	res.EstimatedGrowthMB = &mb
	if over := trackedOver(idx, rep.Symbols); over {
		rep.Warnings.add(0, "symbol", fmt.Sprintf("this import would track more than %d stocks; the app keeps working, but watch the database size", TrackedWarnLimit))
	}
	cur, err := s.DBSize(ctx)
	if err != nil {
		return err
	}
	if lim := int64(s.DBSoftLimitMB) * mib; cur >= lim || cur+int64(newRows)*bytesPerRow > lim {
		rep.Warnings.add(0, "", fmt.Sprintf("this file would make the database exceed %d MB; the commit will be refused. Trim history or import fewer rows", s.DBSoftLimitMB))
	}
	return nil
}

// newRowCount returns how many of the unique (instrument or series, date) keys of a file do not exist
// yet: only those grow the database (docs/01 7.1 "new rows x ~130 bytes", IMP-23). An all-update
// re-import therefore adds nothing (IMP-10).
func newRowCount(ctx context.Context, db dbq.DBTX, keys map[dupKey]uint64) (int, error) {
	const bars = `SELECT count(*) FROM unnest($1::int[], $2::date[]) AS t(i, d)
		JOIN price_daily p ON p.instrument_id = t.i AND p.trade_date = t.d`
	const series = `SELECT count(*) FROM unnest($1::text[], $2::date[]) AS t(c, d)
		JOIN market_series m ON m.code = t.c AND m.trade_date = t.d`
	var (
		ids        []int32
		days, sday []time.Time
		codes      []string
		existing   int
	)
	run := func(q string, args ...any) error {
		var n int
		if err := db.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			return err
		}
		existing += n
		return nil
	}
	flush := func(force bool) error {
		if len(ids) >= ChunkSize || (force && len(ids) > 0) {
			if err := run(bars, ids, days); err != nil {
				return err
			}
			ids, days = ids[:0], days[:0]
		}
		if len(codes) >= ChunkSize || (force && len(codes) > 0) {
			if err := run(series, codes, sday); err != nil {
				return err
			}
			codes, sday = codes[:0], sday[:0]
		}
		return nil
	}
	for k := range keys {
		d := time.Unix(k.day*86400, 0).UTC()
		if k.inst > 0 {
			ids, days = append(ids, k.inst), append(days, d)
		} else {
			codes, sday = append(codes, k.sym), append(sday, d)
		}
		if err := flush(false); err != nil {
			return 0, err
		}
	}
	if err := flush(true); err != nil {
		return 0, err
	}
	return len(keys) - existing, nil
}

func roundTo(v float64, places int) float64 {
	p := 1.0
	for i := 0; i < places; i++ {
		p *= 10
	}
	return float64(int64(v*p+0.5)) / p
}

func trackedOver(idx *instrumentIndex, symbols map[int32]bool) bool {
	n := 0
	for _, tr := range idx.tracked {
		if tr {
			n++
		}
	}
	for id := range symbols {
		if !idx.tracked[id] {
			n++
		}
	}
	return n > TrackedWarnLimit
}

// claimUploads atomically takes the uploads (deleting them inside the transaction, so a rollback
// puts them back and a second concurrent commit finds nothing).
//
// It also returns the stored size of the claimed rows: the size guard excludes them, because the
// upload being committed is about to be deleted and is not growth (IMP-23). The number of ids and
// the total bytes are capped before any content is loaded (422).
func (s *Service) claimUploads(ctx context.Context, tx pgx.Tx, kind string, ids []string) ([][]byte, int64, error) {
	if len(ids) > MaxCommitParts {
		return nil, 0, validation("upload_ids", fmt.Sprintf("a commit takes at most %d uploads", MaxCommitParts))
	}
	for _, id := range ids {
		if !IsUUID(id) {
			return nil, 0, ErrUploadNotFound
		}
	}
	var bytesTotal int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(content)), 0) FROM import_upload WHERE id = ANY($1::uuid[]) AND expires_at > $2`,
		ids, s.Now()).Scan(&bytesTotal); err != nil {
		return nil, 0, err
	}
	if bytesTotal > MaxCommitBytes {
		return nil, 0, validation("upload_ids", fmt.Sprintf("the uploads of one commit may total at most %d MB", MaxCommitBytes/mib))
	}
	got := map[string][]byte{}
	var stored int64
	for _, id := range ids {
		var k string
		var content []byte
		var size int64
		err := tx.QueryRow(ctx, `DELETE FROM import_upload WHERE id = $1::uuid AND expires_at > $2 RETURNING kind, content, pg_column_size(content)`,
			id, s.Now()).Scan(&k, &content, &size)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrUploadNotFound
		}
		if err != nil {
			return nil, 0, err
		}
		if k != kind {
			return nil, 0, validation("upload_id", fmt.Sprintf("the upload was validated as %q, not %q", k, kind))
		}
		got[id] = content
		stored += size
	}
	out := make([][]byte, 0, len(ids))
	for _, id := range ids {
		out = append(out, got[id])
	}
	return out, stored, nil
}

// Commit writes a validated upload (or the parts of a browser-split group) in ONE transaction and
// records an import_batch. Any error rolls everything back.
func (s *Service) Commit(ctx context.Context, kind string, req CommitRequest) (*CommitResult, error) {
	if !Implemented(kind) {
		return nil, ErrKindNotBuilt
	}
	ids := dedupe(req.UploadIDs)
	if len(ids) == 0 {
		return nil, validation("upload_id", "upload_id or upload_ids is required")
	}
	if len(ids) > 1 && req.UploadGroup == "" {
		return nil, validation("upload_group", "upload_group is required when committing several uploads")
	}
	if req.UploadGroup != "" && !IsUUID(req.UploadGroup) {
		return nil, validation("upload_group", "must be a UUID")
	}
	if len(req.Note) > 500 {
		return nil, validation("note", "must be at most 500 characters")
	}
	if len(ids) > 1 && kind != KindPrices && kind != KindInstruments {
		return nil, validation("upload_ids", "only prices (and instruments) files can be committed as a group of parts")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	parts, stored, err := s.claimUploads(ctx, tx, kind, ids)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	var group any
	if req.UploadGroup != "" {
		group = req.UploadGroup
	}
	var res *CommitResult
	var symbols []string
	var warnCount int
	if isOwnerKind(kind) {
		// The batch row comes first: every stored row is tagged with its id, which is what undo removes.
		var batchID int64
		if err := tx.QueryRow(ctx, `INSERT INTO import_batch (kind, upload_group, sha256, row_count, warning_count, note)
			VALUES ($1, $2::uuid, $3, 0, 0, NULLIF($4, '')) RETURNING id`, kind, group, h.Sum(nil), req.Note).Scan(&batchID); err != nil {
			return nil, err
		}
		res, symbols, warnCount, err = s.commitOwner(ctx, tx, kind, parts, batchID)
		if err != nil {
			return nil, err
		}
		res.BatchID = batchID
		if _, err := tx.Exec(ctx, `UPDATE import_batch SET row_count = $2, warning_count = $3 WHERE id = $1`,
			batchID, res.Inserted+res.Updated, warnCount); err != nil {
			return nil, err
		}
	} else {
		if kind == KindPrices {
			res, symbols, err = s.commitPrices(ctx, tx, parts, stored)
		} else {
			res, err = s.commitInstruments(ctx, tx, parts)
		}
		if err != nil {
			return nil, err
		}
		rows := res.Inserted + res.Updated
		if err := tx.QueryRow(ctx, `INSERT INTO import_batch (kind, upload_group, sha256, row_count, warning_count, note)
			VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, '')) RETURNING id`,
			kind, group, h.Sum(nil), rows, len(res.Warnings), req.Note).Scan(&res.BatchID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.afterCommit(ctx, res, symbols)
	return res, nil
}

// afterCommit queues post_import for the affected symbols. The import is already committed, so a
// failure here only adds a warning: process_queued_jobs / a retry never lose data (docs/04 3.12).
func (s *Service) afterCommit(ctx context.Context, res *CommitResult, symbols []string) {
	if res.Warnings == nil {
		res.Warnings = []string{}
	}
	id, err := s.enqueue(ctx, res.BatchID, symbols)
	if err != nil {
		s.log.Warn().Err(err).Int64("batch_id", res.BatchID).Msg("post_import could not be queued")
		res.Warnings = append(res.Warnings, WarnPostImportNotQueued)
		return
	}
	res.PostImportJobID = id
}

func (s *Service) enqueue(ctx context.Context, batchID int64, symbols []string) (*int64, error) {
	if s.enq == nil || len(symbols) == 0 {
		return nil, nil
	}
	job, _, err := s.enq.EnqueuePostImport(ctx, batchID, symbols)
	if err != nil {
		return nil, err
	}
	return &job.ID, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range in {
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// ---- prices ----

type priceChunk struct {
	tx       pgx.Tx
	ctx      context.Context
	adjusted bool
	size     int
	hook     func(int) error

	iID  []int32
	iDay []time.Time
	o, h []float64
	l, c []float64
	vol  []int64
	susp []bool
	pos  map[dupKey]int

	sCode []string
	sDay  []time.Time
	sVal  []float64
	spos  map[dupKey]int

	n, chunks         int
	inserted, updated int
}

func newPriceChunk(ctx context.Context, tx pgx.Tx, adjusted bool, size int, hook func(int) error) *priceChunk {
	b := &priceChunk{tx: tx, ctx: ctx, adjusted: adjusted, size: size, hook: hook}
	b.reset()
	return b
}

func (b *priceChunk) reset() {
	b.iID, b.iDay, b.o, b.h, b.l, b.c, b.vol, b.susp = nil, nil, nil, nil, nil, nil, nil, nil
	b.sCode, b.sDay, b.sVal = nil, nil, nil
	b.pos, b.spos = map[dupKey]int{}, map[dupKey]int{}
	b.n = 0
}

// add buffers a bar. A duplicate key inside the chunk replaces the earlier bar (last wins), since
// one INSERT ... ON CONFLICT statement cannot touch the same row twice.
func (b *priceChunk) add(p priceRow) error {
	day := p.date.Unix() / 86400
	if p.code != "" {
		k := dupKey{sym: p.code, day: day}
		if i, ok := b.spos[k]; ok {
			b.sVal[i] = p.c
			return nil
		}
		b.spos[k] = len(b.sCode)
		b.sCode, b.sDay, b.sVal = append(b.sCode, p.code), append(b.sDay, p.date), append(b.sVal, p.c)
	} else {
		k := dupKey{day: day, inst: p.inst}
		if i, ok := b.pos[k]; ok {
			b.o[i], b.h[i], b.l[i], b.c[i], b.vol[i], b.susp[i] = p.o, p.h, p.l, p.c, p.vol, p.suspect
			return nil
		}
		b.pos[k] = len(b.iID)
		b.iID, b.iDay = append(b.iID, p.inst), append(b.iDay, p.date)
		b.o, b.h, b.l, b.c = append(b.o, p.o), append(b.h, p.h), append(b.l, p.l), append(b.c, p.c)
		b.vol, b.susp = append(b.vol, p.vol), append(b.susp, p.suspect)
	}
	b.n++
	if b.n >= b.size {
		return b.flush()
	}
	return nil
}

const upsertBars = `
INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, src_adjusted, suspect)
SELECT t.i, t.d, t.o, t.h, t.l, t.c, t.c, t.v, 'import', $8::bool, t.s
FROM unnest($1::int[], $2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::bigint[], $9::bool[]) AS t(i, d, o, h, l, c, v, s)
ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
  open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
  adj_close = EXCLUDED.adj_close, volume = EXCLUDED.volume, source = 'import',
  src_adjusted = EXCLUDED.src_adjusted, suspect = EXCLUDED.suspect
RETURNING (xmax = 0)`

const upsertSeries = `
INSERT INTO market_series (code, trade_date, value)
SELECT t.c, t.d, t.v FROM unnest($1::text[], $2::date[], $3::float8[]) AS t(c, d, v)
ON CONFLICT (code, trade_date) DO UPDATE SET value = EXCLUDED.value
RETURNING (xmax = 0)`

func (b *priceChunk) count(rows pgx.Rows, err error) error {
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ins bool
		if err := rows.Scan(&ins); err != nil {
			return err
		}
		if ins {
			b.inserted++
		} else {
			b.updated++
		}
	}
	return rows.Err()
}

func (b *priceChunk) flush() error {
	if len(b.iID) > 0 {
		if err := b.count(b.tx.Query(b.ctx, upsertBars, b.iID, b.iDay, b.o, b.h, b.l, b.c, b.vol, b.adjusted, b.susp)); err != nil {
			return err
		}
	}
	if len(b.sCode) > 0 {
		if err := b.count(b.tx.Query(b.ctx, upsertSeries, b.sCode, b.sDay, b.sVal)); err != nil {
			return err
		}
	}
	b.chunks++
	b.reset()
	if b.hook != nil {
		return b.hook(b.chunks)
	}
	return nil
}

// markJumps flags bars whose close moved more than 50% from the previous stored bar when no
// confirmed corporate action lies within one trading day (docs/01 3.5, BRK-08). The detector reads
// suspect bars too, so a split is still detected (D03-A9).
const markJumps = `
WITH w AS (
  SELECT trade_date, close,
         LAG(close) OVER o AS pc, LAG(trade_date) OVER o AS pd, LEAD(trade_date) OVER o AS nd
  FROM price_daily WHERE instrument_id = $1
  WINDOW o AS (ORDER BY trade_date)
), flag AS (
  SELECT w.trade_date FROM w
  WHERE w.pc IS NOT NULL AND abs(w.close / w.pc - 1) > 0.5
    AND w.trade_date >= $2
    AND w.trade_date <= COALESCE((SELECT min(trade_date) FROM price_daily WHERE instrument_id = $1 AND trade_date > $3), $3)
    AND NOT EXISTS (SELECT 1 FROM corporate_action ca
                    WHERE ca.instrument_id = $1 AND ca.status = 'confirmed'
                      AND ca.ex_date BETWEEN COALESCE(w.pd, w.trade_date) AND COALESCE(w.nd, w.trade_date))
)
UPDATE price_daily p SET suspect = true FROM flag f
WHERE p.instrument_id = $1 AND p.trade_date = f.trade_date AND NOT p.suspect`

// scanAll runs pass 1 (validate only) over every part and returns the merged report.
// The parts share one duplicate map (env.seen), so a contradictory duplicate across parts is an error.
func scanAllPrices(parts [][]byte, env priceEnv, lim Limits) (*scanReport, error) {
	total := newReport()
	if env.seen == nil {
		env.seen = map[dupKey]uint64{}
	}
	for _, part := range parts {
		rep, hdr, err := scanPrices(part, env, lim, nil)
		if err != nil {
			return nil, err
		}
		if hdr != nil {
			total.Errors.total += len(hdr)
			continue
		}
		mergeReport(total, rep)
	}
	return total, nil
}

func mergeReport(dst, src *scanReport) {
	dst.Rows += src.Rows
	dst.Valid += src.Valid
	dst.Errors.total += src.Errors.total
	dst.Warnings.total += src.Warnings.total
	for id := range src.Symbols {
		dst.Symbols[id] = true
	}
	for c := range src.Series {
		dst.Series[c] = true
	}
	for id, d := range src.MinDate {
		if cur, ok := dst.MinDate[id]; !ok || d.Before(cur) {
			dst.MinDate[id] = d
		}
	}
	for id, d := range src.MaxDate {
		if cur, ok := dst.MaxDate[id]; !ok || d.After(cur) {
			dst.MaxDate[id] = d
		}
	}
}

func (s *Service) commitPrices(ctx context.Context, tx pgx.Tx, parts [][]byte, ownUploadBytes int64) (*CommitResult, []string, error) {
	idx, err := loadIndex(ctx, tx)
	if err != nil {
		return nil, nil, err
	}
	hol, err := loadHolidays(ctx, tx)
	if err != nil {
		return nil, nil, err
	}
	env := priceEnv{idx: idx, holidays: hol, today: s.today()}
	lim := s.Limits(KindPrices)
	checkEnv := env
	checkEnv.seen = map[dupKey]uint64{}
	rep, err := scanAllPrices(parts, checkEnv, lim)
	if err != nil {
		return nil, nil, err
	}
	if rep.Errors.total > 0 {
		return nil, nil, &HasErrorsError{Count: rep.Errors.total}
	}
	adj, err := readAdjustment(ctx, tx)
	if err != nil {
		return nil, nil, err
	}
	if adj.Value == nil {
		return nil, nil, ErrAdjustmentUnset
	}
	cur, err := s.DBSize(ctx)
	if err != nil {
		return nil, nil, err
	}
	// Only NEW rows grow the database, and this commit's own import_upload bytes (about to be
	// deleted, but still counted by pg_database_size) are not part of the current size (IMP-23).
	newRows, err := newRowCount(ctx, tx, checkEnv.seen)
	if err != nil {
		return nil, nil, err
	}
	cur = max(0, cur-ownUploadBytes)
	growth := int64(newRows) * bytesPerRow
	if limit := int64(s.DBSoftLimitMB) * mib; cur >= limit || cur+growth > limit {
		return nil, nil, &SizeLimitError{LimitMB: float64(s.DBSoftLimitMB), CurrentMB: roundTo(float64(cur)/float64(mib), 1), GrowthMB: roundTo(float64(growth)/float64(mib), 2)}
	}

	chunk := newPriceChunk(ctx, tx, *adj.Value, s.chunkSize, s.afterChunk)
	for _, part := range parts {
		if _, _, err := scanPrices(part, env, lim, chunk.add); err != nil {
			return nil, nil, err
		}
	}
	if chunk.n > 0 {
		if err := chunk.flush(); err != nil {
			return nil, nil, err
		}
	}
	ids := make([]int32, 0, len(rep.Symbols))
	for id := range rep.Symbols {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if _, err := tx.Exec(ctx, markJumps, id, rep.MinDate[id], rep.MaxDate[id]); err != nil {
			return nil, nil, err
		}
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE instrument SET is_tracked = true, tracked_reason = 'imported', updated_at = now()
			WHERE id = ANY($1::int[]) AND NOT is_tracked`, ids); err != nil {
			return nil, nil, err
		}
	}
	res := &CommitResult{Inserted: chunk.inserted, Updated: chunk.updated, Warnings: []string{}}
	if trackedOver(idx, rep.Symbols) {
		res.Warnings = append(res.Warnings, WarnTrackedOver400)
	}
	symbols := make([]string, 0, len(ids))
	for _, id := range ids {
		symbols = append(symbols, idx.byID[id])
	}
	sort.Strings(symbols)
	return res, symbols, nil
}

// ---- instruments ----

const upsertInstrument = `
INSERT INTO instrument (symbol, name, isin, series, listing_date, face_value, status, instrument_kind)
VALUES ($1, $2, $3::text, COALESCE($4::text, 'EQ'), $5::date, $6::numeric, COALESCE($7::text, 'active'), COALESCE($8::text, 'equity'))
ON CONFLICT (symbol) DO UPDATE SET
  name = EXCLUDED.name,
  isin = COALESCE($3::text, instrument.isin),
  series = COALESCE($4::text, instrument.series),
  listing_date = COALESCE($5::date, instrument.listing_date),
  face_value = COALESCE($6::numeric, instrument.face_value),
  status = COALESCE($7::text, instrument.status),
  instrument_kind = COALESCE($8::text, instrument.instrument_kind),
  updated_at = now()
RETURNING (xmax = 0)`

func (s *Service) commitInstruments(ctx context.Context, tx pgx.Tx, parts [][]byte) (*CommitResult, error) {
	lim := s.Limits(KindInstruments)
	res := &CommitResult{Warnings: []string{}}
	// Pass 1: validate every part against the current instruments. Pass 2: write.
	for pass := 1; pass <= 2; pass++ {
		idx, err := loadIndex(ctx, tx)
		if err != nil {
			return nil, err
		}
		for _, part := range parts {
			var batch pgx.Batch
			var kinds []string
			flush := func() error {
				if batch.Len() == 0 {
					return nil
				}
				br := tx.SendBatch(ctx, &batch)
				for _, k := range kinds {
					if k == "upsert" {
						var ins bool
						if err := br.QueryRow().Scan(&ins); err != nil {
							_ = br.Close()
							return err
						}
						if ins {
							res.Inserted++
						} else {
							res.Updated++
						}
						continue
					}
					if _, err := br.Exec(); err != nil {
						_ = br.Close()
						return err
					}
				}
				batch, kinds = pgx.Batch{}, nil
				return br.Close()
			}
			onOp := func(op instOp) error {
				if pass == 1 {
					return nil
				}
				if op.Action == "rename" {
					batch.Queue(`UPDATE instrument SET symbol = $2, updated_at = now() WHERE id = $1`, op.RenameID, op.Symbol)
					kinds = append(kinds, "exec")
					res.Renamed++
					for _, old := range op.AliasOld {
						batch.Queue(`INSERT INTO symbol_alias (instrument_id, old_symbol, changed_on) VALUES ($1, $2, $3)
							ON CONFLICT (instrument_id, old_symbol) DO UPDATE SET changed_on = EXCLUDED.changed_on`, op.RenameID, old, s.today())
						kinds = append(kinds, "exec")
					}
				}
				batch.Queue(upsertInstrument, op.Symbol, op.Name, op.ISIN, op.Series, op.Listing, op.Face, op.Status, op.Kind)
				kinds = append(kinds, "upsert")
				if batch.Len() >= s.chunkSize {
					if err := flush(); err != nil {
						return err
					}
					if s.afterChunk != nil {
						return s.afterChunk(1)
					}
				}
				return nil
			}
			rep, hdr, err := scanInstruments(part, idx, lim, onOp)
			if err != nil {
				return nil, err
			}
			if n := len(hdr); n > 0 {
				return nil, &HasErrorsError{Count: n}
			}
			if rep.Errors.total > 0 {
				return nil, &HasErrorsError{Count: rep.Errors.total}
			}
			if err := flush(); err != nil {
				return nil, err
			}
		}
	}
	return res, nil
}

var _ dbq.DBTX = (pgx.Tx)(nil)
