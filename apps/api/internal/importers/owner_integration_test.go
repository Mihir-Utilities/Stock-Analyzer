package importers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Integration tests of the B06b importers, manual entry and undo against Postgres 16.

func (e *tenv) sampleStocks() {
	e.t.Helper()
	e.mustCommit(KindInstruments, fixture(e.t, "import-samples/instruments.csv"))
}

func (e *tenv) postImportJobs() int {
	return e.count(`SELECT count(*) FROM refresh_job WHERE kind = 'post_import'`)
}

// The owner-format samples import end to end: validate writes nothing, commit tags every row with its
// batch, units follow the DB CHECK (D-Q), empty cells are not stored, post_import is queued, and the
// same file again is idempotent (IMP-10).
func TestOwnerSamplesImport(t *testing.T) {
	e := newEnv(t)
	e.sampleStocks()
	cases := []struct {
		kind, file string
		rows       int
	}{
		{KindResultsQuarterly, "import-samples/results_quarterly.csv", 24},
		{KindResultsAnnual, "import-samples/results_annual.csv", 9},
		{KindBalanceCashflow, "import-samples/balance_cashflow_annual.csv", 9},
		{KindShareholding, "import-samples/shareholding.csv", 12},
		{KindCorporateActions, "import-samples/corporate_actions.csv", 2},
		{KindInstrumentMeta, "import-samples/instrument_meta.csv", 3},
	}
	for _, c := range cases {
		sample := fixture(t, c.file)
		v := e.validate(c.kind, sample)
		if v.ErrorCount != 0 || v.Rows != c.rows || len(v.Preview) == 0 || v.EstimatedGrowthMB != nil || v.PricesAlreadyAdjusted != nil {
			t.Fatalf("%s validate: %+v", c.kind, v)
		}
		jobs := e.postImportJobs()
		r, err := e.commit(c.kind, v.UploadID)
		if err != nil || r.BatchID == 0 || r.Inserted+r.Updated == 0 || r.PostImportJobID == nil {
			t.Fatalf("%s commit: %+v %v", c.kind, r, err)
		}
		if e.postImportJobs() != jobs+1 {
			t.Errorf("%s: post_import must be queued after commit", c.kind)
		}
		again := e.mustCommit(c.kind, sample) // IMP-10
		if again.Inserted != 0 || again.Updated != r.Inserted+r.Updated {
			t.Errorf("%s second import: %+v after %+v", c.kind, again, r)
		}
	}
	if n := e.count(`SELECT count(*) FROM fundamental_value WHERE source = 'csv_import' AND import_batch_id IS NOT NULL`); n == 0 {
		t.Error("fundamental rows must carry source csv_import and the batch id")
	}
	if n := e.count(`SELECT count(*) FROM fundamental_value WHERE metric_key = 'pnl.eps' AND unit <> 'INR'`) +
		e.count(`SELECT count(*) FROM fundamental_value WHERE metric_key = 'bs.shares_outstanding' AND unit <> 'SHARES'`) +
		e.count(`SELECT count(*) FROM fundamental_value WHERE metric_key LIKE 'pnl.%' AND metric_key <> 'pnl.eps' AND unit <> 'INR_CR'`); n != 0 {
		t.Errorf("units differ from docs/05 section 2: %d", n)
	}
	if e.count(`SELECT count(*) FROM shareholding WHERE revision <> 0`) != 0 {
		t.Error("an identical re-import must not bump the revision")
	}
	if e.count(`SELECT count(*) FROM corporate_action WHERE status = 'confirmed' AND source = 'csv_import'`) != 2 {
		t.Error("imported actions are confirmed (docs/01 7.4)")
	}
	var sector string
	if e.count(`SELECT count(*) FROM index_constituent`) != 4 {
		t.Error("index_tags -> index_constituent")
	}
	if err := e.pool.QueryRow(context.Background(), `SELECT sector FROM instrument WHERE symbol = 'FAKEA'`).Scan(&sector); err != nil || sector != "Industrials" {
		t.Errorf("sector %q %v", sector, err)
	}
	// ACT-03 storage side: the split keeps its owner-format numbers (10 -> 2).
	if e.count(`SELECT count(*) FROM corporate_action WHERE action_type = 'split' AND ratio_num = 10 AND ratio_den = 2`) != 1 {
		t.Error("split ratio")
	}
}

