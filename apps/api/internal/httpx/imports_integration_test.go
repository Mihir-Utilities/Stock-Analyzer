package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/importers"
	"github.com/india-analyzer/api/internal/jobs"
)

type importEnv struct {
	*authEnv
	cookie string
	svc    *importers.Service
	jobs   *jobs.Service
}

func newImportEnv(t *testing.T) *importEnv {
	t.Helper()
	e := newAuthEnv(t)
	js := jobs.New(e.pool, nil, jobs.Config{Cooldown: 15 * time.Minute, GlobalHour: 30}, zerolog.Nop())
	svc := importers.New(e.pool, js, 380, zerolog.Nop())
	svc.DBSize = func(context.Context) (int64, error) { return 10 << 20, nil }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Jobs: js, Imports: svc})
	return &importEnv{authEnv: e, cookie: e.login(ownerPassword), svc: svc, jobs: js}
}

func (e *importEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *importEnv) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

type upload struct {
	field, filename, ctype string
	content                string
	group                  string
}

func (e *importEnv) upload(kind string, u upload, cookie string, csrf bool) resp {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if u.group != "" {
		_ = mw.WriteField("upload_group", u.group)
	}
	if u.field == "" {
		u.field = "file"
	}
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, u.field, u.filename))
	if u.ctype != "" {
		h.Set("Content-Type", u.ctype)
	}
	part, _ := mw.CreatePart(h)
	_, _ = part.Write([]byte(u.content))
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/imports/"+kind+"/validate", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if csrf {
		req.Header.Set(CSRFHeader, CSRFValue)
	}
	if cookie != "" {
		req.Header.Add("Cookie", SessionCookie+"="+cookie)
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return resp{rec}
}

func (e *importEnv) validate(kind, csv string) map[string]any {
	e.t.Helper()
	r := e.upload(kind, upload{filename: kind + ".csv", ctype: "text/csv", content: csv}, e.cookie, true)
	if r.Code != 200 {
		e.t.Fatalf("validate %d %s", r.Code, r.Body.String())
	}
	return decodeData(e.t, r)
}

func decodeData(t *testing.T, r resp) map[string]any {
	t.Helper()
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &env); err != nil {
		t.Fatalf("%v: %s", err, r.Body.String())
	}
	return env.Data
}

func errCode(t *testing.T, r resp) string {
	t.Helper()
	var env struct {
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &env); err != nil {
		t.Fatalf("%v: %s", err, r.Body.String())
	}
	return env.Error.Code
}

func (e *importEnv) post(path, body string) resp {
	return e.do(http.MethodPost, "/api/v1"+path, body, e.cookie, nil)
}

const pHdr = "symbol,date,open,high,low,close,volume\n"

// Routes of B06a are authenticated and CSRF-protected like every other mutating route.
func TestImportsAuthAndCSRF(t *testing.T) {
	e := newImportEnv(t)
	u := upload{filename: "p.csv", ctype: "text/csv", content: pHdr}
	if r := e.upload("prices", u, "", true); r.Code != 401 {
		t.Errorf("no session: %d", r.Code)
	}
	if r := e.upload("prices", u, e.cookie, false); r.Code != 403 {
		t.Errorf("no csrf header: %d", r.Code)
	}
	if r := e.do(http.MethodGet, "/api/v1/imports/templates/prices", "", "", nil); r.Code != 401 {
		t.Errorf("template without session: %d", r.Code)
	}
	if r := e.do(http.MethodGet, "/api/v1/settings/prices-adjustment", "", "", nil); r.Code != 401 {
		t.Errorf("setting without session: %d", r.Code)
	}
}

