package importers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/jobs"
	"github.com/india-analyzer/api/internal/testdb"
)

type tenv struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	jobs *jobs.Service
	now  atomic.Value // time.Time
}

func newEnv(t *testing.T) *tenv {
	t.Helper()
	dsn := testdb.New(t)
	if err := testdb.Migrate(testdb.OpenSQL(t, dsn), testdb.MigrationsDir()); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	e := &tenv{t: t, pool: pool}
	e.now.Store(time.Date(2026, 10, 24, 6, 30, 0, 0, time.UTC))
	e.jobs = jobs.New(pool, nil, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: 30}, zerolog.Nop())
	e.svc = New(pool, e.jobs, 380, zerolog.Nop())
	e.svc.Now = func() time.Time { return e.now.Load().(time.Time) }
	e.svc.DBSize = func(context.Context) (int64, error) { return 10 << 20, nil }
	return e
}

func (e *tenv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *tenv) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (e *tenv) stocks(symbols ...string) {
	for _, s := range symbols {
		e.exec(`INSERT INTO instrument (symbol, name) VALUES ($1, $2)`, s, s+" Ltd")
	}
}

func (e *tenv) validate(kind, csv string) *ValidateResult {
	e.t.Helper()
	r, err := e.svc.Validate(context.Background(), kind, []byte(csv), "")
	if err != nil {
		e.t.Fatalf("validate: %v", err)
	}
	return r
}

func (e *tenv) commit(kind string, ids ...string) (*CommitResult, error) {
	return e.svc.Commit(context.Background(), kind, CommitRequest{UploadIDs: ids, Note: "test"})
}

func (e *tenv) mustCommit(kind, csv string) *CommitResult {
	e.t.Helper()
	v := e.validate(kind, csv)
	if v.ErrorCount != 0 {
		e.t.Fatalf("validate errors: %+v", v.Errors)
	}
	r, err := e.commit(kind, v.UploadID)
	if err != nil {
		e.t.Fatalf("commit: %v", err)
	}
	return r
}

func (e *tenv) setAdjusted(v bool) {
	e.t.Helper()
	if _, err := e.svc.SetPricesAdjustment(context.Background(), v, true); err != nil {
		e.t.Fatal(err)
	}
}

// compact removes the spaces jsonb adds, so assertions can match fragments.
func compact(b []byte) string { return strings.ReplaceAll(string(b), " ", "") }

