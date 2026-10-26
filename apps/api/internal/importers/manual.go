package importers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Manual entry (docs/01 7.6, docs/03 section 14): single results periods, shareholding quarters and
// corporate actions. They use the very validators of the CSV importers (IMP-17), write rows with
// source 'manual', record an import_batch of kind 'manual_form' (note = "as per filing dated ...")
// and queue post_import for the stock.

// ErrNoManualPeriod: DELETE found no manual entry for the period.
var ErrNoManualPeriod = errors.New("importers: no manual entry for that period")

// ManualResult is the response of the manual-entry endpoints.
type ManualResult struct {
	BatchID         int64        `json:"batch_id"`
	ID              *int64       `json:"id,omitempty"` // corporate actions only
	Inserted        int          `json:"inserted"`
	Updated         int          `json:"updated"`
	Warnings        []FieldIssue `json:"warnings"`
	PostImportJobID *int64       `json:"post_import_job_id"`
}

// ResultsEntry is the body of POST /stocks/{symbol}/results. Values is keyed by template column
// (revenue, ebitda, ..., eps); an empty value is not stored.
type ResultsEntry struct {
	Basis, PeriodType, PeriodEnd string
	Values                       map[string]string
	Note                         string
}

type stockRef struct {
	ID     int32
	Symbol string
}

// lookupStock resolves the current symbol of a manual entry: unknown -> ErrSymbolNotFound, delisted
// -> a field error on symbol (IMP-18).
func (s *Service) lookupStock(ctx context.Context, symbol string) (stockRef, error) {
	sym := upperTrim(strings.TrimSpace(symbol))
	var ref stockRef
	var status string
	err := s.pool.QueryRow(ctx, `SELECT id, symbol, status FROM instrument WHERE symbol = $1`, sym).Scan(&ref.ID, &ref.Symbol, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ref, ErrSymbolNotFound
	}
	if err != nil {
		return ref, err
	}
	if status == "delisted" {
		return ref, validation("symbol", "symbol "+ref.Symbol+" is delisted; data cannot be entered for a delisted instrument")
	}
	return ref, nil
}

func checkNote(note string) error {
	if len([]rune(note)) > 500 {
		return validation("note", "must be at most 500 characters")
	}
	return nil
}