// IMP-01, IMP-16, IMP-13/SEC-05 (type), SAF-05 at the HTTP boundary.
func TestImportValidateHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'Triple A')`)

	d := e.validate("prices", "\xEF\xBB\xBFsymbol;date;open;high;low;close;volume\r\nAAA;05-01-2026;100;102;99;101;1000\r\nAAA;06-Jan-2026;1234,5;1;1;1;1\r\n")
	if d["rows"].(float64) != 2 || d["error_count"].(float64) != 1 || d["upload_group"] != nil || d["prices_already_adjusted"] != nil {
		t.Fatalf("validate body %v", d)
	}
	errs := d["errors"].([]any)
	first := errs[0].(map[string]any)
	if first["row"].(float64) != 3 || first["column"] != "open" || !strings.Contains(first["message"].(string), "1234,5") {
		t.Errorf("error entry %v", first)
	}
	if len(d["preview"].([]any)) != 1 || d["estimated_growth_mb"] == nil {
		t.Errorf("preview/growth %v", d)
	}

	// IMP-01: wrong header.
	r := e.upload("prices", upload{filename: "p.csv", ctype: "text/csv", content: "sym,date\nA,B\n"}, e.cookie, true)
	d = decodeData(e.t, r)
	if r.Code != 200 || d["error_count"].(float64) != 1 || !strings.Contains(d["errors"].([]any)[0].(map[string]any)["message"].(string), "templates/prices") {
		t.Errorf("header error: %d %s", r.Code, r.Body.String())
	}

	// Wrong MIME type or extension, xlsx content, UTF-16: 422 with the file field.
	for name, u := range map[string]upload{
		"pdf mime":    {filename: "p.csv", ctype: "application/pdf", content: pHdr},
		"xlsx name":   {filename: "p.xlsx", ctype: "text/csv", content: pHdr},
		"zip content": {filename: "p.csv", ctype: "text/csv", content: "PK\x03\x04abc"},
		"utf16":       {filename: "p.csv", ctype: "text/csv", content: "\xFF\xFEs\x00y\x00"},
		"no file":     {field: "other", filename: "p.csv", ctype: "text/csv", content: pHdr},
	} {
		if r := e.upload("prices", u, e.cookie, true); r.Code != 422 || errCode(t, r) != "UNPROCESSABLE" {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}

	// IMP-13: more than 5 MB for prices (S9 not passed) is 413; the 25 MB class is 413 before the body is read.
	big := pHdr + strings.Repeat("AAA,2026-01-05,100,102,99,101,1000\n", 5<<20/35+1000)
	if r := e.upload("prices", upload{filename: "p.csv", ctype: "text/csv", content: big}, e.cookie, true); r.Code != 413 {
		t.Errorf("oversized prices: %d %s", r.Code, truncate(r.Body.String()))
	}
	if r := e.upload("instruments", upload{filename: "i.csv", ctype: "text/csv", content: "symbol,name\n" + strings.Repeat("A,B\n", 1000)}, e.cookie, true); r.Code != 200 {
		t.Errorf("instruments: %d", r.Code)
	}
	// More than 50,000 rows within 5 MB: 422.
	many := pHdr + strings.Repeat("AAA,2026-01-05,1,2,1,1,1\n", 50_001)
	if r := e.upload("prices", upload{filename: "p.csv", ctype: "text/csv", content: many}, e.cookie, true); r.Code != 422 {
		t.Errorf("too many rows: %d %s", r.Code, truncate(r.Body.String()))
	}

	// Kinds: unknown 404, screener_xlsx (SAF-05: not built, flag off) 404, B06b kinds are served
	// (a wrong header is a validation result, not a 501).
	for kind, want := range map[string]int{"nonsense": 404, "screener_xlsx": 404, "results_quarterly": 200, "holidays": 200} {
		if r := e.upload(kind, upload{filename: "x.csv", ctype: "text/csv", content: pHdr}, e.cookie, true); r.Code != want {
			t.Errorf("kind %s: %d, want %d", kind, r.Code, want)
		}
	}
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

// IMP-11, IMP-25, IMP-10 and the commit contract, end to end over HTTP.
func TestImportCommitHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'Triple A')`)

	bad := e.validate("prices", pHdr+"ZZZ,2026-01-05,1,2,1,1,1\n")
	r := e.post("/imports/prices/commit", fmt.Sprintf(`{"upload_id":%q}`, bad["upload_id"]))
	if r.Code != 422 || errCode(t, r) != "UNPROCESSABLE" {
		t.Fatalf("IMP-11: %d %s", r.Code, r.Body.String())
	}

	ok := e.validate("prices", pHdr+"AAA,2026-01-05,100,102,99,101,1000\nAAA,2026-01-06,101,103,100,102,1100\n")
	body := fmt.Sprintf(`{"upload_id":%q,"note":"as per broker file"}`, ok["upload_id"])
	r = e.post("/imports/prices/commit", body)
	if r.Code != 422 || errCode(t, r) != "PRICES_ADJUSTMENT_UNSET" {
		t.Fatalf("IMP-25: %d %s", r.Code, r.Body.String())
	}
	if r := e.do(http.MethodGet, "/api/v1/settings/prices-adjustment", "", e.cookie, nil); r.Code != 200 || decodeData(t, r)["value"] != nil {
		t.Fatalf("setting: %s", r.Body.String())
	}
	if r := e.do(http.MethodPut, "/api/v1/settings/prices-adjustment", `{}`, e.cookie, nil); r.Code != 422 {
		t.Errorf("missing value: %d", r.Code)
	}
	if r := e.do(http.MethodPut, "/api/v1/settings/prices-adjustment", `{"value":false}`, e.cookie, nil); r.Code != 200 || decodeData(t, r)["value"] != false {
		t.Fatalf("put raw: %s", r.Body.String())
	}
	if r := e.do(http.MethodPut, "/api/v1/settings/prices-adjustment", `{"value":true}`, e.cookie, nil); r.Code != 422 {
		t.Errorf("changing without confirm: %d", r.Code)
	}
	r = e.post("/imports/prices/commit", body)
	if r.Code != 200 {
		t.Fatalf("commit: %d %s", r.Code, r.Body.String())
	}
	d := decodeData(t, r)
	if d["inserted"].(float64) != 2 || d["updated"].(float64) != 0 || d["batch_id"] == nil || d["post_import_job_id"] == nil || len(d["warnings"].([]any)) != 0 {
		t.Fatalf("commit body %v", d)
	}
	jr := e.do(http.MethodGet, fmt.Sprintf("/api/v1/jobs/%v", d["post_import_job_id"]), "", e.cookie, nil)
	if jr.Code != 200 || !strings.Contains(jr.Body.String(), `"post_import"`) {
		t.Errorf("job: %d %s", jr.Code, jr.Body.String())
	}
	if r := e.post("/imports/prices/commit", body); r.Code != 404 || errCode(t, r) != "NOT_FOUND" {
		t.Errorf("second commit: %d", r.Code)
	}
	if r := e.post("/imports/prices/commit", `{"upload_id":"x","extra":1}`); r.Code != 400 {
		t.Errorf("unknown field: %d", r.Code)
	}
	if r := e.post("/imports/results_quarterly/commit", body); r.Code != 404 {
		t.Errorf("a consumed prices upload is not a results upload: %d", r.Code)
	}

	// Batches list and undo refusal (price batches are not undoable: 409).
	br := e.do(http.MethodGet, "/api/v1/imports/batches?limit=5", "", e.cookie, nil)
	items := decodeData(t, br)["items"].([]any)
	if br.Code != 200 || len(items) != 1 || items[0].(map[string]any)["kind"] != "prices" {
		t.Fatalf("batches %d %s", br.Code, br.Body.String())
	}
	if r := e.post(fmt.Sprintf("/imports/batches/%v/undo", d["batch_id"]), ""); r.Code != 409 {
		t.Errorf("undo prices: %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/imports/batches/9999/undo", ""); r.Code != 404 {
		t.Errorf("undo missing: %d", r.Code)
	}
	if r := e.do(http.MethodGet, "/api/v1/imports/batches?limit=0", "", e.cookie, nil); r.Code != 422 {
		t.Errorf("limit 0: %d", r.Code)
	}
}