func fixture(t *testing.T, rel string) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "fixtures", rel)) //nolint:gosec // test fixture path
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// IMP-20, IMP-10, IMP-04: the owner-format sample imports; upsert never touches sector, industry or
// company_type, never deletes; the batch is not undoable.
func TestInstrumentsImport(t *testing.T) {
	e := newEnv(t)
	sample := fixture(t, "import-samples/instruments.csv")
	v := e.validate(KindInstruments, sample)
	if v.ErrorCount != 0 || v.Rows != 3 || len(v.Preview) != 3 || v.EstimatedGrowthMB != nil || v.PricesAlreadyAdjusted != nil {
		t.Fatalf("validate %+v", v)
	}
	if e.count(`SELECT count(*) FROM instrument`) != 0 {
		t.Fatal("validate must not write")
	}
	r, err := e.commit(KindInstruments, v.UploadID)
	if err != nil || r.Inserted != 3 || r.Updated != 0 || r.PostImportJobID != nil {
		t.Fatalf("commit %+v %v", r, err)
	}
	e.exec(`UPDATE instrument SET sector='Metals', industry='Steel', company_type='financial' WHERE symbol='FAKEA'`)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('KEEP', 'Not in the file')`)
	r2 := e.mustCommit(KindInstruments, strings.Replace(sample, "Fake Alpha Limited", "Fake Alpha Renamed Ltd", 1)) // IMP-10: same file again
	if r2.Inserted != 0 || r2.Updated != 3 {
		t.Fatalf("second import %+v", r2)
	}
	var name, sector, industry, ctype string
	if err := e.pool.QueryRow(context.Background(), `SELECT name, sector, industry, company_type FROM instrument WHERE symbol='FAKEA'`).Scan(&name, &sector, &industry, &ctype); err != nil {
		t.Fatal(err)
	}
	if name != "Fake Alpha Renamed Ltd" || sector != "Metals" || industry != "Steel" || ctype != "financial" {
		t.Errorf("update overwrote owner meta: %s %s %s %s", name, sector, industry, ctype)
	}
	if e.count(`SELECT count(*) FROM instrument`) != 4 {
		t.Error("an instruments import must never delete instruments")
	}
	if e.count(`SELECT count(*) FROM import_upload`) != 0 {
		t.Error("the upload row must be deleted on commit")
	}
	// IMP-04: an empty optional cell keeps the stored value instead of writing NULL or a default.
	e.exec(`UPDATE instrument SET isin='INE000000012', face_value=5, series='BE' WHERE symbol='FAKEB'`)
	e.mustCommit(KindInstruments, "symbol,name,isin,series,face_value\nFAKEB,Fake Beta,,,\n")
	var isin, series string
	var face float64
	_ = e.pool.QueryRow(context.Background(), `SELECT isin, series, face_value::float8 FROM instrument WHERE symbol='FAKEB'`).Scan(&isin, &series, &face)
	if isin != "INE000000012" || series != "BE" || face != 5 {
		t.Errorf("empty cells overwrote stored values: %s %s %v", isin, series, face)
	}
	// Not undoable (409 at the API).
	var id int64
	_ = e.pool.QueryRow(context.Background(), `SELECT max(id) FROM import_batch WHERE kind='instruments'`).Scan(&id)
	if _, err := e.svc.Undo(context.Background(), id); !errors.Is(err, ErrNotUndoable) {
		t.Errorf("undo: %v", err)
	}
	if _, err := e.svc.Undo(context.Background(), 9999); !errors.Is(err, ErrBatchNotFound) {
		t.Errorf("undo missing: %v", err)
	}
}

// INS-14: previous_symbol renames the instrument and records the alias; history is kept.
func TestInstrumentRename(t *testing.T) {
	e := newEnv(t)
	e.stocks("OLDCO", "TAKEN")
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source)
		SELECT id, '2026-01-05', 1, 2, 1, 1, 1, 'import' FROM instrument WHERE symbol='OLDCO'`)
	e.exec(`INSERT INTO watchlist_item (instrument_id) SELECT id FROM instrument WHERE symbol='OLDCO'`)
	var id int32
	_ = e.pool.QueryRow(context.Background(), `SELECT id FROM instrument WHERE symbol='OLDCO'`).Scan(&id)

	v := e.validate(KindInstruments, hdrI+"NEWCO,New Co Ltd,,,,,,OLDCO,\nZ1,Zed,,,,,,NOSUCH,\nTAKEN,Taken Co,,,,,,NEWCO,\n")
	if v.WarningCount != 2 || v.ErrorCount != 0 {
		t.Fatalf("validate: %+v", v)
	}
	if v.Preview[0]["action"] != "rename" {
		t.Errorf("preview %v", v.Preview[0])
	}
	r, err := e.commit(KindInstruments, v.UploadID)
	if err != nil || r.Renamed != 1 {
		t.Fatalf("commit %+v %v", r, err)
	}
	var sym, name string
	_ = e.pool.QueryRow(context.Background(), `SELECT symbol, name FROM instrument WHERE id=$1`, id).Scan(&sym, &name)
	if sym != "NEWCO" || name != "New Co Ltd" {
		t.Errorf("renamed instrument: %s %s", sym, name)
	}
	if e.count(`SELECT count(*) FROM symbol_alias WHERE instrument_id=$1 AND old_symbol='OLDCO' AND changed_on=DATE '2026-10-24'`, id) != 1 {
		t.Error("alias missing")
	}
	if e.count(`SELECT count(*) FROM price_daily WHERE instrument_id=$1`, id) != 1 || e.count(`SELECT count(*) FROM watchlist_item WHERE instrument_id=$1`, id) != 1 {
		t.Error("history and links must be kept")
	}
	if e.count(`SELECT count(*) FROM instrument WHERE symbol IN ('OLDCO')`) != 0 {
		t.Error("old symbol must be gone")
	}
	// "no match" and "new symbol taken" are ignored: Z1 inserted, TAKEN updated, no extra alias.
	if e.count(`SELECT count(*) FROM instrument WHERE symbol='Z1'`) != 1 || e.count(`SELECT count(*) FROM symbol_alias`) != 1 {
		t.Error("ignored previous_symbol must not create aliases")
	}
	var tname string
	_ = e.pool.QueryRow(context.Background(), `SELECT name FROM instrument WHERE symbol='TAKEN'`).Scan(&tname)
	if tname != "Taken Co" {
		t.Errorf("TAKEN row not updated: %s", tname)
	}
	// Prices under the old symbol now point to the new one instead of silently matching.
	pv := e.validate(KindPrices, hdrP+"OLDCO,2026-01-06,1,2,1,1,1\n")
	if pv.ErrorCount != 1 || !strings.Contains(pv.Errors[0].Message, "renamed to NEWCO") {
		t.Errorf("old symbol in prices: %+v", pv.Errors)
	}
}

const twoStocks = "symbol,date,open,high,low,close,volume\nAAA,2026-01-05,100,102,99,101,1000\nAAA,2026-01-06,101,103,100,102,1100\nBBB,2026-01-05,50,51,49,50.5,500\n"

