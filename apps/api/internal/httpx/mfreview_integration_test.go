package httpx

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

// B15 review integration tests (docs/07 MFHX- rows). Every fixture is SYNTHETIC.

const mfxXLSXType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// storedUploads returns the raw content of every import_upload row.
func (e *mfhEnv) storedUploads() []string {
	e.t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT content FROM import_upload`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, string(b))
	}
	return out
}

// MFHX-11 (B2): import_upload never holds the raw statement; revalidate and commit work from the stripped form.
func TestMFStoredUploadIsStripped(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	secrets := []string{"Jane Sample", "ABCDE1234F", "1 Made-up Road", "99999.99", "Closing balance"}
	csv := "Client Name,PAN,Address\nJane Sample,ABCDE1234F,1 Made-up Road\n\n" +
		"Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty,Balance\n" +
		"05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0,99999.99\n" +
		"06-Nov-2026,Alpha Fund,Purchase,F1,2.000,10.000,20.00,0,99999.99\n" +
		"Closing balance for Jane Sample ABCDE1234F\n"
	v := e.validateMF(csv)
	id := v["upload_id"].(string)
	stored := e.storedUploads()
	if len(stored) != 1 {
		t.Fatalf("stored uploads: %d", len(stored))
	}
	for _, s := range secrets {
		if strings.Contains(stored[0], s) {
			t.Errorf("import_upload.content holds %q", s)
		}
	}
	if !strings.HasPrefix(stored[0], "\n\n\nDate,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty\n") && !strings.Contains(stored[0], "Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty") {
		t.Errorf("stored form is not the canonical CSV: %q", stored[0])
	}
	// The footer row (an error: not a date) stays an error on revalidate, with the same row number and count.
	nErr := mfhInt(v["error_count"])
	if nErr == 0 {
		t.Fatalf("the footer row must be an error: %v", v["errors"])
	}
	rv := decodeData(t, e.post("/imports/mf_statement/revalidate", fmt.Sprintf(`{"upload_id":%q}`, id)))
	if mfhInt(rv["error_count"]) != nErr || mfhInt(rv["rows"]) != mfhInt(v["rows"]) {
		t.Fatalf("revalidate from stripped content: %v", rv)
	}
	if mfhInt(rv["errors"].([]any)[0].(map[string]any)["row"]) != mfhInt(v["errors"].([]any)[0].(map[string]any)["row"]) {
		t.Error("row numbers changed between validate and revalidate")
	}
	// Excluding the errored footer row (S9) lets the commit go through, from the stripped content.
	badLine := mfhInt(v["errors"].([]any)[0].(map[string]any)["row"])
	if r, _ := e.commitMF(id); r.Code != 422 {
		t.Fatalf("commit without exclusion: %d", r.Code)
	}
	v = e.validateMF(csv)
	r, d := e.commitMF(v["upload_id"].(string), badLine)
	if r.Code != 200 || mfhInt(d["inserted"]) != 2 {
		t.Fatalf("commit excluding the errored row: %d %v %s", r.Code, d, r.Body.String())
	}
	var units string
	_ = e.pool.QueryRow(context.Background(), `SELECT sum(units)::text FROM mf_txn WHERE scheme_code = 201`).Scan(&units)
	if units != "3.0000" {
		t.Errorf("committed units %s", units)
	}
	// The same through an .xlsx with title rows.
	x := mfhXLSX([][]string{{"Statement for Jane Sample"}, {"PAN ABCDE1234F"}, {},
		{"Date", "Fund Name", "Transaction Type", "Folio No", "Units Traded", "NAV", "Amount", "Stamp Duty"},
		{"07-Nov-2026", "Alpha Fund", "Purchase", "F1", "1.000", "10.000", "10.00", "0"}})
	r2 := e.uploadMF("s.xlsx", mfxXLSXType, x)
	if r2.Code != 200 {
		t.Fatalf("xlsx: %d %s", r2.Code, r2.Body.String())
	}
	for _, s := range e.storedUploads() {
		for _, secret := range append(secrets, "Statement for Jane") {
			if strings.Contains(s, secret) {
				t.Errorf("stored xlsx form holds %q", secret)
			}
		}
		if strings.HasPrefix(s, "PK") {
			t.Error("the raw xlsx was stored")
		}
	}
	xv := decodeData(t, r2)
	if cr, cd := e.commitMF(xv["upload_id"].(string)); cr.Code != 200 || mfhInt(cd["inserted"]) != 1 {
		t.Errorf("commit of a stored xlsx statement: %d %v", cr.Code, cd)
	}
	// A header-less file stores a stub, never its content.
	e.validateMF("Jane Sample,ABCDE1234F\nnothing useful here\n")
	for _, s := range e.storedUploads() {
		if strings.Contains(s, "Jane") || strings.Contains(s, "ABCDE") {
			t.Error("a statement without a header was stored verbatim")
		}
	}
}

// MFHX-12 (S1): the .xlsx path is off by default; CSV always works.
func TestMFXLSXFeatureFlag(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	x := mfhXLSX([][]string{{"Date", "Fund Name", "Transaction Type", "Folio No", "Units Traded", "NAV", "Amount", "Stamp Duty"},
		{"05-Nov-2026", "Alpha Fund", "Purchase", "F1", "1.000", "10.000", "10.00", "0"}})
	e.svc.MFXLSXEnabled = false
	r := e.uploadMF("s.xlsx", mfxXLSXType, x)
	if r.Code != 422 || !strings.Contains(r.Body.String(), "xlsx not enabled") {
		t.Errorf("flag off: %d %s", r.Code, r.Body.String())
	}
	if n := len(e.storedUploads()); n != 0 {
		t.Errorf("a refused workbook must not be stored: %d", n)
	}
	// An xlsx renamed .csv is still an xlsx: the flag decides by content.
	if r := e.uploadMF("s.csv", "text/csv", x); r.Code != 422 {
		t.Errorf("xlsx named csv with the flag off: %d", r.Code)
	}
	if r := e.uploadMF("s.csv", "text/csv", mfhHdr+"05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0\n"); r.Code != 200 {
		t.Errorf("csv with the flag off: %d %s", r.Code, r.Body.String())
	}
	e.svc.MFXLSXEnabled = true
	if r := e.uploadMF("s.xlsx", mfxXLSXType, x); r.Code != 200 {
		t.Errorf("flag on: %d %s", r.Code, r.Body.String())
	}
}

// MFHX-13 (S6): a re-map that lands while a commit waits is seen by the commit: no row is left under
// the old scheme.
func TestMFCommitSeesConcurrentRemap(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund Direct", "direct", "growth", "2026-11-10=20")
	e.scheme(202, "Alpha Fund Regular", "regular", "growth", "2026-11-10=19")
	e.mapFund("Alpha Fund", 201)
	v := e.validateMF(mfhHdr + "05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0\n")
	id := v["upload_id"].(string)
	ctx := context.Background()
	// Another writer holds the fund-name lock PutMapping takes, and re-maps the name.
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7013, hashtext('alpha fund'))`); err != nil {
		t.Fatal(err)
	}
	type out struct {
		code int
		body string
	}
	done := make(chan out, 1)
	go func() {
		r, _ := e.commitMF(id)
		done <- out{r.Code, r.Body.String()}
	}()
	select {
	case o := <-done:
		t.Fatalf("the commit did not wait for the fund-name lock: %d %s", o.code, o.body)
	case <-time.After(500 * time.Millisecond):
	}
	if _, err := tx.Exec(ctx, `UPDATE mf_fund_name_map SET scheme_code = 202 WHERE fund_name_key = 'alpha fund'`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case o := <-done:
		if o.code != 200 {
			t.Fatalf("commit: %d %s", o.code, o.body)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the commit never finished")
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 202`); n != 1 {
		t.Errorf("row not stored under the re-mapped scheme")
	}
	if n := e.count(`SELECT count(*) FROM mf_txn WHERE scheme_code = 201`); n != 0 {
		t.Errorf("a row was left under the old scheme")
	}
}

// MFHX-14 (S7): scheme_code of the txn list is a full-match int4; anything else is 422, never 500.
func TestMFTxnListSchemeCodeParam(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mustTxn(101, "F1", "purchase", "2026-01-05", "10", "10", "100", "0")
	for _, q := range []string{"1abc", "101abc", "0", "-5", "99999999999", "2147483648", "1.5", "%201", "1%20", "abc", "0x65", "+101"} {
		r, b := e.api(http.MethodGet, "/portfolio/mf/txns?scheme_code="+q, "", nil)
		if r.Code != 422 || len(mfFieldsOf(b)) == 0 || mfFieldsOf(b)[0] != "scheme_code" {
			t.Errorf("scheme_code=%q: %d %s", q, r.Code, r.Body.String())
		}
	}
	for q, want := range map[string]int{"101": 1, "2147483647": 0, "1": 0} {
		r, b := e.api(http.MethodGet, "/portfolio/mf/txns?scheme_code="+q, "", nil)
		var d struct {
			Items []any `json:"items"`
		}
		b.into(t, &d)
		if r.Code != 200 || len(d.Items) != want {
			t.Errorf("scheme_code=%s: %d items %d", q, r.Code, len(d.Items))
		}
	}
}

// MFHX-15 (S9): an errored row can be excluded at commit; excluding does not hide other errors;
// an invalid line is 422 field excluded_rows.
func TestMFCommitExcludesErroredRow(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(201, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mapFund("Alpha Fund", 201)
	csv := mfhHdr +
		"05-Nov-2026,Alpha Fund,Purchase,F1,1.000,10.000,10.00,0\n" + // line 2 ok
		"06-Nov-2026,Alpha Fund,Purchase,F1,-1.000,10.000,10.00,0\n" + // line 3 error
		"07-Nov-2026,Alpha Fund,Purchase,F1,3.000,10.000,30.00,0\n" + // line 4 ok
		"08-Nov-2026,Alpha Fund,Purchase,F1,x,10.000,10.00,0\n" // line 5 error
	v := e.validateMF(csv)
	if mfhInt(v["error_count"]) != 2 {
		t.Fatalf("errors: %v", v["errors"])
	}
	// Excluding only one of two errored rows still blocks.
	if r, _ := e.commitMF(v["upload_id"].(string), 3); r.Code != 422 {
		t.Errorf("one error left: %d", r.Code)
	}
	v = e.validateMF(csv)
	if r, b := e.commitMF(v["upload_id"].(string), 99); r.Code != 422 || !strings.Contains(r.Body.String(), "excluded_rows") {
		t.Errorf("unknown line: %d %v", r.Code, b)
	}
	v = e.validateMF(csv)
	r, d := e.commitMF(v["upload_id"].(string), 3, 5)
	if r.Code != 200 || mfhInt(d["inserted"]) != 2 {
		t.Fatalf("both errored rows excluded: %d %s", r.Code, r.Body.String())
	}
	if n := e.count(`SELECT count(*) FROM mf_txn`); n != 2 {
		t.Errorf("stored %d rows", n)
	}
	// A header problem can never be excluded away.
	hv := e.validateMF("a,b\n1,2\n")
	if r, _ := e.commitMF(hv["upload_id"].(string), 1, 2); r.Code != 422 {
		t.Errorf("header error: %d", r.Code)
	}
}

// MFHX-16 (N2): an edit is validated against its own folio only, and warns UNITS_ROUNDED like create.
func TestMFUpdateScopedToItsFolios(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=20")
	e.mustTxn(101, "F1", "purchase", "2026-01-05", "10", "10", "100", "0")
	red := e.mustTxn(101, "F1", "redemption", "2026-02-01", "4", "11", "44", "0")
	// An unrelated folio that is already inconsistent (a redemption with no purchase, e.g. a bad restore).
	e.exec(`INSERT INTO mf_txn (scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty, source)
		VALUES (101, 'BROKEN', 'redemption', '2026-02-01', 5, 11, 55, 0, 'manual')`)
	r, b := e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", red), `{"note":"edited"}`, nil)
	if r.Code != 200 {
		t.Fatalf("an unrelated inconsistent folio blocked the edit: %d %s", r.Code, r.Body.String())
	}
	if b.warned("UNITS_ROUNDED") {
		t.Error("no rounding here")
	}
	// Still refused when the edit itself breaks its own folio.
	if r, b := e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", red), `{"units":"11"}`, nil); r.Code != 422 || b.Error.Code != "INSUFFICIENT_UNITS" {
		t.Errorf("own-folio oversell: %d %s", r.Code, r.Body.String())
	}
	// Dust on update warns like create.
	r, b = e.api(http.MethodPatch, fmt.Sprintf("/portfolio/mf/txns/%d", red), `{"units":"10.0005"}`, nil)
	if r.Code != 200 || !b.warned("UNITS_ROUNDED") {
		t.Errorf("dust on update: %d %s", r.Code, r.Body.String())
	}
}

// MFHX-17 (S10): the XIRR of a real ledger is asserted by number, not by comparison.
func TestMFXIRRFromRows(t *testing.T) {
	e := newMFHEnv(t)
	e.scheme(101, "Alpha Fund", "direct", "growth", "2026-11-10=15")
	// 100 invested on 2024-11-11, worth 150 on 2026-11-11: exactly 730 days, so XIRR = sqrt(1.5) - 1 = 22.4745 %.
	e.mustTxn(101, "F1", "purchase", "2024-11-11", "10", "10", "100", "0")
	want := (math.Sqrt(1.5) - 1) * 100
	var mf struct {
		Returns struct {
			XIRR *float64 `json:"xirr_pct"`
			Abs  *float64 `json:"absolute_return_pct"`
			Span *int     `json:"span_days"`
		} `json:"returns"`
	}
	_, b := e.api(http.MethodGet, "/portfolio/summary?view=mf", "", nil)
	b.into(t, &mf)
	if mf.Returns.XIRR == nil || math.Abs(*mf.Returns.XIRR-want) > 0.01 || mf.Returns.Abs == nil || *mf.Returns.Abs != 50 || *mf.Returns.Span != 730 {
		t.Errorf("summary mf returns %+v want xirr %.4f", mf.Returns, want)
	}
	var h struct {
		Items []struct {
			XIRR *float64 `json:"xirr_pct"`
			Abs  *float64 `json:"absolute_return_pct"`
		} `json:"items"`
	}
	_, hb := e.api(http.MethodGet, "/portfolio/mf/holdings", "", nil)
	hb.into(t, &h)
	if len(h.Items) != 1 || h.Items[0].XIRR == nil || math.Abs(*h.Items[0].XIRR-want) > 0.01 || *h.Items[0].Abs != 50 {
		t.Errorf("holding returns %+v", h.Items)
	}
	// The all view with no equity rows pools the same flows: the same number.
	var all struct {
		Returns struct {
			XIRR *float64 `json:"xirr_pct"`
		} `json:"returns"`
		Benchmark map[string]any `json:"benchmark"`
	}
	_, ab := e.api(http.MethodGet, "/portfolio/summary?view=all", "", nil)
	ab.into(t, &all)
	if all.Returns.XIRR == nil || math.Abs(*all.Returns.XIRR-want) > 0.01 {
		t.Errorf("all xirr %v want %.4f", all.Returns.XIRR, want)
	}
	// N1: the benchmark of the all and mf views has the same keys as the equity one, with null values.
	for _, k := range []string{"code", "xirr_pct", "reason", "level_as_of", "note"} {
		if _, ok := all.Benchmark[k]; !ok {
			t.Errorf("benchmark of view=all lacks %q: %v", k, all.Benchmark)
		}
	}
	if all.Benchmark["code"] != nil || all.Benchmark["reason"] != "not_defined_for_view" {
		t.Errorf("benchmark: %v", all.Benchmark)
	}
}