// IMP-04: an empty wide cell stores nothing (never 0); an empty value in the long format is a NULL row.
func TestEmptyCellsStoredAsNull(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.mustCommit(KindResultsQuarterly, resHdr+"AAA,consolidated,2026-06-30,100,,,,,,,,,\n")
	if e.count(`SELECT count(*) FROM fundamental_value`) != 1 || e.count(`SELECT count(*) FROM fundamental_value WHERE value = 0`) != 0 {
		t.Error("only the revenue cell may be stored")
	}
	e.mustCommit(KindFundamentalsLong, longHdr+"AAA,consolidated,Q,2026-09-30,pnl.eps,,INR\nAAA,consolidated,Q,2026-09-30,pnl.revenue,5,\n")
	if e.count(`SELECT count(*) FROM fundamental_value WHERE period_end = '2026-09-30' AND metric_key = 'pnl.eps' AND value IS NULL`) != 1 {
		t.Error("an empty long value is stored as NULL")
	}
}

// IMP-11, IMP-12 and the no-partial-write rule for the B06b kinds.
func TestOwnerCommitGuards(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	bad := e.validate(KindShareholding, shareHdr+"AAA,2026-06-30,50,20,15,9,3,1,14,,,\nAAA,2026-06-15,1,,,,,,,,,\n")
	if bad.ErrorCount != 1 {
		t.Fatalf("%+v", bad)
	}
	var he *HasErrorsError
	if _, err := e.commit(KindShareholding, bad.UploadID); !errors.As(err, &he) || he.Count != 1 {
		t.Fatalf("IMP-11: %v", err)
	}
	if e.count(`SELECT count(*) FROM shareholding`) != 0 || e.count(`SELECT count(*) FROM import_batch`) != 0 {
		t.Error("a rejected commit writes nothing, not even the batch row")
	}
	if e.count(`SELECT count(*) FROM import_upload WHERE id = $1::uuid`, bad.UploadID) != 1 {
		t.Error("a rejected commit keeps the upload")
	}
	// A symbol removed between validate and commit is caught by the commit's re-validation.
	ok := e.validate(KindShareholding, shareHdr+"AAA,2026-06-30,50,20,15,9,3,1,14,,,\n")
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE symbol = 'AAA'`)
	if _, err := e.commit(KindShareholding, ok.UploadID); !errors.As(err, &he) {
		t.Errorf("re-validation at commit: %v", err)
	}
	e.exec(`UPDATE instrument SET status = 'active' WHERE symbol = 'AAA'`)

	// IMP-12: expiry.
	exp := e.validate(KindShareholding, shareHdr+"AAA,2026-06-30,50,20,15,9,3,1,14,,,\n")
	e.now.Store(e.svc.Now().Add(61 * time.Minute))
	if _, err := e.commit(KindShareholding, exp.UploadID); !errors.Is(err, ErrUploadNotFound) {
		t.Errorf("expired: %v", err)
	}
	e.now.Store(e.svc.Now().Add(-61 * time.Minute))

	// Groups of parts are for prices only.
	a, b := e.validate(KindHolidays, "date\n2026-01-26\n"), e.validate(KindHolidays, "date\n2026-08-14\n")
	var ve *ValidationError
	if _, err := e.svc.Commit(context.Background(), KindHolidays, CommitRequest{UploadIDs: []string{a.UploadID, b.UploadID}, UploadGroup: newUUID()}); !errors.As(err, &ve) {
		t.Errorf("group of holiday parts: %v", err)
	}

	// No partial writes: a failure after the first chunk rolls back everything, including the batch row.
	var sb strings.Builder
	sb.WriteString(shareHdr)
	for i := 0; i < 8; i++ {
		fmt.Fprintf(&sb, "AAA,%d-03-31,50,20,15,9,3,1,14,,,\n", 2000+i)
	}
	e.svc.chunkSize = 3
	hits := 0
	e.svc.afterChunk = func(n int) error {
		hits++
		if n == 2 {
			return errors.New("boom")
		}
		return nil
	}
	v := e.validate(KindShareholding, sb.String())
	if _, err := e.commit(KindShareholding, v.UploadID); err == nil || hits != 2 {
		t.Fatalf("hook: %v hits %d", err, hits)
	}
	if e.count(`SELECT count(*) FROM shareholding`) != 0 || e.count(`SELECT count(*) FROM import_batch`) != 0 {
		t.Error("partial write after a failed chunk")
	}
	e.svc.afterChunk = nil
	if r, err := e.commit(KindShareholding, v.UploadID); err != nil || r.Inserted != 8 {
		t.Errorf("the upload survives a failed commit and can be retried: %+v %v", r, err)
	}
}

// IMP-14: undo removes the batch's rows, does not restore overwritten values, is refused for prices,
// instruments, holidays, instrument_meta and manual batches, and works once within 30 days.
func TestUndo(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	ctx := context.Background()
	first := e.mustCommit(KindResultsQuarterly, resHdr+"AAA,consolidated,2026-06-30,100,,,,,,,,,\n")
	second := e.mustCommit(KindResultsQuarterly, resHdr+"AAA,consolidated,2026-06-30,150,,,,,,,,,\nBBB,consolidated,2026-06-30,70,,,,,,,,,\n")
	// The commit's own post_import job (target batch:<id>) is still active, so the undo's request is
	// deduplicated onto it (docs/04 3.12: one active job per target) and still returns its id.
	u, err := e.svc.Undo(ctx, second.BatchID)
	if err != nil || u.Removed != 2 || u.PostImportJobID == nil || *u.PostImportJobID != *second.PostImportJobID {
		t.Fatalf("undo: %+v %v", u, err)
	}
	if e.count(`SELECT count(*) FROM fundamental_value`) != 0 {
		t.Error("the undone batch's rows are removed, and the value it overwrote (100) is NOT restored")
	}
	if e.count(`SELECT count(*) FROM import_batch WHERE id = $1 AND undone_at IS NOT NULL`, second.BatchID) != 1 {
		t.Error("undone_at must be set")
	}
	if _, err := e.svc.Undo(ctx, second.BatchID); !errors.Is(err, ErrConflict) {
		t.Errorf("second undo: %v", err)
	}
	if _, err := e.svc.Undo(ctx, first.BatchID); err != nil {
		t.Errorf("the older batch has no tagged rows left and still undoes: %v", err)
	}

	// Shareholding and corporate actions are undoable too.
	sh := e.mustCommit(KindShareholding, shareHdr+"AAA,2026-06-30,50,20,15,9,3,1,14,,,\n")
	ac := e.mustCommit(KindCorporateActions, actHdr+"AAA,2026-02-10,split,10,2,,x\n")
	for _, id := range []int64{sh.BatchID, ac.BatchID} {
		if r, err := e.svc.Undo(ctx, id); err != nil || r.Removed != 1 {
			t.Errorf("undo %d: %+v %v", id, r, err)
		}
	}
	if e.count(`SELECT count(*) FROM shareholding`)+e.count(`SELECT count(*) FROM corporate_action`) != 0 {
		t.Error("rows remain")
	}

	// Not undoable.
	e.setAdjusted(false)
	pr := e.mustCommit(KindPrices, "symbol,date,open,high,low,close,volume\nAAA,2026-01-05,1,2,1,1,1\n")
	hol := e.mustCommit(KindHolidays, "date\n2026-01-26\n")
	meta := e.mustCommit(KindInstrumentMeta, "symbol,sector\nAAA,IT\n")
	man, err := e.svc.AddResults(ctx, "AAA", ResultsEntry{Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": "1"}})
	if err != nil {
		t.Fatal(err)
	}
	for name, id := range map[string]int64{"prices": pr.BatchID, "holidays": hol.BatchID, "instrument_meta": meta.BatchID, "manual": man.BatchID} {
		if _, err := e.svc.Undo(ctx, id); !errors.Is(err, ErrNotUndoable) {
			t.Errorf("%s: %v", name, err)
		}
	}

	// 30-day window.
	old := e.mustCommit(KindShareholding, shareHdr+"AAA,2026-03-31,50,20,15,9,3,1,14,,,\n")
	e.now.Store(e.svc.Now().Add(31 * 24 * time.Hour))
	if _, err := e.svc.Undo(ctx, old.BatchID); !errors.Is(err, ErrUndoExpired) {
		t.Errorf("expired window: %v", err)
	}
	if e.count(`SELECT count(*) FROM shareholding`) != 1 {
		t.Error("an expired undo removes nothing")
	}
}

// FND-15: a restated period re-entered by hand overwrites the manual values; the batch is the audit;
// a CSV-imported value of the same period coexists under its own source (manual wins on read, FND-17).
func TestManualResultsRestate(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	ctx := context.Background()
	e.mustCommit(KindResultsQuarterly, resHdr+"AAA,consolidated,2026-06-30,90,,,,,,,,,\n")
	entry := ResultsEntry{Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Note: "as per filing dated 2026-08-12",
		Values: map[string]string{"revenue": "100", "net_profit": "30", "eps": "1.5", "ebitda": ""}}
	r1, err := e.svc.AddResults(ctx, "aaa", entry)
	if err != nil || r1.Inserted != 3 || r1.Updated != 0 || r1.PostImportJobID == nil || len(r1.Warnings) != 0 {
		t.Fatalf("first entry: %+v %v", r1, err)
	}
	entry.Values["revenue"] = "110"
	r2, err := e.svc.AddResults(ctx, "AAA", entry)
	if err != nil || r2.Inserted != 0 || r2.Updated != 3 || r2.BatchID == r1.BatchID {
		t.Fatalf("restated entry: %+v %v", r2, err)
	}
	var v float64
	var batch int64
	if err := e.pool.QueryRow(ctx, `SELECT value, import_batch_id FROM fundamental_value WHERE metric_key = 'pnl.revenue' AND source = 'manual'`).Scan(&v, &batch); err != nil || v != 110 || batch != r2.BatchID {
		t.Errorf("manual revenue %v batch %d %v", v, batch, err)
	}
	if e.count(`SELECT count(*) FROM fundamental_value WHERE metric_key = 'pnl.revenue'`) != 2 {
		t.Error("the csv_import value of the same period stays under its own source")
	}
	var kind, note string
	if err := e.pool.QueryRow(ctx, `SELECT kind, note FROM import_batch WHERE id = $1`, r1.BatchID).Scan(&kind, &note); err != nil || kind != "manual_form" || note != "as per filing dated 2026-08-12" {
		t.Errorf("audit batch %q %q %v", kind, note, err)
	}
	// A warning (units) still saves and is returned with its field.
	w, err := e.svc.AddResults(ctx, "AAA", ResultsEntry{Basis: "consolidated", PeriodType: "A", PeriodEnd: "2026-03-31", Values: map[string]string{"revenue": "10", "net_profit": "50"}})
	if err != nil || len(w.Warnings) != 1 || w.Warnings[0].Field != "values.net_profit" || w.Warnings[0].Code != "NET_PROFIT_UNITS" {
		t.Errorf("warning: %+v %v", w, err)
	}
	// Errors name the form field (422 details.fields).
	var ve *ValidationError
	for name, in := range map[string]ResultsEntry{
		"quarter end": {Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-29", Values: map[string]string{"revenue": "1"}},
		"unknown key": {Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"sales": "1"}},
		"no values":   {Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": " "}},
		"bad basis":   {Basis: "x", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": "1"}},
		"comma":       {Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": "1234,56"}},
		"note":        {Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": "1"}, Note: strings.Repeat("x", 501)},
	} {
		if _, err := e.svc.AddResults(ctx, "AAA", in); !errors.As(err, &ve) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.svc.AddResults(ctx, "AAA", ResultsEntry{Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-29", Values: map[string]string{"revenue": "bad"}}); !errors.As(err, &ve) || len(ve.Fields) != 2 ||
		ve.Fields[1].Field != "values.revenue" {
		t.Errorf("fields: %+v", ve)
	}

	// DELETE removes only the manual values (404 when there are none), with an audit row and a job.
	d, err := e.svc.DeleteResults(ctx, "AAA", "Q", "2026-06-30", "consolidated")
	if err != nil || d.Deleted != 3 || d.PostImportJobID == nil {
		t.Fatalf("delete: %+v %v", d, err)
	}
	if e.count(`SELECT count(*) FROM fundamental_value WHERE period_type = 'Q' AND source = 'csv_import'`) != 1 {
		t.Error("csv_import values must survive")
	}
	if _, err := e.svc.DeleteResults(ctx, "AAA", "Q", "2026-06-30", "consolidated"); !errors.Is(err, ErrNoManualPeriod) {
		t.Errorf("second delete: %v", err)
	}
	if _, err := e.svc.DeleteResults(ctx, "AAA", "X", "nope", "y"); !errors.As(err, &ve) || len(ve.Fields) != 3 {
		t.Errorf("delete validation: %v", err)
	}
	if _, err := e.svc.DeleteResults(ctx, "NOPE", "Q", "2026-06-30", "consolidated"); !errors.Is(err, ErrSymbolNotFound) {
		t.Errorf("unknown symbol: %v", err)
	}
}

// IMP-18, SHP-05, SHP-02, ACT-09, ACT-10 through the manual forms.
func TestManualShareholdingAndActions(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "GONE")
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE symbol = 'GONE'`)
	ctx := context.Background()
	var ve *ValidationError

	// IMP-18: unknown -> not found; delisted -> a field error on symbol.
	sh := ShareholdingEntry{ShareholdingInput: ShareholdingInput{QuarterEnd: "2026-06-30", Promoter: "50", FII: "20", DII: "15", MF: "9", Insurance: "3", Govt: "1", Public: "14"}}
	if _, err := e.svc.AddShareholding(ctx, "NOPE", sh); !errors.Is(err, ErrSymbolNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if _, err := e.svc.AddShareholding(ctx, "GONE", sh); !errors.As(err, &ve) || ve.Fields[0].Field != "symbol" || !strings.Contains(ve.Fields[0].Message, "delisted") {
		t.Errorf("delisted: %v", err)
	}
	if _, err := e.svc.AddAction(ctx, "GONE", ActionEntry{ActionInput: ActionInput{ExDate: "2026-02-10", Type: "dividend", Amount: "1"}}); !errors.As(err, &ve) {
		t.Errorf("delisted action: %v", err)
	}

	// SHP-05: a non-quarter-end date is rejected.
	bad := sh
	bad.QuarterEnd = "2026-06-15"
	if _, err := e.svc.AddShareholding(ctx, "AAA", bad); !errors.As(err, &ve) || ve.Fields[0].Field != "quarter_end" {
		t.Errorf("SHP-05: %v", err)
	}
	r, err := e.svc.AddShareholding(ctx, "AAA", sh)
	if err != nil || r.Inserted != 1 || r.PostImportJobID == nil {
		t.Fatalf("shareholding: %+v %v", r, err)
	}
	var pledged *float64
	var rev int
	var src string
	q := func() {
		if err := e.pool.QueryRow(ctx, `SELECT promoter_pledged_pct, revision, source FROM shareholding`).Scan(&pledged, &rev, &src); err != nil {
			t.Fatal(err)
		}
	}
	if q(); pledged != nil || rev != 0 || src != "manual" {
		t.Errorf("SHP-02: blank pledge is NULL, got %v rev %d src %s", pledged, rev, src)
	}
	if r, err = e.svc.AddShareholding(ctx, "AAA", sh); err != nil || r.Updated != 1 {
		t.Fatalf("same values again: %+v %v", r, err)
	}
	if q(); rev != 0 {
		t.Errorf("identical restatement must not bump revision: %d", rev)
	}
	sh.Pledged = "0"
	if _, err = e.svc.AddShareholding(ctx, "AAA", sh); err != nil {
		t.Fatal(err)
	}
	if q(); pledged == nil || *pledged != 0 || rev != 1 {
		t.Errorf("changed restatement: pledged %v rev %d", pledged, rev)
	}

	// ACT-09 / ACT-10: one row per (stock, ex_date, type, purpose); a future ex-date is stored.
	act := ActionEntry{ActionInput: ActionInput{ExDate: "2027-03-15", Type: "split", RatioNum: "10", RatioDen: "2", Purpose: "FV 10 to 2"}, Note: "board approval"}
	a1, err := e.svc.AddAction(ctx, "AAA", act)
	if err != nil || a1.ID == nil || a1.Inserted != 1 {
		t.Fatalf("action: %+v %v", a1, err)
	}
	act.RatioDen = "5"
	a2, err := e.svc.AddAction(ctx, "AAA", act)
	if err != nil || a2.ID == nil || *a2.ID != *a1.ID || a2.Updated != 1 {
		t.Fatalf("repeat: %+v %v", a2, err)
	}
	if e.count(`SELECT count(*) FROM corporate_action WHERE ratio_den = 5 AND status = 'confirmed' AND source = 'manual' AND ex_date = '2027-03-15'`) != 1 {
		t.Error("ACT-09/ACT-10")
	}
	if _, err := e.svc.AddAction(ctx, "AAA", ActionEntry{ActionInput: ActionInput{ExDate: "2026-02-10", Type: "bonus", RatioNum: "1"}}); !errors.As(err, &ve) || ve.Fields[0].Field != "ratio_num" {
		t.Errorf("bonus without den: %v", err)
	}
}