// IMP-25, IMP-10, D-B: required raw/adjusted choice, src_adjusted per bar, tracking, post_import.
func TestPricesCommitAdjustmentGate(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	e.exec(`UPDATE instrument SET is_tracked=true, tracked_reason='watchlist' WHERE symbol='BBB'`)

	v := e.validate(KindPrices, twoStocks)
	if v.PricesAlreadyAdjusted != nil || v.EstimatedGrowthMB == nil || v.Rows != 3 {
		t.Fatalf("validate %+v", v)
	}
	if want := roundTo(3*130.0/float64(1<<20), 2); *v.EstimatedGrowthMB != want {
		t.Errorf("growth %v want %v", *v.EstimatedGrowthMB, want)
	}
	if _, err := e.commit(KindPrices, v.UploadID); !errors.Is(err, ErrAdjustmentUnset) {
		t.Fatalf("expected PRICES_ADJUSTMENT_UNSET, got %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 || e.count(`SELECT count(*) FROM import_upload`) != 1 {
		t.Fatal("a blocked commit must write nothing and keep the upload")
	}
	// "I don't know" persists nothing: validate and the adjustment check never set the setting.
	if s, _ := e.svc.PricesAdjustment(context.Background()); s.Value != nil {
		t.Fatal("setting must stay unset")
	}
	if _, err := e.svc.SetPricesAdjustment(context.Background(), false, false); err != nil { // raw
		t.Fatal(err)
	}
	r, err := e.commit(KindPrices, v.UploadID)
	if err != nil || r.Inserted != 3 || r.Updated != 0 || r.PostImportJobID == nil {
		t.Fatalf("commit %+v %v", r, err)
	}
	if e.count(`SELECT count(*) FROM price_daily WHERE source='import' AND NOT src_adjusted AND adj_close = close`) != 3 {
		t.Error("raw bars: src_adjusted=false, adj_close=close until the worker re-adjusts")
	}
	if e.count(`SELECT count(*) FROM instrument WHERE symbol='AAA' AND is_tracked AND tracked_reason='imported'`) != 1 ||
		e.count(`SELECT count(*) FROM instrument WHERE symbol='BBB' AND tracked_reason='watchlist'`) != 1 {
		t.Error("tracking: imported for new, watchlist reason kept")
	}
	// post_import queued for batch:<id> with the ordered symbol list (B09 notes).
	job, err := e.jobs.Get(context.Background(), *r.PostImportJobID)
	if err != nil || job.Kind != "post_import" || job.Target != fmt.Sprintf("batch:%d", r.BatchID) ||
		!strings.Contains(compact(job.Result), `"remaining":["AAA","BBB"]`) || !strings.Contains(compact(job.Result), `"symbols_total":2`) {
		t.Fatalf("job %+v %v", job, err)
	}
	// IMP-10: the same file again is an idempotent upsert; later commits do not re-ask.
	r2 := e.mustCommit(KindPrices, twoStocks)
	if r2.Inserted != 0 || r2.Updated != 3 || e.count(`SELECT count(*) FROM price_daily`) != 3 {
		t.Fatalf("idempotent re-import: %+v", r2)
	}
	// Changing the choice needs confirm; existing bars keep their own src_adjusted.
	if _, err := e.svc.SetPricesAdjustment(context.Background(), true, false); !errors.Is(err, ErrConfirmChange) {
		t.Fatalf("expected confirm requirement, got %v", err)
	}
	if _, err := e.svc.SetPricesAdjustment(context.Background(), false, false); err != nil {
		t.Errorf("re-sending the same value needs no confirm: %v", err)
	}
	e.setAdjusted(true)
	e.mustCommit(KindPrices, hdrP+"AAA,2026-01-07,102,104,101,103,900\n")
	if e.count(`SELECT count(*) FROM price_daily WHERE src_adjusted`) != 1 || e.count(`SELECT count(*) FROM price_daily WHERE NOT src_adjusted`) != 3 {
		t.Error("src_adjusted must be the setting at import time, per bar")
	}
	if s, _ := e.svc.PricesAdjustment(context.Background()); s.Value == nil || !*s.Value || s.SetAt == nil {
		t.Errorf("setting %+v", s)
	}
}

// IMP-21: reserved NIFTY50/INDIAVIX go to market_series with the close only.
func TestReservedSymbolsToMarketSeries(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)
	r := e.mustCommit(KindPrices, hdrP+"NIFTY50,2026-01-05,,,,22000.5,\nNIFTY50,2026-01-06,0,0,0,30000,0\nINDIAVIX,2026-01-05,,,,13.25,\nAAA,2026-01-05,1,2,1,1,1\n")
	if r.Inserted != 4 {
		t.Fatalf("%+v", r)
	}
	if e.count(`SELECT count(*) FROM market_series`) != 3 || e.count(`SELECT count(*) FROM price_daily`) != 1 || e.count(`SELECT count(*) FROM instrument`) != 1 {
		t.Error("reserved symbols must not create instruments or price rows")
	}
	if e.count(`SELECT count(*) FROM market_series WHERE code='NIFTY50' AND trade_date='2026-01-06' AND value=30000`) != 1 {
		t.Error("the 50% day-change rule is skipped for market series")
	}
	job, _ := e.jobs.Get(context.Background(), *r.PostImportJobID)
	if !strings.Contains(compact(job.Result), `"remaining":["AAA"]`) {
		t.Errorf("only stock symbols are queued: %s", job.Result)
	}
	// Only market series: no stock symbols, so no post_import job.
	r = e.mustCommit(KindPrices, hdrP+"NIFTY50,2026-01-07,,,,22100,\n")
	if r.PostImportJobID != nil {
		t.Error("no job for a market-series-only import")
	}
}

