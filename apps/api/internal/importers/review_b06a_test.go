package importers

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

// genPrices returns n weekday bars for sym starting at start (no header).
func genPrices(sym string, start time.Time, n int) string {
	var b strings.Builder
	d := start
	for i := 0; i < n; {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			fmt.Fprintf(&b, "%s,%s,1,2,1,1,1\n", sym, d.Format(time.DateOnly))
			i++
		}
		d = d.AddDate(0, 0, 1)
	}
	return b.String()
}

// IMP-22 at unit level (no database): scanning 300,000 rows keeps a bounded heap and the report keeps
// only the first rows (preview and issues), never a struct per row.
func TestScanPricesStreamingMemoryBound(t *testing.T) {
	if testing.Short() {
		t.Skip("large scan")
	}
	idx := &instrumentIndex{bySymbol: map[string]int32{}, byID: map[int32]string{}, alias: map[string]int32{}, tracked: map[int32]bool{}}
	var b strings.Builder
	b.WriteString(hdrP)
	for i := 0; i < 300; i++ {
		sym := fmt.Sprintf("S%03d", i)
		idx.bySymbol[sym], idx.byID[int32(i+1)] = int32(i+1), sym //nolint:gosec // small loop index
		b.WriteString(genPrices(sym, time.Date(2000, 1, 3, 0, 0, 0, 0, time.UTC), 1000))
	}
	content := []byte(b.String())
	b.Reset()
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	stop := make(chan struct{})
	peak := make(chan uint64, 1)
	go func() {
		var mx uint64
		for {
			select {
			case <-stop:
				peak <- mx
				return
			case <-time.After(5 * time.Millisecond):
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				mx = max(mx, m.HeapInuse)
			}
		}
	}()
	calls := 0
	rep, hdr, err := scanPrices(content, priceEnv{idx: idx, holidays: map[time.Time]bool{}, today: testToday}, LimitsFor(KindPrices, true),
		func(priceRow) error { calls++; return nil })
	close(stop)
	if err != nil || hdr != nil || calls != 300_000 || rep.Valid != 300_000 || rep.Errors.total != 0 {
		t.Fatalf("scan: %v %v calls=%d valid=%d", err, hdr, calls, rep.Valid)
	}
	if len(rep.Preview) != previewRows {
		t.Errorf("preview rows %d, want %d", len(rep.Preview), previewRows)
	}
	growth := int64(<-peak) - int64(base.HeapInuse) //nolint:gosec // heap sizes are far below 2^63
	t.Logf("file %d bytes, peak heap growth %d MB", len(content), growth>>20)
	if growth > 150<<20 {
		t.Errorf("scan memory is not bounded: %d MB growth for a %d MB file", growth>>20, len(content)>>20)
	}
}

// IMP-16: CRLF-only endings parse; a lone CR (old Mac) is refused with a plain message instead of
// being read as one giant row.
func TestLineEndingsCRLFAndLoneCR(t *testing.T) {
	crlf := strings.ReplaceAll(hdrP+"TCS,2026-01-05,1,2,1,1,1\nTCS,2026-01-06,1,2,1,1,1\n", "\n", "\r\n")
	rep, hdr, rows := scanP(t, crlf)
	if hdr != nil || rep.Errors.total != 0 || len(rows) != 2 {
		t.Fatalf("CRLF: hdr=%v errs=%s rows=%d", hdr, msgs(rep.Errors), len(rows))
	}
	loneCR := strings.ReplaceAll(hdrP+"TCS,2026-01-05,1,2,1,1,1\nTCS,2026-01-06,1,2,1,1,1\n", "\n", "\r")
	_, _, err := scanPrices([]byte(loneCR), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, false), nil)
	if !errors.Is(err, ErrNotText) || !strings.Contains(err.Error(), "carriage return") {
		t.Fatalf("lone CR: %v", err)
	}
	// A single trailing CR after a normal header is not a lone-CR file.
	if _, hdr, err := scanPrices([]byte(strings.TrimSuffix(hdrP, "\n")+"\r"), priceEnv{idx: testIdx(), today: testToday}, LimitsFor(KindPrices, false), nil); err != nil || hdr != nil {
		t.Fatalf("header with trailing CR: %v %v", hdr, err)
	}
}