func TestTemplatesHTTP(t *testing.T) {
	e := newImportEnv(t)
	for _, kind := range []string{"prices", "instruments"} {
		r := e.do(http.MethodGet, "/api/v1/imports/templates/"+kind, "", e.cookie, nil)
		if r.Code != 200 || !strings.HasPrefix(r.Header().Get("Content-Type"), "text/csv") ||
			!strings.Contains(r.Header().Get("Content-Disposition"), kind+"_template.csv") || strings.Count(r.Body.String(), "\n") != 2 {
			t.Errorf("%s: %d %v %q", kind, r.Code, r.Header(), r.Body.String())
		}
	}
	if r := e.do(http.MethodGet, "/api/v1/imports/templates/nonsense", "", e.cookie, nil); r.Code != 404 {
		t.Errorf("unknown: %d", r.Code)
	}
	for _, kind := range importers.AllKinds {
		if r := e.do(http.MethodGet, "/api/v1/imports/templates/"+kind, "", e.cookie, nil); r.Code != 200 {
			t.Errorf("template %s: %d", kind, r.Code)
		}
	}
}

// POST /instruments, IMP-17 parity at the API, and CSV-injection text stored verbatim (IMP-15).
func TestAddInstrumentHTTP(t *testing.T) {
	e := newImportEnv(t)
	r := e.post("/instruments", `{"symbol":"TCS","name":"Tata Consultancy Services Ltd","isin":"INE467B01029"}`)
	if r.Code != 201 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	d := decodeData(t, r)
	if d["symbol"] != "TCS" || d["id"].(float64) < 1 || len(d["warnings"].([]any)) != 0 {
		t.Errorf("%v", d)
	}
	if r := e.post("/instruments", `{"symbol":"TCS","name":"again"}`); r.Code != 409 {
		t.Errorf("duplicate: %d", r.Code)
	}
	r = e.post("/instruments", `{"symbol":"bad sym","name":""}`)
	if r.Code != 422 || strings.Count(r.Body.String(), `"field"`) != 2 {
		t.Errorf("validation: %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/instruments", `{"symbol":"X","name":"n","extra":1}`); r.Code != 400 {
		t.Errorf("unknown field: %d", r.Code)
	}
	r = e.post("/instruments", `{"symbol":"WARN","name":"=cmd|' /C calc'!A0","isin":"XX"}`)
	if r.Code != 201 || !strings.Contains(r.Body.String(), "ISIN_MALFORMED") {
		t.Errorf("warnings: %d %s", r.Code, r.Body.String())
	}
	var name string
	_ = e.pool.QueryRow(context.Background(), `SELECT name FROM instrument WHERE symbol='WARN'`).Scan(&name)
	if name != "=cmd|' /C calc'!A0" {
		t.Errorf("stored name %q", name)
	}
}

// PRC-21 and trim over HTTP.
func TestPriceManagementHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('M&M', 'Mahindra'), ('BBB', 'B')`)
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source)
		SELECT id, d::date, 1, 2, 1, 1, 1, 'import' FROM instrument, unnest(ARRAY['2026-01-05','2026-01-06','2026-01-07']) d`)
	pr := e.post("/stocks/M%26M/prices/delete-preview?from=2026-01-05&to=2026-01-06", "")
	if pr.Code != 200 || decodeData(t, pr)["rows"].(float64) != 2 {
		t.Fatalf("preview %d %s", pr.Code, pr.Body.String())
	}
	del := func(q, body string) resp {
		return e.do(http.MethodDelete, "/api/v1/stocks/M%26M/prices?"+q, body, e.cookie, nil)
	}
	for name, r := range map[string]resp{
		"no confirm":   del("from=2026-01-05&to=2026-01-06", `{}`),
		"from > to":    del("from=2026-01-06&to=2026-01-05", `{"confirm":true}`),
		"missing to":   del("from=2026-01-06", `{"confirm":true}`),
		"bad date":     del("from=x&to=2026-01-05", `{"confirm":true}`),
		"confirm text": del("from=2026-01-05&to=2026-01-06", `{"confirm":"yes"}`),
	} {
		if r.Code != 422 && r.Code != 400 {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 6 {
		t.Fatal("rejected deletes must not delete")
	}
	r := del("from=2026-01-05&to=2026-01-06", `{"confirm":true}`)
	d := decodeData(t, r)
	if r.Code != 200 || d["deleted"].(float64) != 2 || d["job_id"] == nil {
		t.Fatalf("delete %d %s", r.Code, r.Body.String())
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 4 {
		t.Error("two rows removed, other stocks untouched")
	}
	if r := e.do(http.MethodDelete, "/api/v1/stocks/NOPE/prices?from=2026-01-05&to=2026-01-06", `{"confirm":true}`, e.cookie, nil); r.Code != 404 {
		t.Errorf("unknown symbol: %d", r.Code)
	}

	tp := e.post("/prices/trim/preview", `{"symbols":["M&M","BBB"],"before":"2026-01-07"}`)
	td := decodeData(t, tp)
	if tp.Code != 200 || td["total_rows"].(float64) != 2 || len(td["per_symbol"].([]any)) != 2 {
		t.Fatalf("trim preview %d %s", tp.Code, tp.Body.String())
	}
	if r := e.post("/prices/trim", `{"symbols":["BBB"],"before":"2026-01-07"}`); r.Code != 422 {
		t.Errorf("trim without confirm: %d", r.Code)
	}
	r = e.post("/prices/trim", `{"symbols":["M&M","BBB"],"before":"2026-01-07","confirm":true}`)
	if r.Code != 200 || decodeData(t, r)["deleted"].(float64) != 2 || e.count(`SELECT count(*) FROM price_daily`) != 2 {
		t.Fatalf("trim %d %s", r.Code, r.Body.String())
	}
	if e.count(`SELECT count(*) FROM import_batch WHERE kind='manual_form'`) != 2 {
		t.Error("audit rows")
	}
}

// IMP-26 over HTTP: validates the body shape and reads only the upload.
func TestAdjustmentCheckHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'A')`)
	v := e.validate("prices", pHdr+"AAA,2026-01-05,100,101,99,100,1\nAAA,2026-01-06,100,101,99,100,1\nAAA,2026-01-07,50,51,49,50,1\nAAA,2026-01-08,50,51,49,50,1\n")
	r := e.post("/imports/prices/adjustment-check", fmt.Sprintf(`{"upload_id":%q,"symbol":"AAA","ex_date":"2026-01-07","expected_ratio":{"num":1,"den":2}}`, v["upload_id"]))
	d := decodeData(t, r)
	if r.Code != 200 || d["hint"] != "raw_likely" || d["nearest_fraction"] != "1/2" || d["ratio"].(float64) != 0.5 || len(d["bars"].([]any)) != 4 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	for name, body := range map[string]string{
		"unknown symbol": fmt.Sprintf(`{"upload_id":%q,"symbol":"ZZZ","ex_date":"2026-01-07"}`, v["upload_id"]),
		"date outside":   fmt.Sprintf(`{"upload_id":%q,"symbol":"AAA","ex_date":"2027-01-07"}`, v["upload_id"]),
		"ratio half":     fmt.Sprintf(`{"upload_id":%q,"symbol":"AAA","ex_date":"2026-01-07","expected_ratio":{"num":1}}`, v["upload_id"]),
	} {
		if r := e.post("/imports/prices/adjustment-check", body); r.Code != 422 {
			t.Errorf("%s: %d %s", name, r.Code, r.Body.String())
		}
	}
	if r := e.post("/imports/prices/adjustment-check", `{"upload_id":"00000000-0000-4000-8000-000000000000","symbol":"AAA","ex_date":"2026-01-07"}`); r.Code != 404 {
		t.Errorf("unknown upload: %d", r.Code)
	}
	if e.count(`SELECT count(*) FROM price_daily`) != 0 {
		t.Error("the check writes nothing")
	}
}