// IMP-11: commit with errors is rejected and keeps the upload; IMP-12/IMP-24: upload lifecycle.
func TestUploadLifecycle(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)

	bad := e.validate(KindPrices, hdrP+"AAA,2026-01-05,1,2,1,1,1\nZZZ,2026-01-05,1,2,1,1,1\n")
	if bad.ErrorCount != 1 || bad.Errors[0].Row != 3 || bad.Errors[0].Column != "symbol" {
		t.Fatalf("errors %+v", bad.Errors)
	}
	var he *HasErrorsError
	if _, err := e.commit(KindPrices, bad.UploadID); !errors.As(err, &he) || he.Count != 1 {
		t.Fatalf("IMP-11: %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 || e.count(`SELECT count(*) FROM import_upload WHERE id=$1::uuid`, bad.UploadID) != 1 {
		t.Fatal("rejected commit must not write or consume the upload")
	}

	// IMP-24: a new Service over the same database (an API restart) can commit the stored upload.
	ok := e.validate(KindPrices, hdrP+"AAA,2026-01-05,1,2,1,1,1\n")
	restarted := New(e.pool, e.jobs, 380, zerolog.Nop())
	restarted.Now = e.svc.Now
	restarted.DBSize = e.svc.DBSize
	if _, err := restarted.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: []string{ok.UploadID}}); err != nil {
		t.Fatalf("commit after restart: %v", err)
	}
	if e.count(`SELECT count(*) FROM import_upload WHERE id=$1::uuid`, ok.UploadID) != 0 {
		t.Error("upload row must be deleted on commit")
	}
	if _, err := e.commit(KindPrices, ok.UploadID); !errors.Is(err, ErrUploadNotFound) {
		t.Errorf("second commit of the same upload: %v", err)
	}

	// IMP-12: after 1 h the upload is gone (404) and the next validate removes expired rows.
	exp := e.validate(KindPrices, hdrP+"AAA,2026-01-06,1,2,1,1,1\n")
	e.now.Store(e.svc.Now().Add(61 * time.Minute))
	if _, err := e.commit(KindPrices, exp.UploadID); !errors.Is(err, ErrUploadNotFound) {
		t.Errorf("expired upload: %v", err)
	}
	e.validate(KindPrices, hdrP+"AAA,2026-01-06,1,2,1,1,1\n")
	if e.count(`SELECT count(*) FROM import_upload WHERE id=$1::uuid`, exp.UploadID) != 0 {
		t.Error("expired uploads are removed")
	}
	if _, err := e.commit(KindPrices, "not-a-uuid"); !errors.Is(err, ErrUploadNotFound) {
		t.Errorf("bad id: %v", err)
	}
	// An upload validated for another kind cannot be committed as prices.
	inst := e.validate(KindInstruments, hdrI+"NEW1,New One,,,,,,,\n")
	var ve *ValidationError
	if _, err := e.commit(KindPrices, inst.UploadID); !errors.As(err, &ve) {
		t.Errorf("kind mismatch: %v", err)
	}
	if _, err := e.commit(KindPrices); !errors.As(err, &ve) {
		t.Errorf("no upload id: %v", err)
	}
	if _, err := e.commit("results_quarterly", inst.UploadID); !errors.As(err, &ve) {
		t.Errorf("an instruments upload cannot be committed as results: %v", err)
	}
	if _, err := e.commit("nonsense", inst.UploadID); !errors.Is(err, ErrKindNotBuilt) {
		t.Errorf("unknown kind: %v", err)
	}
}

// Browser-split large file (D-G): all parts commit in one transaction under one batch.
func TestUploadGroupCommit(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)
	grp := newUUID()
	var ids []string
	for _, d := range []string{"05", "06", "07"} {
		v, err := e.svc.Validate(context.Background(), KindPrices, []byte(hdrP+"AAA,2026-01-"+d+",1,2,1,1,1\n"), grp)
		if err != nil || v.UploadGroup == nil || *v.UploadGroup != grp {
			t.Fatalf("validate part: %+v %v", v, err)
		}
		ids = append(ids, v.UploadID)
	}
	if _, err := e.svc.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: ids}); err == nil {
		t.Fatal("several uploads need upload_group")
	}
	// A missing part rolls everything back, including the parts that existed.
	missing := append(append([]string{}, ids...), newUUID())
	if _, err := e.svc.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: missing, UploadGroup: grp}); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("missing part: %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 || e.count(`SELECT count(*) FROM import_upload`) != 3 {
		t.Fatal("nothing written and the parts survive")
	}
	r, err := e.svc.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: ids, UploadGroup: grp})
	if err != nil || r.Inserted != 3 {
		t.Fatalf("group commit %+v %v", r, err)
	}
	if e.count(`SELECT count(*) FROM import_batch WHERE kind='prices' AND upload_group=$1::uuid`, grp) != 1 {
		t.Error("one batch for the group")
	}
}

// IMP-22: chunked, atomic commit. A failure at the last chunk rolls everything back.
func TestPricesRollbackOnLastChunk(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	e.setAdjusted(false)
	e.svc.chunkSize = 1000
	var b strings.Builder
	b.WriteString(hdrP)
	start := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, sym := range []string{"AAA", "BBB"} {
		d := start
		for n := 0; n < 2750; { // 5,500 rows = 6 chunks of 1,000 (the last holds 500)
			if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
				fmt.Fprintf(&b, "%s,%s,100,101,99,100.5,1000\n", sym, d.Format(time.DateOnly))
				n++
			}
			d = d.AddDate(0, 0, 1)
		}
	}
	v := e.validate(KindPrices, b.String())
	if v.ErrorCount != 0 || v.Rows != 5500 {
		t.Fatalf("validate: %d errors, %d rows (%v)", v.ErrorCount, v.Rows, v.Errors)
	}
	var chunks int
	e.svc.afterChunk = func(n int) error {
		chunks = n
		if n == 6 {
			return errors.New("injected failure at the last chunk")
		}
		return nil
	}
	if _, err := e.commit(KindPrices, v.UploadID); err == nil {
		t.Fatal("expected failure")
	}
	if chunks != 6 {
		t.Fatalf("chunks flushed: %d", chunks)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 || e.count(`SELECT count(*) FROM import_batch`) != 0 ||
		e.count(`SELECT count(*) FROM instrument WHERE is_tracked`) != 0 || e.count(`SELECT count(*) FROM import_upload`) != 1 {
		t.Fatal("a failed commit must leave no partial writes")
	}
	e.svc.afterChunk = nil
	r, err := e.commit(KindPrices, v.UploadID)
	if err != nil || r.Inserted != 5500 {
		t.Fatalf("retry: %+v %v", r, err)
	}
}