// IMP-17 parity: look-alike letters are rejected on the prices path exactly as on the instruments path.
func TestSymbolLookalikesRejectedInPrices(t *testing.T) {
	for _, sym := range []string{"ınfy", "ſbin"} {
		rep, _, rows := scanP(t, hdrP+sym+",2026-01-05,1,2,1,1,1\n")
		if len(rows) != 0 || rep.Errors.total != 1 {
			t.Errorf("%q: rows=%d errs=%s", sym, len(rows), msgs(rep.Errors))
		}
	}
	// Dates below the floor are row errors for prices.
	rep, _, rows := scanP(t, hdrP+"TCS,0001-01-01,1,2,1,1,1\nTCS,1800-01-01,1,2,1,1,1\n")
	if len(rows) != 0 || rep.Errors.total != 2 {
		t.Errorf("floor: rows=%d errs=%s", len(rows), msgs(rep.Errors))
	}
}

// IMP-23 / D-B: only NEW rows count as growth and this upload's own bytes are not part of the current
// size. An all-update re-import (IMP-10) near the limit commits; an all-new file near the limit is refused.
func TestSizeGuardCountsOnlyNewRows(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA", "BBB")
	e.setAdjusted(false)
	start := time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)
	file := hdrP + genPrices("AAA", start, 10_000/2) + genPrices("BBB", start, 10_000/2)
	e.mustCommit(KindPrices, file)

	limit := int64(380) << 20
	// 1 KiB under the limit, plus whatever this commit's own upload row occupies (it is deleted by
	// the commit itself, so it is not growth).
	e.svc.DBSize = func(ctx context.Context) (int64, error) {
		var own int64
		err := e.pool.QueryRow(ctx, `SELECT COALESCE(sum(pg_column_size(content)), 0) FROM import_upload`).Scan(&own)
		return limit - 1024 + own, err
	}
	v := e.validate(KindPrices, file)
	if v.EstimatedGrowthMB == nil || *v.EstimatedGrowthMB != 0 || v.WarningCount != 0 {
		t.Fatalf("an all-update file projects no growth: %+v %v", v.EstimatedGrowthMB, v.Warnings)
	}
	r, err := e.commit(KindPrices, v.UploadID)
	if err != nil || r.Inserted != 0 || r.Updated != 10_000 {
		t.Fatalf("re-import near the limit must commit: %+v %v", r, err)
	}
	// An all-new file of the same size is refused.
	newFile := hdrP + genPrices("AAA", time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), 1000)
	nv := e.validate(KindPrices, newFile)
	if nv.EstimatedGrowthMB == nil || *nv.EstimatedGrowthMB == 0 {
		t.Fatalf("new rows project growth: %+v", nv.EstimatedGrowthMB)
	}
	var sl *SizeLimitError
	if _, err := e.commit(KindPrices, nv.UploadID); !errors.As(err, &sl) {
		t.Fatalf("all-new file near the limit: %v", err)
	}
	// Market-series rows are counted by their own key too.
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50', '2026-01-05', 1)`)
	sv := e.validate(KindPrices, hdrP+"NIFTY50,2026-01-05,1,1,1,2,0\n")
	if sv.EstimatedGrowthMB == nil || *sv.EstimatedGrowthMB != 0 {
		t.Errorf("existing series row is not growth: %+v", sv.EstimatedGrowthMB)
	}
}

// Outstanding uploads are capped by count and bytes (429 + Retry-After at the HTTP layer); an expired
// upload frees its slot.
func TestUploadCap(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	body := hdrP + "AAA,2026-01-05,1,2,1,1,1\n"
	for i := 0; i < MaxOutstandingUploads; i++ {
		if _, err := e.svc.Validate(context.Background(), KindPrices, []byte(body), ""); err != nil {
			t.Fatalf("upload %d: %v", i+1, err)
		}
	}
	var uc *UploadCapError
	_, err := e.svc.Validate(context.Background(), KindPrices, []byte(body), "")
	if !errors.As(err, &uc) || uc.RetryAfterSeconds < 1 || uc.RetryAfterSeconds > 3601 {
		t.Fatalf("upload past the cap: %v %+v", err, uc)
	}
	if n := e.count(`SELECT count(*) FROM import_upload`); n != MaxOutstandingUploads {
		t.Fatalf("%d rows stored", n)
	}
	e.now.Store(e.svc.Now().Add(61 * time.Minute))
	if _, err := e.svc.Validate(context.Background(), KindPrices, []byte(body), ""); err != nil {
		t.Fatalf("expired uploads free their slots: %v", err)
	}
	if n := e.count(`SELECT count(*) FROM import_upload`); n != 1 {
		t.Fatalf("expired rows are purged at putUpload: %d", n)
	}
	// The byte cap: one stored row nearly fills the budget.
	e.exec(`INSERT INTO import_upload (id, kind, content, created_at, expires_at)
		VALUES (gen_random_uuid(), 'prices', decode(repeat('61', $1::int), 'hex'), $2, $3)`,
		MaxOutstandingBytes-10, e.svc.Now(), e.svc.Now().Add(time.Hour))
	if _, err := e.svc.Validate(context.Background(), KindPrices, []byte(body), ""); !errors.As(err, &uc) {
		t.Fatalf("byte cap: %v", err)
	}
}