// writeManual runs one manual write in a transaction: batch row, rows through the sink, commit,
// then post_import for the stock.
func (s *Service) writeManual(ctx context.Context, ref stockRef, note string, rows int, warns []FieldIssue, write func(*ownerSink) error) (*ManualResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var batchID int64
	if err := tx.QueryRow(ctx, `INSERT INTO import_batch (kind, row_count, warning_count, note) VALUES ($1, $2, $3, NULLIF($4, '')) RETURNING id`,
		kindManualForm, rows, len(warns), note).Scan(&batchID); err != nil {
		return nil, err
	}
	sink := newOwnerSink(ctx, tx, batchID, "manual", s.chunkSize, nil, s.today())
	if err := write(sink); err != nil {
		return nil, err
	}
	if err := sink.flushAll(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	res := &ManualResult{BatchID: batchID, Inserted: sink.inserted, Updated: sink.updated, Warnings: warns}
	if res.Warnings == nil {
		res.Warnings = []FieldIssue{}
	}
	if len(sink.actionIDs) > 0 {
		id := sink.actionIDs[0]
		res.ID = &id
	}
	for _, d := range sink.dupes {
		res.Warnings = append(res.Warnings, issue("ex_date", WarnDuplicateExDateAction,
			fmt.Sprintf("another split or bonus (action id %d) already exists for %s on %s; the history is adjusted by the earliest one only", d.ID, d.Symbol, d.ExDate)))
	}
	var queued bool
	res.PostImportJobID, queued = s.queuePostImport(ctx, batchID, []string{ref.Symbol})
	if !queued {
		res.Warnings = append(res.Warnings, issue("post_import", WarnPostImportNotQueued, "the data is saved but analytics were not queued; import any file again or enqueue by hand"))
	}
	return res, nil
}

func valuesField(f string) string {
	if strings.Contains(f, ".") {
		return "values." + metricShortName(f)
	}
	return f
}

func fieldError(errs []FieldIssue, mapField func(string) string) *ValidationError {
	out := make([]FieldIssue, len(errs))
	for i, e := range errs {
		e.Field = mapField(e.Field)
		out[i] = e
	}
	return &ValidationError{Fields: out}
}

// AddResults is POST /stocks/{symbol}/results: one quarterly or annual period (P&L columns of 7.2).
// Re-entering a period restates it (FND-15): the manual values are overwritten and tagged with the
// new batch.
func (s *Service) AddResults(ctx context.Context, symbol string, in ResultsEntry) (*ManualResult, error) {
	if err := checkNote(in.Note); err != nil {
		return nil, err
	}
	ref, err := s.lookupStock(ctx, symbol)
	if err != nil {
		return nil, err
	}
	cells := map[string]string{}
	var unknown []FieldIssue
	// Go map order is random: keys that differ only by case or spaces would silently pick one.
	norm := map[string]string{}
	cols := make([]string, 0, len(in.Values))
	for col := range in.Values {
		cols = append(cols, col)
	}
	sort.Strings(cols)
	for _, col := range cols {
		k := strings.ToLower(strings.TrimSpace(col))
		if first, dup := norm[k]; dup {
			return nil, validation("values."+col, fmt.Sprintf("duplicate key: %q and %q are the same value; give it once", first, col))
		}
		norm[k] = col
	}
	for _, col := range cols {
		raw := in.Values[col]
		key := ""
		for _, d := range resultMetrics {
			if d.Col == strings.ToLower(strings.TrimSpace(col)) {
				key = d.Key
			}
		}
		if key == "" {
			unknown = append(unknown, issue("values."+col, "METRIC_UNKNOWN", fmt.Sprintf("unknown value %q; use revenue, ebitda, operating_income, other_income, interest, depreciation, pbt, tax, net_profit or eps", col)))
			continue
		}
		cells[key] = raw
	}
	n, errs, warns := ValidateFundamentals(FundamentalInput{Basis: in.Basis, PeriodType: in.PeriodType, PeriodEnd: in.PeriodEnd, Cells: cells}, s.today())
	errs = append(errs, unknown...)
	if len(errs) == 0 && len(n.Values) == 0 {
		errs = append(errs, issue("values", "REQUIRED", "give at least one value"))
	}
	if len(errs) > 0 {
		return nil, fieldError(errs, valuesField)
	}
	for i := range warns {
		warns[i].Field = valuesField(warns[i].Field)
	}
	op := fundOp{Inst: ref.ID, Sym: ref.Symbol, Period: n.NormalizedPeriod}
	for _, d := range resultMetrics {
		if v, ok := n.Values[d.Key]; ok {
			v := v
			op.Metrics = append(op.Metrics, metricVal{Key: d.Key, Unit: d.Unit, Val: &v})
		}
	}
	return s.writeManual(ctx, ref, in.Note, len(op.Metrics), warns, func(k *ownerSink) error { return k.addFund(op) })
}

// ShareholdingEntry is the body of POST /stocks/{symbol}/shareholding (the columns of 7.3).
type ShareholdingEntry struct {
	ShareholdingInput
	Note string
}

// AddShareholding is POST /stocks/{symbol}/shareholding.
func (s *Service) AddShareholding(ctx context.Context, symbol string, in ShareholdingEntry) (*ManualResult, error) {
	if err := checkNote(in.Note); err != nil {
		return nil, err
	}
	ref, err := s.lookupStock(ctx, symbol)
	if err != nil {
		return nil, err
	}
	n, errs, warns := ValidateShareholding(in.ShareholdingInput, s.today())
	if len(errs) > 0 {
		return nil, fieldError(errs, func(f string) string { return f })
	}
	return s.writeManual(ctx, ref, in.Note, 1, warns, func(k *ownerSink) error {
		return k.addShare(shareOp{Inst: ref.ID, Sym: ref.Symbol, N: n})
	})
}

// ActionEntry is the body of POST /stocks/{symbol}/actions (the columns of 7.4).
type ActionEntry struct {
	ActionInput
	Note string
}

// AddAction is POST /stocks/{symbol}/actions: a confirmed corporate action (ACT-09: a repeat of the
// same stock, ex-date, type and purpose updates the one row).
func (s *Service) AddAction(ctx context.Context, symbol string, in ActionEntry) (*ManualResult, error) {
	if err := checkNote(in.Note); err != nil {
		return nil, err
	}
	ref, err := s.lookupStock(ctx, symbol)
	if err != nil {
		return nil, err
	}
	n, errs, warns := ValidateAction(in.ActionInput)
	if len(errs) > 0 {
		return nil, fieldError(errs, func(f string) string { return f })
	}
	return s.writeManual(ctx, ref, in.Note, 1, warns, func(k *ownerSink) error {
		return k.addAction(actionOp{Inst: ref.ID, Sym: ref.Symbol, N: n})
	})
}

// DeleteResultsOutcome is the response of DELETE /stocks/{symbol}/results.
type DeleteResultsOutcome struct {
	Deleted         int    `json:"deleted"`
	BatchID         int64  `json:"batch_id"`
	PostImportJobID *int64 `json:"post_import_job_id"`
	// Warnings: POST_IMPORT_NOT_QUEUED when the queue failed after the delete (data is deleted).
	Warnings []string `json:"warnings"`
}

// DeleteResults removes the manual values of one period (docs/03 section 14); CSV-imported values
// of the same period are untouched. 404 when the period has no manual entry. An audit batch is written.
func (s *Service) DeleteResults(ctx context.Context, symbol, periodType, periodEnd, basis string) (*DeleteResultsOutcome, error) {
	var fields []FieldIssue
	pt := strings.ToUpper(strings.TrimSpace(periodType))
	if pt != periodQuarter && pt != periodAnnual {
		fields = append(fields, issue("period_type", "PERIOD_TYPE_INVALID", "period_type must be Q or A"))
	}
	b := strings.ToLower(strings.TrimSpace(basis))
	if b != basisConsolidated && b != basisStandalone {
		fields = append(fields, issue("basis", "BASIS_INVALID", "basis must be consolidated or standalone"))
	}
	end, perr := parseISO("period_end", periodEnd)
	if perr != nil {
		var ve *ValidationError
		if errors.As(perr, &ve) {
			fields = append(fields, ve.Fields...)
		}
	}
	if len(fields) > 0 {
		return nil, &ValidationError{Fields: fields}
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
	tag, err := tx.Exec(ctx, `DELETE FROM fundamental_value WHERE instrument_id = $1 AND basis = $2 AND period_type = $3
		AND period_end = $4 AND source = 'manual'`, id, b, pt, end)
	if err != nil {
		return nil, err
	}
	n := int(tag.RowsAffected())
	if n == 0 {
		return nil, ErrNoManualPeriod
	}
	note := fmt.Sprintf("deleted manual results %s %s %s %s, %d values", canon, b, pt, end.Format(time.DateOnly), n)
	batchID, err := s.auditBatch(ctx, tx, n, note)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := &DeleteResultsOutcome{Deleted: n, BatchID: batchID, Warnings: []string{}}
	var queued bool
	out.PostImportJobID, queued = s.queuePostImport(ctx, batchID, []string{canon})
	if !queued {
		out.Warnings = append(out.Warnings, WarnPostImportNotQueued)
	}
	return out, nil
}
