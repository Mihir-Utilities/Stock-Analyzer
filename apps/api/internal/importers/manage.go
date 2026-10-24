package importers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- templates (docs/03 section 14: header row and one example row) ----

// Template header and example rows. A test keeps them equal to fixtures/templates/*.csv.
var templates = map[string]string{
	KindPrices:      "symbol,date,open,high,low,close,volume\nDEMOCO,2026-01-05,100.00,102.50,99.20,101.30,1250000\n",
	KindInstruments: "symbol,name,isin,series,kind,listing_date,face_value,previous_symbol,status\nDEMOCO,Demo Company Limited,INDEMO000001,EQ,equity,2010-05-17,2.00,,active\n",
}

// Template returns the CSV template of a built kind.
func Template(kind string) (content []byte, filename string, err error) {
	t, ok := templates[kind]
	if !ok {
		return nil, "", ErrKindNotBuilt
	}
	return []byte(t), kind + "_template.csv", nil
}

// ---- Add stock (POST /instruments) ----

// AddResult is the 201 body of POST /instruments.
type AddResult struct {
	ID       int32    `json:"id"`
	Symbol   string   `json:"symbol"`
	Warnings []string `json:"warnings"`
}

// AddInstrument is the manual Add stock form: same validators as instruments.csv (IMP-17).
func (s *Service) AddInstrument(ctx context.Context, in InstrumentFields) (*AddResult, error) {
	n, errs, warns := ValidateInstrumentFields(in)
	if len(errs) > 0 {
		return nil, &ValidationError{Fields: errs}
	}
	var isin *string
	if n.ISIN != "" {
		isin = &n.ISIN
	}
	var id int32
	err := s.pool.QueryRow(ctx, `INSERT INTO instrument (symbol, name, isin) VALUES ($1, $2, $3)
		ON CONFLICT (symbol) DO NOTHING RETURNING id`, n.Symbol, n.Name, isin).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	out := &AddResult{ID: id, Symbol: n.Symbol, Warnings: []string{}}
	for _, w := range warns {
		out.Warnings = append(out.Warnings, w.Code)
	}
	return out, nil
}

// ---- adjustment check (POST /imports/prices/adjustment-check) ----

// AdjustmentCheckRequest is the request body; ExpectedNum/Den are optional.
type AdjustmentCheckRequest struct {
	UploadID    string
	Symbol      string
	ExDate      string
	ExpectedNum *int64
	ExpectedDen *int64
}

// AdjustmentCheckResult is the response (docs/01 3.7 rule 2).
type AdjustmentCheckResult struct {
	Bars            [][]any `json:"bars"`
	Ratio           float64 `json:"ratio"`
	NearestFraction *string `json:"nearest_fraction"`
	Hint            string  `json:"hint"`
}

var splitFractions = []struct {
	name string
	v    float64
}{{"1/2", 1.0 / 2}, {"1/3", 1.0 / 3}, {"1/4", 1.0 / 4}, {"1/5", 1.0 / 5}, {"1/10", 1.0 / 10},
	{"1/20", 1.0 / 20}, {"2/3", 2.0 / 3}, {"3/4", 3.0 / 4}, {"4/5", 4.0 / 5}, {"5/6", 5.0 / 6}}

const hintTolerance = 0.03 // the detector's 3% (docs/01 3.7)

func within(r, target float64) bool { return math.Abs(r-target) <= hintTolerance*target }