// A commit takes a bounded number of uploads and bytes (422) before any content is loaded.
func TestCommitCaps(t *testing.T) {
	e := newEnv(t)
	e.setAdjusted(false)
	grp := newUUID()
	var ids []string
	for i := 0; i < 50; i++ {
		ids = append(ids, newUUID())
	}
	var ve *ValidationError
	if _, err := e.svc.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: ids, UploadGroup: grp}); !errors.As(err, &ve) || ve.Fields[0].Field != "upload_ids" {
		t.Fatalf("50 ids: %v", err)
	}
	var big []string
	for i := 0; i < 2; i++ {
		id := newUUID()
		e.exec(`INSERT INTO import_upload (id, kind, content, created_at, expires_at)
			VALUES ($1::uuid, 'prices', decode(repeat('61', $2::int), 'hex'), $3, $4)`,
			id, 30<<20, e.svc.Now(), e.svc.Now().Add(time.Hour))
		big = append(big, id)
	}
	if _, err := e.svc.Commit(context.Background(), KindPrices, CommitRequest{UploadIDs: big, UploadGroup: grp}); !errors.As(err, &ve) {
		t.Fatalf("60 MB of parts: %v", err)
	}
	if e.count(`SELECT count(*) FROM import_upload`) != 2 {
		t.Fatal("a refused commit keeps the uploads")
	}
}

// IMP-15: text imported as `=cmd|...` is stored verbatim (never executed) and made safe by SafeCSVCell
// on every export path. The API has no CSV export endpoint yet; SafeCSVCell is the single export helper.
func TestFormulaTextStoredAndExportSafe(t *testing.T) {
	e := newEnv(t)
	const evil = "=cmd|' /C calc'!A0"
	r := e.mustCommit(KindInstruments, hdrI+"EVL1,\""+evil+"\",,,,,,,\n")
	if r.Inserted != 1 {
		t.Fatalf("%+v", r)
	}
	var name string
	if err := e.pool.QueryRow(context.Background(), `SELECT name FROM instrument WHERE symbol='EVL1'`).Scan(&name); err != nil || name != evil {
		t.Fatalf("stored %q %v", name, err)
	}
	if got := SafeCSVCell(name); got != "'"+evil {
		t.Errorf("export cell %q", got)
	}
	// A formula-looking symbol never reaches the table.
	v := e.validate(KindInstruments, hdrI+"=CMD|x,Evil,,,,,,,\n-,Dash,,,,,,,\n")
	if v.ErrorCount != 2 {
		t.Errorf("formula and dash symbols: %+v", v.Errors)
	}
}

// IMP-22: a failure at a late chunk of an instruments import rolls the whole import back.
func TestInstrumentsRollbackOnChunk(t *testing.T) {
	e := newEnv(t)
	e.svc.chunkSize = 2
	var b strings.Builder
	b.WriteString(hdrI)
	for i := 0; i < 7; i++ {
		fmt.Fprintf(&b, "NEW%d,New %d,,,,,,,\n", i, i)
	}
	v := e.validate(KindInstruments, b.String())
	if v.ErrorCount != 0 {
		t.Fatalf("%v", v.Errors)
	}
	calls := 0
	e.svc.afterChunk = func(int) error {
		calls++
		if calls == 3 {
			return errors.New("injected failure at a late chunk")
		}
		return nil
	}
	if _, err := e.commit(KindInstruments, v.UploadID); err == nil {
		t.Fatal("expected failure")
	}
	if calls != 3 {
		t.Fatalf("hook calls %d", calls)
	}
	if e.count(`SELECT count(*) FROM instrument`) != 0 || e.count(`SELECT count(*) FROM import_batch`) != 0 ||
		e.count(`SELECT count(*) FROM import_upload WHERE id=$1::uuid`, v.UploadID) != 1 {
		t.Fatal("a failed instruments commit must leave no partial writes and keep the upload")
	}
	e.svc.afterChunk = nil
	if r, err := e.commit(KindInstruments, v.UploadID); err != nil || r.Inserted != 7 {
		t.Fatalf("retry: %+v %v", r, err)
	}
}