// IMP-22: a 300,000-row file (the 25 MB class) streams and commits in 5,000-row chunks with
// bounded memory.
func TestPrices300kRows(t *testing.T) {
	if testing.Short() {
		t.Skip("large import")
	}
	e := newEnv(t)
	e.svc.LargePrices = true
	e.setAdjusted(false)
	var syms []string
	for i := 0; i < 20; i++ {
		syms = append(syms, fmt.Sprintf("S%02d", i))
	}
	e.stocks(syms...)
	var b strings.Builder
	b.WriteString(hdrP)
	for _, sym := range syms {
		d := time.Date(1960, 1, 1, 0, 0, 0, 0, time.UTC)
		for n := 0; n < 15000; {
			if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
				fmt.Fprintf(&b, "%s,%s,100.00,101.50,99.25,100.75,1250000\n", sym, d.Format(time.DateOnly))
				n++
			}
			d = d.AddDate(0, 0, 1)
		}
	}
	content := []byte(b.String())
	b.Reset()
	if len(content) < 10<<20 || len(content) > 25<<20 {
		t.Fatalf("test file size %d", len(content))
	}
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	stop := make(chan struct{})
	peak := make(chan uint64, 1)
	go func() {
		var max uint64
		for {
			select {
			case <-stop:
				peak <- max
				return
			case <-time.After(20 * time.Millisecond):
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				if m.HeapInuse > max {
					max = m.HeapInuse
				}
			}
		}
	}()
	var chunks int
	e.svc.afterChunk = func(n int) error { chunks = n; return nil }
	t0 := time.Now()
	v, err := e.svc.Validate(context.Background(), KindPrices, content, "")
	t.Logf("validate %v", time.Since(t0))
	t0 = time.Now()
	if err != nil || v.ErrorCount != 0 || v.Rows != 300_000 {
		t.Fatalf("validate: %v %+v", err, v)
	}
	r, err := e.commit(KindPrices, v.UploadID)
	t.Logf("commit %v", time.Since(t0))
	close(stop)
	if err != nil || r.Inserted != 300_000 {
		t.Fatalf("commit: %v %+v", err, r)
	}
	if chunks != 60 { // 5,000 distinct bars per chunk
		t.Errorf("chunks: %d", chunks)
	}
	if got := e.count(`SELECT count(*) FROM price_daily`); got != 300_000 {
		t.Errorf("rows stored: %d", got)
	}
	growth := int64(<-peak) - int64(base.HeapInuse) //nolint:gosec // heap sizes are far below 2^63
	t.Logf("file %d bytes, peak heap growth %d MB", len(content), growth>>20)
	if growth > 200<<20 {
		t.Errorf("memory is not bounded: peak heap growth %d MB for a %d MB file", growth>>20, len(content)>>20)
	}
}

// IMP-23: projected-size guard and the tracked-stock warning.
func TestSizeGuardAndTrackedWarning(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)
	var b strings.Builder
	b.WriteString(hdrP)
	d := time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)
	for n := 0; n < 10_000; { // ~1.24 MB estimated growth
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			fmt.Fprintf(&b, "AAA,%s,1,2,1,1,1\n", d.Format(time.DateOnly))
			n++
		}
		d = d.AddDate(0, 0, 1)
	}
	big := b.String()
	v := e.validate(KindPrices, big)
	if v.EstimatedGrowthMB == nil || *v.EstimatedGrowthMB != 1.24 || v.WarningCount != 0 {
		t.Fatalf("validate: %+v", v)
	}
	limit := int64(380) << 20
	e.svc.DBSize = func(context.Context) (int64, error) { return limit - (1 << 20), nil } // 1 MB left, 1.24 MB needed
	v = e.validate(KindPrices, big)
	if v.WarningCount != 1 || !strings.Contains(v.Warnings[0].Message, "exceed 380 MB") {
		t.Errorf("validate must warn about the limit: %+v", v.Warnings)
	}
	var sl *SizeLimitError
	if _, err := e.commit(KindPrices, v.UploadID); !errors.As(err, &sl) || !strings.Contains(sl.Error(), "exceed 380 MB; trim history or import fewer rows") {
		t.Fatalf("expected DB_SIZE_LIMIT, got %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 {
		t.Fatal("nothing written")
	}
	small := e.validate(KindPrices, hdrP+"AAA,2026-01-05,1,2,1,1,1\n")
	if _, err := e.commit(KindPrices, small.UploadID); err != nil {
		t.Fatalf("a small file still fits: %v", err)
	}
	// At the limit even an update-only file is refused.
	e.svc.DBSize = func(context.Context) (int64, error) { return limit, nil }
	again := e.validate(KindPrices, hdrP+"AAA,2026-01-05,1,2,1,1,1\n")
	if _, err := e.commit(KindPrices, again.UploadID); !errors.As(err, &sl) {
		t.Fatalf("at the limit: %v", err)
	}

	// More than 400 tracked stocks: warning, never a block.
	e.svc.DBSize = func(context.Context) (int64, error) { return 10 << 20, nil }
	e.exec(`INSERT INTO instrument (symbol, name, is_tracked, tracked_reason) SELECT 'T'||g, 'T', true, 'watchlist' FROM generate_series(1, 400) g`)
	w := e.validate(KindPrices, hdrP+"AAA,2026-01-12,1,2,1,1,1\n")
	if w.WarningCount != 1 || !strings.Contains(w.Warnings[0].Message, "more than 400") {
		t.Errorf("tracked warning: %+v", w.Warnings)
	}
	r, err := e.commit(KindPrices, w.UploadID)
	if err != nil || len(r.Warnings) != 1 || r.Warnings[0] != WarnTrackedOver400 {
		t.Fatalf("commit %+v %v", r, err)
	}
}