// AdjustmentCheck compares the closes around a known ex-date in a validated upload. It reads only
// the upload and writes nothing (IMP-26).
func (s *Service) AdjustmentCheck(ctx context.Context, req AdjustmentCheckRequest) (*AdjustmentCheckResult, error) {
	sym := upperTrim(strings.TrimSpace(req.Symbol))
	if sym == "" {
		return nil, validation("symbol", "symbol is required")
	}
	ex, err := ParseDate(req.ExDate)
	if err != nil {
		return nil, validation("ex_date", err.Error())
	}
	var target float64
	if (req.ExpectedNum == nil) != (req.ExpectedDen == nil) {
		return nil, validation("expected_ratio", "num and den must be given together")
	}
	if req.ExpectedNum != nil {
		if *req.ExpectedNum <= 0 || *req.ExpectedDen <= 0 {
			return nil, validation("expected_ratio", "num and den must be greater than 0")
		}
		target = float64(*req.ExpectedNum) / float64(*req.ExpectedDen)
	}
	content, err := s.getUpload(ctx, s.pool, req.UploadID, KindPrices)
	if err != nil {
		return nil, err
	}
	idx, err := loadIndex(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	hol, err := loadHolidays(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	closes := map[time.Time]float64{}
	_, hdr, err := scanPrices(content, priceEnv{idx: idx, holidays: hol, today: s.today()}, s.Limits(KindPrices), func(p priceRow) error {
		if p.sym == sym {
			closes[p.date] = p.c
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if hdr != nil || len(closes) == 0 {
		return nil, validation("symbol", fmt.Sprintf("no valid rows for %s in the uploaded file", sym))
	}
	dates := make([]time.Time, 0, len(closes))
	for d := range closes {
		dates = append(dates, d)
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	exIdx := sort.Search(len(dates), func(i int) bool { return !dates[i].Before(ex) })
	if exIdx == 0 || exIdx == len(dates) {
		return nil, validation("ex_date", fmt.Sprintf("the file needs trading days before and on or after %s for %s", ex.Format(time.DateOnly), sym))
	}
	lo, hi := max(0, exIdx-5), min(len(dates), exIdx+5)
	bars := make([][]any, 0, hi-lo)
	for _, d := range dates[lo:hi] {
		bars = append(bars, []any{d.Format(time.DateOnly), closes[d]})
	}
	ratio := closes[dates[exIdx]] / closes[dates[exIdx-1]]
	out := &AdjustmentCheckResult{Bars: bars, Ratio: roundTo(ratio, 4)}
	bestName, bestDiff := "", math.MaxFloat64
	for _, f := range splitFractions {
		if d := math.Abs(ratio-f.v) / f.v; within(ratio, f.v) && d < bestDiff {
			bestName, bestDiff = f.name, d
		}
	}
	if bestName != "" {
		out.NearestFraction = &bestName
	}
	switch {
	case target > 0 && within(ratio, target) && !within(target, 1):
		out.Hint = "raw_likely"
	case target == 0 && bestName != "":
		out.Hint = "raw_likely"
	case within(ratio, 1):
		out.Hint = "adjusted_likely"
	default:
		out.Hint = "inconclusive"
	}
	return out, nil
}

// ---- delete prices and trim history (docs/03 section 4, docs/04 3.10, decision D-C) ----

func parseISO(field, v string) (time.Time, error) {
	d, err := time.Parse(time.DateOnly, strings.TrimSpace(v))
	if err != nil || strings.TrimSpace(v) != d.Format(time.DateOnly) {
		return time.Time{}, validation(field, "must be a date in YYYY-MM-DD format")
	}
	return d, nil
}

func (s *Service) stockID(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, symbol string) (int32, string, error) {
	sym := upperTrim(strings.TrimSpace(symbol))
	var id int32
	var canon string
	err := db.QueryRow(ctx, `SELECT id, symbol FROM instrument WHERE symbol = $1`, sym).Scan(&id, &canon)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", ErrSymbolNotFound
	}
	return id, canon, err
}

func parseRange(from, to string) (time.Time, time.Time, error) {
	var fields []FieldIssue
	f, ferr := parseISO("from", from)
	t, terr := parseISO("to", to)
	for _, e := range []error{ferr, terr} {
		var ve *ValidationError
		if errors.As(e, &ve) {
			fields = append(fields, ve.Fields...)
		}
	}
	if len(fields) == 0 && f.After(t) {
		fields = append(fields, FieldIssue{Field: "from", Message: "must be on or before to"})
	}
	if len(fields) > 0 {
		return f, t, &ValidationError{Fields: fields}
	}
	return f, t, nil
}

// DeletePreview counts the rows a delete would remove (POST /stocks/{symbol}/prices/delete-preview).
func (s *Service) DeletePreview(ctx context.Context, symbol, from, to string) (int, error) {
	f, t, err := parseRange(from, to)
	if err != nil {
		return 0, err
	}
	id, _, err := s.stockID(ctx, s.pool, symbol)
	if err != nil {
		return 0, err
	}
	var n int
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM price_daily WHERE instrument_id = $1 AND trade_date BETWEEN $2 AND $3`, id, f, t).Scan(&n)
	return n, err
}

// DeleteResult is the response of DELETE /stocks/{symbol}/prices.
type DeleteResult struct {
	Deleted int    `json:"deleted"`
	JobID   *int64 `json:"job_id"`
	BatchID *int64 `json:"batch_id"`
}

// DeletePrices removes one stock's bars between two dates (inclusive), writes an audit batch and
// queues post_import to recompute analytics and detection (PRC-21).
func (s *Service) DeletePrices(ctx context.Context, symbol, from, to string, confirm bool) (*DeleteResult, error) {
	f, t, err := parseRange(from, to)
	if err != nil {
		return nil, err
	}
	if !confirm {
		return nil, validation("confirm", "must be true to delete prices")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, canon, err := s.stockID(ctx, tx, symbol)
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date BETWEEN $2 AND $3`, id, f, t)
	if err != nil {
		return nil, err
	}
	n := int(tag.RowsAffected())
	res := &DeleteResult{Deleted: n}
	if n == 0 { // nothing changed: no audit row, no job
		return res, tx.Commit(ctx)
	}
	note := fmt.Sprintf("deleted prices %s %s..%s, %d rows", canon, f.Format(time.DateOnly), t.Format(time.DateOnly), n)
	batchID, err := s.auditBatch(ctx, tx, n, note)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	res.BatchID = &batchID
	res.JobID = s.queuePostImport(ctx, batchID, []string{canon})
	return res, nil
}

func (s *Service) auditBatch(ctx context.Context, tx pgx.Tx, rows int, note string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO import_batch (kind, row_count, note) VALUES ('manual_form', $1, $2) RETURNING id`, rows, note).Scan(&id)
	return id, err
}

func (s *Service) queuePostImport(ctx context.Context, batchID int64, symbols []string) *int64 {
	id, err := s.enqueue(ctx, batchID, symbols)
	if err != nil {
		s.log.Warn().Err(err).Int64("batch_id", batchID).Msg("post_import could not be queued")
		return nil
	}
	return id
}

// SymbolRows is the row count for one stock.
type SymbolRows struct {
	Symbol string `json:"symbol"`
	Rows   int    `json:"rows"`
}

// TrimPreview is the response of POST /prices/trim/preview.
type TrimPreview struct {
	PerSymbol        []SymbolRows `json:"per_symbol"`
	TotalRows        int          `json:"total_rows"`
	EstimatedMBFreed float64      `json:"estimated_mb_freed"`
}

// TrimResult is the response of POST /prices/trim.
type TrimResult struct {
	Deleted   int          `json:"deleted"`
	PerSymbol []SymbolRows `json:"per_symbol"`
	BatchID   *int64       `json:"batch_id"`
	JobID     *int64       `json:"job_id"`
}

const maxTrimSymbols = 500

func (s *Service) trimTargets(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, symbols []string, before string) ([]int32, []string, time.Time, error) {
	b, err := parseISO("before", before)
	if err != nil {
		return nil, nil, b, err
	}
	if len(symbols) == 0 || len(symbols) > maxTrimSymbols {
		return nil, nil, b, validation("symbols", fmt.Sprintf("give between 1 and %d symbols", maxTrimSymbols))
	}
	seen := map[string]bool{}
	var ids []int32
	var names, unknown []string
	for _, raw := range symbols {
		up := upperTrim(strings.TrimSpace(raw))
		if seen[up] {
			continue
		}
		seen[up] = true
		id, canon, err := s.stockID(ctx, db, up)
		if errors.Is(err, ErrSymbolNotFound) {
			unknown = append(unknown, up)
			continue
		}
		if err != nil {
			return nil, nil, b, err
		}
		ids, names = append(ids, id), append(names, canon)
	}
	if len(unknown) > 0 {
		return nil, nil, b, validation("symbols", "unknown symbols: "+strings.Join(unknown, ", "))
	}
	return ids, names, b, nil
}

// TrimPreviewFor returns the row counts per symbol and the estimated space freed.
func (s *Service) TrimPreviewFor(ctx context.Context, symbols []string, before string) (*TrimPreview, error) {
	ids, names, b, err := s.trimTargets(ctx, s.pool, symbols, before)
	if err != nil {
		return nil, err
	}
	out := &TrimPreview{PerSymbol: []SymbolRows{}}
	for i, id := range ids {
		var n int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM price_daily WHERE instrument_id = $1 AND trade_date < $2`, id, b).Scan(&n); err != nil {
			return nil, err
		}
		out.PerSymbol = append(out.PerSymbol, SymbolRows{Symbol: names[i], Rows: n})
		out.TotalRows += n
	}
	out.EstimatedMBFreed = roundTo(float64(out.TotalRows)*bytesPerRow/float64(mib), 2)
	return out, nil
}

// Trim deletes price_daily rows older than before for the chosen stocks (owner-initiated only;
// housekeeping never does this, docs/04 3.10), writes an audit batch and queues post_import.
func (s *Service) Trim(ctx context.Context, symbols []string, before string, confirm bool) (*TrimResult, error) {
	if !confirm {
		return nil, validation("confirm", "must be true to trim history")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ids, names, b, err := s.trimTargets(ctx, tx, symbols, before)
	if err != nil {
		return nil, err
	}
	res := &TrimResult{PerSymbol: []SymbolRows{}}
	var affected []string
	for i, id := range ids {
		tag, err := tx.Exec(ctx, `DELETE FROM price_daily WHERE instrument_id = $1 AND trade_date < $2`, id, b)
		if err != nil {
			return nil, err
		}
		n := int(tag.RowsAffected())
		res.PerSymbol = append(res.PerSymbol, SymbolRows{Symbol: names[i], Rows: n})
		res.Deleted += n
		if n > 0 {
			affected = append(affected, names[i])
		}
	}
	if res.Deleted == 0 {
		return res, tx.Commit(ctx)
	}
	note := fmt.Sprintf("trimmed prices before %s for %d stocks, %d rows", b.Format(time.DateOnly), len(affected), res.Deleted)
	batchID, err := s.auditBatch(ctx, tx, res.Deleted, note)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	sort.Strings(affected)
	res.BatchID = &batchID
	res.JobID = s.queuePostImport(ctx, batchID, affected)
	return res, nil
}

// ---- batches ----

// Batch is one import_batch row.
type Batch struct {
	ID           int64      `json:"id"`
	Kind         string     `json:"kind"`
	UploadGroup  *string    `json:"upload_group"`
	RowCount     int        `json:"row_count"`
	WarningCount int        `json:"warning_count"`
	Note         *string    `json:"note"`
	CreatedAt    time.Time  `json:"created_at"`
	UndoneAt     *time.Time `json:"undone_at"`
}

// ListBatches returns up to limit+1 batches (newest first) with id below beforeID (0 = no bound);
// the extra row tells the caller whether another page exists.
func (s *Service) ListBatches(ctx context.Context, limit int, beforeID int64) ([]Batch, error) {
	if beforeID <= 0 {
		beforeID = math.MaxInt64
	}
	rows, err := s.pool.Query(ctx, `SELECT id, kind, upload_group::text, row_count, warning_count, note, created_at, undone_at
		FROM import_batch WHERE id < $1 ORDER BY id DESC LIMIT $2`, beforeID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Batch{}
	for rows.Next() {
		var b Batch
		if err := rows.Scan(&b.ID, &b.Kind, &b.UploadGroup, &b.RowCount, &b.WarningCount, &b.Note, &b.CreatedAt, &b.UndoneAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Undo refuses the kinds that can never be undone (prices, instruments: 409). Undo of the other
// kinds is part of B06b and answers 501 until then.
func (s *Service) Undo(ctx context.Context, id int64) error {
	var kind string
	var undone *time.Time
	err := s.pool.QueryRow(ctx, `SELECT kind, undone_at FROM import_batch WHERE id = $1`, id).Scan(&kind, &undone)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBatchNotFound
	}
	if err != nil {
		return err
	}
	if kind == KindPrices || kind == KindInstruments {
		return ErrNotUndoable
	}
	if undone != nil {
		return ErrConflict
	}
	return ErrKindNotBuilt
}