// IMP-27: holidays import with replace-per-year, weekend warning, not undoable, no example dates; the
// shipped 2026 list stays empty.
func TestHolidaysImport(t *testing.T) {
	e := newEnv(t)
	e.exec(`INSERT INTO market_holiday (holiday_date, segment, description, source) VALUES
		('2026-01-26','trading','Republic Day (typo)','import'), ('2026-03-03','trading','Seeded','seed'), ('2026-03-03','clearing','Seeded clearing','seed'),
		('2025-12-25','trading','Christmas 2025','seed')`)
	csv := "date,description,segment\n2026-01-26,Republic Day,\n2026-08-14,Test holiday,trading\n2026-08-14,,clearing\n2026-08-16,A Sunday,trading\n"
	v := e.validate(KindHolidays, csv)
	if v.ErrorCount != 0 || v.WarningCount != 1 || v.Rows != 4 || len(v.Preview) != 4 {
		t.Fatalf("validate: %+v", v)
	}
	if e.count(`SELECT count(*) FROM market_holiday`) != 4 {
		t.Fatal("validate must not write")
	}
	r, err := e.commit(KindHolidays, v.UploadID)
	if err != nil || r.Inserted != 3 || r.Updated != 1 || r.PostImportJobID != nil {
		t.Fatalf("commit: %+v %v", r, err)
	}
	if e.count(`SELECT count(*) FROM market_holiday WHERE extract(year FROM holiday_date) = 2026`) != 4 {
		t.Error("2026 must be exactly the file's rows (the seeded 3 March rows are replaced)")
	}
	if e.count(`SELECT count(*) FROM market_holiday WHERE holiday_date = '2026-01-26' AND description = 'Republic Day' AND source = 'import'`) != 1 ||
		e.count(`SELECT count(*) FROM market_holiday WHERE holiday_date = '2025-12-25'`) != 1 {
		t.Error("the typo is corrected; other years are untouched")
	}
	if e.count(`SELECT count(*) FROM market_holiday WHERE segment = 'clearing'`) != 1 {
		t.Error("segments")
	}
	if again := e.mustCommit(KindHolidays, csv); again.Inserted != 0 || again.Updated != 4 {
		t.Errorf("re-import: %+v", again)
	}
	if _, err := e.svc.Undo(context.Background(), r.BatchID); !errors.Is(err, ErrNotUndoable) {
		t.Errorf("holidays are not undoable: %v", err)
	}
	// The shipped reference file has no invented dates and the template has no example rows.
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "config", "market_holidays.json")) //nolint:gosec // repository file
	if err != nil || !strings.Contains(string(raw), `"2026": []`) {
		t.Errorf("config/market_holidays.json must keep the 2026 list empty: %v", err)
	}
}