// BRK-08: a close-to-close move over 50% without a confirmed action within one trading day is
// stored as suspect; with a confirmed action, or at 40%, it is not.
func TestSuspectJumpRule(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB", "CCC")
	e.setAdjusted(false)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, source)
		SELECT id, '2026-01-07', 'split', 'confirmed', 1, 5, 'manual' FROM instrument WHERE symbol='BBB'`)
	e.mustCommit(KindPrices, hdrP+
		"AAA,2026-01-05,100,101,99,100,1000\nAAA,2026-01-06,100,101,99,100,1000\nAAA,2026-01-07,20,21,19,20,5000\nAAA,2026-01-08,20,21,19,20,1000\n"+
		"BBB,2026-01-05,100,101,99,100,1000\nBBB,2026-01-06,100,101,99,100,1000\nBBB,2026-01-07,20,21,19,20,5000\n"+
		"CCC,2026-01-05,100,101,99,100,1000\nCCC,2026-01-06,60,61,59,60,1000\nCCC,2026-01-07,150,151,149,150,1000\n")
	sus := func(sym, date string) bool {
		var s bool
		if err := e.pool.QueryRow(context.Background(), `SELECT suspect FROM price_daily p JOIN instrument i ON i.id=p.instrument_id WHERE i.symbol=$1 AND trade_date=$2`, sym, date).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if !sus("AAA", "2026-01-07") || sus("AAA", "2026-01-06") || sus("AAA", "2026-01-08") {
		t.Error("AAA: only the -80% day is suspect")
	}
	if sus("BBB", "2026-01-07") {
		t.Error("BBB: a confirmed action on the day clears the rule")
	}
	if sus("CCC", "2026-01-06") { // -40%
		t.Error("CCC: 40% is below the rule")
	}
	if !sus("CCC", "2026-01-07") { // +150%
		t.Error("CCC: +150% is suspect")
	}
	// The row-level rule: OHLC inconsistent is stored suspect (warning), non-positive is an error.
	v := e.validate(KindPrices, hdrP+"AAA,2026-01-09,20,19,18,19.5,10\n")
	if v.ErrorCount != 0 || v.WarningCount != 1 {
		t.Fatalf("%+v", v)
	}
	if _, err := e.commit(KindPrices, v.UploadID); err != nil {
		t.Fatal(err)
	}
	if !sus("AAA", "2026-01-09") {
		t.Error("inconsistent OHLC must be suspect")
	}
	// Re-importing corrected data clears the row-level flag.
	e.mustCommit(KindPrices, hdrP+"AAA,2026-01-09,20,21,18,19.5,10\n")
	if sus("AAA", "2026-01-09") {
		t.Error("corrected bar must not stay suspect")
	}
}

// IMP-26: adjustment check on the synthetic split sample; reads only the upload.
func TestAdjustmentCheck(t *testing.T) {
	e := newEnv(t)
	e.stocks("FAKEA")
	split := fixture(t, "import-samples/prices_synthetic_split.csv")
	v := e.validate(KindPrices, split)
	if v.ErrorCount != 0 {
		t.Fatalf("%+v", v.Errors)
	}
	ctx := context.Background()
	r, err := e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: v.UploadID, Symbol: "fakea", ExDate: "2026-02-10"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Hint != "raw_likely" || r.NearestFraction == nil || *r.NearestFraction != "1/5" || r.Ratio != 0.2 || len(r.Bars) != 10 {
		t.Fatalf("raw split: %+v", r)
	}
	if r.Bars[4][0] != "2026-02-09" || r.Bars[5][0] != "2026-02-10" || r.Bars[5][1].(float64) != 204.08 {
		t.Errorf("bars %v", r.Bars)
	}
	n, d := int64(1), int64(5)
	r, err = e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "10-02-2026", ExpectedNum: &n, ExpectedDen: &d})
	if err != nil || r.Hint != "raw_likely" {
		t.Fatalf("expected ratio 1/5: %+v %v", r, err)
	}
	n2, d2 := int64(1), int64(2) // the owner expects 1:2 but the file shows 1:5: not a match
	r, err = e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "2026-02-10", ExpectedNum: &n2, ExpectedDen: &d2})
	if err != nil || r.Hint != "inconclusive" {
		t.Fatalf("mismatch: %+v %v", r, err)
	}
	// A smooth series across the date is adjusted_likely; a 20% gap matches no fraction.
	smooth := hdrP + "FAKEA,2026-02-05,100,101,99,100,1\nFAKEA,2026-02-06,100,101,99,100.4,1\nFAKEA,2026-02-09,100,101,99,100.9,1\nFAKEA,2026-02-10,100,101,99,101.2,1\n" +
		"FAKEA,2026-03-02,100,101,99,100,1\nFAKEA,2026-03-03,80,81,79,80,1\n"
	sv := e.validate(KindPrices, smooth)
	r, err = e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: sv.UploadID, Symbol: "FAKEA", ExDate: "2026-02-09"})
	if err != nil || r.Hint != "adjusted_likely" || r.NearestFraction != nil {
		t.Fatalf("smooth: %+v %v", r, err)
	}
	r, err = e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: sv.UploadID, Symbol: "FAKEA", ExDate: "2026-03-03"})
	if err != nil || r.Hint != "raw_likely" || r.NearestFraction == nil || *r.NearestFraction != "4/5" { // 80/100 is exactly 4/5
		t.Fatalf("0.8: %+v %v", r, err)
	}
	var ve *ValidationError
	for name, req := range map[string]AdjustmentCheckRequest{
		"unknown symbol":      {UploadID: v.UploadID, Symbol: "NOPE", ExDate: "2026-02-10"},
		"ex-date before file": {UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "2026-01-01"},
		"ex-date after file":  {UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "2026-04-01"},
		"bad date":            {UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "10/02/2026"},
		"half ratio":          {UploadID: v.UploadID, Symbol: "FAKEA", ExDate: "2026-02-10", ExpectedNum: &n},
	} {
		if _, err := e.svc.AdjustmentCheck(ctx, req); !errors.As(err, &ve) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.svc.AdjustmentCheck(ctx, AdjustmentCheckRequest{UploadID: newUUID(), Symbol: "FAKEA", ExDate: "2026-02-10"}); !errors.Is(err, ErrUploadNotFound) {
		t.Errorf("unknown upload: %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 || e.count(`SELECT count(*) FROM app_setting WHERE key='PRICES_ALREADY_ADJUSTED'`) != 0 || e.count(`SELECT count(*) FROM import_batch`) != 0 {
		t.Error("the check writes nothing")
	}
	// The sample's 1:5 split day is stored suspect (the rule) yet the detector reads all bars (D03-A9).
	e.setAdjusted(false)
	e.mustCommit(KindPrices, split)
	if e.count(`SELECT count(*) FROM price_daily WHERE suspect`) != 1 {
		t.Error("the split day is flagged suspect by the 50% rule")
	}
}

// PRC-21 and trim (D-C): preview, confirm, audit row, post_import; other stocks untouched.
func TestDeleteAndTrimPrices(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	e.setAdjusted(false)
	e.mustCommit(KindPrices, hdrP+
		"AAA,2026-01-05,1,2,1,1,1\nAAA,2026-01-06,1,2,1,1,1\nAAA,2026-01-07,1,2,1,1,1\nAAA,2026-01-08,1,2,1,1,1\n"+
		"BBB,2026-01-05,1,2,1,1,1\nBBB,2026-01-06,1,2,1,1,1\n")
	ctx := context.Background()
	n, err := e.svc.DeletePreview(ctx, "aaa", "2026-01-06", "2026-01-07")
	if err != nil || n != 2 {
		t.Fatalf("preview %d %v", n, err)
	}
	var ve *ValidationError
	if _, err := e.svc.DeletePrices(ctx, "AAA", "2026-01-06", "2026-01-07", false); !errors.As(err, &ve) {
		t.Errorf("confirm required: %v", err)
	}
	if _, err := e.svc.DeletePrices(ctx, "AAA", "2026-01-07", "2026-01-06", true); !errors.As(err, &ve) {
		t.Errorf("from > to: %v", err)
	}
	if _, err := e.svc.DeletePreview(ctx, "AAA", "06-01-2026", "2026-01-07"); !errors.As(err, &ve) {
		t.Errorf("date format: %v", err)
	}
	if _, err := e.svc.DeletePrices(ctx, "NOPE", "2026-01-06", "2026-01-07", true); !errors.Is(err, ErrSymbolNotFound) {
		t.Errorf("unknown symbol: %v", err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 6 {
		t.Fatal("nothing deleted yet")
	}
	res, err := e.svc.DeletePrices(ctx, "AAA", "2026-01-06", "2026-01-07", true)
	if err != nil || res.Deleted != 2 || res.JobID == nil || res.BatchID == nil {
		t.Fatalf("delete %+v %v", res, err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 4 || e.count(`SELECT count(*) FROM price_daily p JOIN instrument i ON i.id=p.instrument_id WHERE i.symbol='BBB'`) != 2 {
		t.Error("only AAA's rows in range are deleted")
	}
	var note string
	_ = e.pool.QueryRow(ctx, `SELECT note FROM import_batch WHERE id=$1 AND kind='manual_form'`, *res.BatchID).Scan(&note)
	if note != "deleted prices AAA 2026-01-06..2026-01-07, 2 rows" {
		t.Errorf("audit note %q", note)
	}
	job, _ := e.jobs.Get(ctx, *res.JobID)
	if job.Target != fmt.Sprintf("batch:%d", *res.BatchID) || !strings.Contains(compact(job.Result), `"remaining":["AAA"]`) {
		t.Errorf("job %+v", job)
	}
	// Nothing in range: no audit row, no job.
	res, err = e.svc.DeletePrices(ctx, "AAA", "2020-01-01", "2020-01-02", true)
	if err != nil || res.Deleted != 0 || res.JobID != nil || res.BatchID != nil {
		t.Fatalf("empty delete %+v %v", res, err)
	}

	// Trim history.
	pv, err := e.svc.TrimPreviewFor(ctx, []string{"AAA", "bbb", "AAA"}, "2026-01-07")
	if err != nil || pv.TotalRows != 3 || len(pv.PerSymbol) != 2 || pv.PerSymbol[0].Rows != 1 || pv.PerSymbol[1].Rows != 2 {
		t.Fatalf("trim preview %+v %v", pv, err)
	}
	if pv.EstimatedMBFreed != roundTo(3*130.0/float64(1<<20), 2) {
		t.Errorf("mb freed %v", pv.EstimatedMBFreed)
	}
	if _, err := e.svc.Trim(ctx, []string{"AAA"}, "2026-01-07", false); !errors.As(err, &ve) {
		t.Errorf("trim confirm: %v", err)
	}
	if _, err := e.svc.Trim(ctx, []string{"AAA", "NOPE"}, "2026-01-07", true); !errors.As(err, &ve) {
		t.Errorf("trim unknown: %v", err)
	}
	if _, err := e.svc.Trim(ctx, nil, "2026-01-07", true); !errors.As(err, &ve) {
		t.Errorf("trim no symbols: %v", err)
	}
	tr, err := e.svc.Trim(ctx, []string{"AAA", "BBB"}, "2026-01-07", true)
	if err != nil || tr.Deleted != 3 || tr.JobID == nil {
		t.Fatalf("trim %+v %v", tr, err)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 1 {
		t.Error("only the bar on or after the cut-off remains")
	}
	tjob, _ := e.jobs.Get(ctx, *tr.JobID)
	if !strings.Contains(compact(tjob.Result), `"remaining":["AAA","BBB"]`) {
		t.Errorf("trim job %s", tjob.Result)
	}
	if e.count(`SELECT count(*) FROM import_batch WHERE kind='manual_form'`) != 2 {
		t.Error("two audit rows")
	}
}

// POST /instruments (Add stock) and IMP-17 parity with the CSV validators.
func TestAddInstrumentParity(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	r, err := e.svc.AddInstrument(ctx, InstrumentFields{Symbol: "tcs", Name: "Tata Consultancy Services Ltd", ISIN: "BAD"})
	if err != nil || r.Symbol != "TCS" || r.ID == 0 || len(r.Warnings) != 2 {
		t.Fatalf("add %+v %v", r, err)
	}
	if _, err := e.svc.AddInstrument(ctx, InstrumentFields{Symbol: "TCS", Name: "again"}); !errors.Is(err, ErrConflict) {
		t.Errorf("existing symbol: %v", err)
	}
	var isin *string
	_ = e.pool.QueryRow(ctx, `SELECT isin FROM instrument WHERE symbol='TCS'`).Scan(&isin)
	if isin != nil {
		t.Error("malformed ISIN is stored NULL")
	}
	for _, in := range []InstrumentFields{
		{"M&M", "Mahindra", "INE101A01026"}, {"bad sym", "x", ""}, {"NIFTY50", "x", ""}, {"", "", ""}, {"OK1", "x", "XX"}, {"ok2", strings.Repeat("n", 201), ""},
	} {
		_, formErr := e.svc.AddInstrument(ctx, in)
		csvRes := e.validate(KindInstruments, hdrI+fmt.Sprintf("%s,%s,%s,,,,,,\n", in.Symbol, in.Name, in.ISIN))
		var formMsgs []string
		var ve *ValidationError
		if errors.As(formErr, &ve) {
			for _, f := range ve.Fields {
				formMsgs = append(formMsgs, f.Message)
			}
		}
		var csvMsgs []string
		for _, i := range csvRes.Errors {
			csvMsgs = append(csvMsgs, i.Message)
		}
		if in.Symbol == "" { // an empty symbol cell is a blank row in a CSV; the form reports it
			continue
		}
		if strings.Join(formMsgs, "|") != strings.Join(csvMsgs, "|") {
			t.Errorf("%+v: form %v != csv %v", in, formMsgs, csvMsgs)
		}
	}
}

func TestListBatches(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)
	for i := 0; i < 3; i++ {
		e.mustCommit(KindPrices, hdrP+fmt.Sprintf("AAA,2026-01-0%d,1,2,1,1,1\n", i+5))
	}
	rows, err := e.svc.ListBatches(context.Background(), 2, 0)
	if err != nil || len(rows) != 3 || rows[0].ID < rows[1].ID || rows[0].Kind != "prices" || rows[0].RowCount != 1 {
		t.Fatalf("%+v %v", rows, err)
	}
	next, _ := e.svc.ListBatches(context.Background(), 2, rows[1].ID)
	if len(next) != 1 {
		t.Errorf("next page %d", len(next))
	}
}

// IMP-34: commit validates again against the current database.
func TestCommitRevalidates(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	e.setAdjusted(false)
	v := e.validate(KindPrices, hdrP+"AAA,2026-01-05,1,2,1,1,1\n")
	if v.ErrorCount != 0 {
		t.Fatal(v.Errors)
	}
	e.exec(`DELETE FROM instrument WHERE symbol='AAA'`) // the stock disappears between validate and commit
	var he *HasErrorsError
	if _, err := e.commit(KindPrices, v.UploadID); !errors.As(err, &he) || he.Count != 1 {
		t.Fatalf("expected a re-validation error, got %v", err)
	}
	if e.count(`SELECT count(*) FROM import_upload`) != 1 || e.count(`SELECT count(*) FROM price_daily`) != 0 {
		t.Error("nothing written, upload kept")
	}
}
