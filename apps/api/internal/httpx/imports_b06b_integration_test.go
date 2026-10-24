package httpx

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// HTTP-level tests of the B06b routes: the other import kinds, undo, and the manual-entry endpoints.

func fieldsOf(t *testing.T, r resp) map[string]bool {
	t.Helper()
	var env struct {
		Error struct {
			Details struct {
				Fields []struct {
					Field string `json:"field"`
				} `json:"fields"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &env); err != nil {
		t.Fatalf("%v: %s", err, r.Body.String())
	}
	out := map[string]bool{}
	for _, f := range env.Error.Details.Fields {
		out[f.Field] = true
	}
	return out
}

func TestOtherKindsImportAndUndoHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'AAA Ltd')`)
	csv := "symbol,basis,period_end,revenue,net_profit\nAAA,consolidated,2026-06-30,100,30\nAAA,consolidated,2026-03-31,90,25\n"
	d := e.validate("results_quarterly", csv)
	if d["error_count"].(float64) != 0 || d["rows"].(float64) != 2 || len(d["preview"].([]any)) != 2 {
		t.Fatalf("validate %+v", d)
	}
	// A wrong quarter end is reported with its row and column; the commit is refused (IMP-11).
	bad := e.validate("results_quarterly", "symbol,basis,period_end,revenue\nAAA,consolidated,2026-06-29,1\n")
	errs := bad["errors"].([]any)
	if len(errs) != 1 || errs[0].(map[string]any)["row"].(float64) != 2 || errs[0].(map[string]any)["column"] != "period_end" {
		t.Fatalf("errors %+v", bad["errors"])
	}
	if r := e.post("/imports/results_quarterly/commit", fmt.Sprintf(`{"upload_id":%q}`, bad["upload_id"])); r.Code != 422 || errCode(t, r) != "UNPROCESSABLE" {
		t.Errorf("commit with errors: %d %s", r.Code, r.Body.String())
	}
	r := e.post("/imports/results_quarterly/commit", fmt.Sprintf(`{"upload_id":%q,"note":"as per filing dated 2026-08-12"}`, d["upload_id"]))
	c := decodeData(t, r)
	if r.Code != 200 || c["inserted"].(float64) != 4 || c["post_import_job_id"] == nil {
		t.Fatalf("commit %d %s", r.Code, r.Body.String())
	}
	u := e.post(fmt.Sprintf("/imports/batches/%v/undo", c["batch_id"]), "")
	ud := decodeData(t, u)
	if u.Code != 200 || ud["removed"].(float64) != 4 || ud["batch_id"] != c["batch_id"] {
		t.Fatalf("undo %d %s", u.Code, u.Body.String())
	}
	if e.count(`SELECT count(*) FROM fundamental_value`) != 0 {
		t.Error("rows remain after undo")
	}
	if r := e.post(fmt.Sprintf("/imports/batches/%v/undo", c["batch_id"]), ""); r.Code != 409 {
		t.Errorf("second undo: %d", r.Code)
	}
	// Holidays: validate, commit, not undoable (409).
	h := e.validate("holidays", "date,description,segment\n2026-01-26,Republic Day,\n")
	hc := decodeData(t, e.post("/imports/holidays/commit", fmt.Sprintf(`{"upload_id":%q}`, h["upload_id"])))
	if hc["inserted"].(float64) != 1 || hc["post_import_job_id"] != nil {
		t.Errorf("holidays commit %+v", hc)
	}
	if r := e.post(fmt.Sprintf("/imports/batches/%v/undo", hc["batch_id"]), ""); r.Code != 409 {
		t.Errorf("holidays undo: %d", r.Code)
	}
	// SEC-05 on another kind: a spreadsheet is refused with 422 on the file field.
	if r := e.upload("shareholding", upload{filename: "x.csv", ctype: "text/csv", content: "PK\x03\x04binary"}, e.cookie, true); r.Code != 422 || !fieldsOf(t, r)["file"] {
		t.Errorf("zip content: %d %s", r.Code, truncate(r.Body.String()))
	}
	if r := e.upload("shareholding", upload{filename: "x.xlsx", ctype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "x"}, e.cookie, true); r.Code != 422 {
		t.Errorf("xlsx upload: %d", r.Code)
	}
}

func TestManualEntryHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'AAA Ltd'), ('M&M', 'Mahindra'), ('GONE', 'Gone Ltd')`)
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE symbol = 'GONE'`)
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol) SELECT id, 'OLDA' FROM instrument WHERE symbol = 'AAA'`)
	// Numbers as JSON numbers or strings; both reach the same validator.
	body := `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values":{"revenue":1234.5,"net_profit":"300","eps":null},"note":"as per filing dated 2026-10-20"}`
	r := e.post("/stocks/AAA/results", body)
	d := decodeData(t, r)
	if r.Code != 201 || d["inserted"].(float64) != 2 || d["batch_id"] == nil || d["post_import_job_id"] == nil || len(d["warnings"].([]any)) != 0 {
		t.Fatalf("results %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/stocks/aaa/results", body); r.Code != 200 {
		t.Errorf("restated period: %d", r.Code)
	}
	if e.count(`SELECT count(*) FROM fundamental_value WHERE source = 'manual'`) != 2 {
		t.Error("manual rows")
	}
	if r := e.post("/stocks/M%26M/shareholding", `{"quarter_end":"2026-06-30","promoter":50,"fii":20,"dii":15,"govt":1,"public":14,"mf":9,"insurance":3,"shareholders_count":41000}`); r.Code != 201 {
		t.Errorf("shareholding for M&M: %d %s", r.Code, r.Body.String())
	}
	ar := e.post("/stocks/AAA/actions", `{"ex_date":"2026-02-10","type":"split","ratio_num":10,"ratio_den":2,"purpose_text":"FV 10 to 2"}`)
	if ad := decodeData(t, ar); ar.Code != 201 || ad["id"] == nil {
		t.Errorf("action %d %s", ar.Code, ar.Body.String())
	}
	// 422 with details.fields (form field names); 404 unknown or old symbol; delisted 422.
	if r := e.post("/stocks/AAA/results", `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-29","values":{"revenue":"1234,56"}}`); r.Code != 422 ||
		!fieldsOf(t, r)["period_end"] || !fieldsOf(t, r)["values.revenue"] {
		t.Errorf("validation %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/stocks/AAA/shareholding", `{"quarter_end":"2026-06-15"}`); r.Code != 422 || !fieldsOf(t, r)["quarter_end"] {
		t.Errorf("SHP-05: %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/stocks/AAA/actions", `{"ex_date":"2026-02-10","type":"bonus"}`); r.Code != 422 || !fieldsOf(t, r)["ratio_num"] {
		t.Errorf("action validation: %d %s", r.Code, r.Body.String())
	}
	for _, p := range []string{"/stocks/NOPE/results", "/stocks/OLDA/results"} {
		if r := e.post(p, body); r.Code != 404 {
			t.Errorf("%s: %d", p, r.Code)
		}
	}
	if r := e.post("/stocks/GONE/results", body); r.Code != 422 || !fieldsOf(t, r)["symbol"] {
		t.Errorf("IMP-18 delisted: %d %s", r.Code, r.Body.String())
	}
	// Strict bodies: unknown top-level field and a boolean cell are 400.
	if r := e.post("/stocks/AAA/results", `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values":{},"extra":1}`); r.Code != 400 {
		t.Errorf("unknown field: %d", r.Code)
	}
	if r := e.post("/stocks/AAA/results", `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values":{"revenue":true}}`); r.Code != 400 {
		t.Errorf("boolean cell: %d", r.Code)
	}
	// DELETE removes the manual period; unknown period 404; bad query 422.
	q := "/api/v1/stocks/AAA/results?period_type=Q&period_end=2026-09-30&basis=consolidated"
	dr := e.do(http.MethodDelete, q, "", e.cookie, nil)
	if dd := decodeData(t, dr); dr.Code != 200 || dd["deleted"].(float64) != 2 {
		t.Errorf("delete %d %s", dr.Code, dr.Body.String())
	}
	if r := e.do(http.MethodDelete, q, "", e.cookie, nil); r.Code != 404 {
		t.Errorf("second delete: %d", r.Code)
	}
	if r := e.do(http.MethodDelete, "/api/v1/stocks/AAA/results?period_type=Z", "", e.cookie, nil); r.Code != 422 {
		t.Errorf("bad query: %d", r.Code)
	}
	// Auth: without the session the manual routes are 401.
	if r := e.do(http.MethodPost, "/api/v1/stocks/AAA/results", body, "", nil); r.Code != 401 {
		t.Errorf("no session: %d", r.Code)
	}
	if e.count(`SELECT count(*) FROM import_batch WHERE kind = 'manual_form'`) != 5 {
		t.Error("every manual write and delete leaves an audit batch")
	}
}

// IMP-53: review B08-1, undoing an imported corporate action that has a portfolio adjustment is a 409 with
// code UNDO_HAS_DEPENDENTS (never a 500) and changes nothing.
func TestUndoCorporateActionsWithAdjustmentHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'AAA Ltd')`)
	d := e.validate("corporate_actions", "symbol,ex_date,type,ratio_num,ratio_den,amount_per_share,purpose_text\nAAA,2026-02-10,split,10,2,,x\n")
	cr := e.post("/imports/corporate_actions/commit", fmt.Sprintf(`{"upload_id":%q}`, d["upload_id"]))
	c := decodeData(t, cr)
	e.exec(`INSERT INTO portfolio_adjustment (instrument_id, corporate_action_id, effective_date, qty_multiplier)
		SELECT instrument_id, id, ex_date, 5 FROM corporate_action`)
	u := e.post(fmt.Sprintf("/imports/batches/%v/undo", c["batch_id"]), "")
	if u.Code != 409 || errCode(t, u) != "UNDO_HAS_DEPENDENTS" || !strings.Contains(u.Body.String(), "portfolio_adjustment") {
		t.Fatalf("undo: %d %s", u.Code, u.Body.String())
	}
	if e.count(`SELECT count(*) FROM corporate_action`) != 1 || e.count(`SELECT count(*) FROM portfolio_adjustment`) != 1 {
		t.Error("nothing may change")
	}
}

// IMP-56: review B08-6/7: a JSON number in exponent notation and keys differing only by case are clear 422s.
func TestManualResultsExponentAndDuplicateHTTP(t *testing.T) {
	e := newImportEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ('AAA', 'AAA Ltd')`)
	r := e.post("/stocks/AAA/results", `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values":{"revenue":1e5}}`)
	if r.Code != 422 || !fieldsOf(t, r)["values.revenue"] || !strings.Contains(r.Body.String(), "exponent notation not accepted") {
		t.Errorf("1e5: %d %s", r.Code, r.Body.String())
	}
	r = e.post("/stocks/AAA/results", `{"basis":"consolidated","period_type":"Q","period_end":"2026-09-30","values":{"Revenue":1,"revenue":2}}`)
	if r.Code != 422 || !strings.Contains(r.Body.String(), "duplicate key") {
		t.Errorf("duplicate: %d %s", r.Code, r.Body.String())
	}
}