// instrument_meta: sector/industry/company_type update, an empty cell keeps the stored value, a
// non-empty index_tags cell replaces the stock's memberships.
func TestInstrumentMetaImport(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	e.mustCommit(KindInstrumentMeta, "symbol,sector,industry,company_type,index_tags\nAAA,IT,Services,general,NIFTY50|NIFTY100\nBBB,Banks,Private,financial,NIFTY50\n")
	r := e.mustCommit(KindInstrumentMeta, "symbol,sector,industry,company_type,index_tags\nAAA,,Software,,NIFTY100|NEXT50\nBBB,,,,\n")
	if r.Updated != 2 || r.Inserted != 0 || r.PostImportJobID == nil {
		t.Errorf("%+v", r)
	}
	var sector, industry, ctype string
	if err := e.pool.QueryRow(context.Background(), `SELECT sector, industry, company_type FROM instrument WHERE symbol = 'AAA'`).Scan(&sector, &industry, &ctype); err != nil ||
		sector != "IT" || industry != "Software" || ctype != "general" {
		t.Errorf("%q %q %q %v", sector, industry, ctype, err)
	}
	if e.count(`SELECT count(*) FROM index_constituent ic JOIN instrument i ON i.id = ic.instrument_id WHERE i.symbol = 'AAA' AND ic.index_name IN ('NIFTY100','NEXT50')`) != 2 ||
		e.count(`SELECT count(*) FROM index_constituent ic JOIN instrument i ON i.id = ic.instrument_id WHERE i.symbol = 'AAA' AND ic.index_name = 'NIFTY50'`) != 0 ||
		e.count(`SELECT count(*) FROM index_constituent ic JOIN instrument i ON i.id = ic.instrument_id WHERE i.symbol = 'BBB'`) != 1 {
		t.Error("memberships: AAA replaced, BBB untouched by an empty cell")
	}
}

// Chunked writes (IMP-22 style) for a B06b kind: more rows than one chunk, one transaction.
func TestOwnerChunking(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.svc.chunkSize = 100
	chunks := 0
	e.svc.afterChunk = func(int) error { chunks++; return nil }
	var sb strings.Builder
	sb.WriteString(longHdr)
	// 30 past fiscal years x 9 metrics = 270 rows (the 1990 date floor and the future-date rule cap the years).
	keys := []string{"revenue", "ebitda", "operating_income", "other_income", "interest", "depreciation", "pbt", "tax", "net_profit"}
	for y := 0; y < 30; y++ {
		for k, key := range keys {
			fmt.Fprintf(&sb, "AAA,consolidated,A,%d-03-31,pnl.%s,%d,\n", 1995+y, key, y*10+k+1)
		}
	}
	r := e.mustCommit(KindFundamentalsLong, sb.String())
	if r.Inserted != 270 || chunks != 3 || e.count(`SELECT count(*) FROM fundamental_value`) != 270 {
		t.Errorf("%+v chunks %d", r, chunks)
	}
}
