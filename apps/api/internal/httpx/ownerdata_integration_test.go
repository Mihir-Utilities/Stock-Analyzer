package httpx

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/ownerdata"
	"github.com/india-analyzer/api/internal/testdb"
)

func newOwnerEnv(t *testing.T) *stockEnv {
	t.Helper()
	e := newAuthEnv(t)
	links, err := ownerdata.LoadLinks(testdb.ConfigDir() + "/research_links.json")
	if err != nil {
		t.Fatal(err)
	}
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{},
		OwnerData: ownerdata.New(e.pool, links)})
	return &stockEnv{authEnv: e, cookie: e.login(ownerPassword)}
}

func (e *stockEnv) fund(symbol, basis, ptype, end, key string, v float64, src string) {
	e.t.Helper()
	e.exec(`INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, value, source)
	        SELECT id, $2, $3, $4::date, $5, $6, $7 FROM instrument WHERE symbol = $1`, symbol, basis, ptype, end, key, v, src)
}

type envelope struct {
	Data     map[string]any `json:"data"`
	Meta     map[string]any `json:"meta"`
	Warnings []struct {
		Code string `json:"code"`
	} `json:"warnings"`
}

func (e *stockEnv) getEnv(path string) (envelope, int) {
	e.t.Helper()
	r := e.get(path)
	var b envelope
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		e.t.Fatalf("decode %s: %v: %s", path, err, r.Body.String())
	}
	return b, r.Code
}

func TestOwnerDataRequiresSession(t *testing.T) {
	e := newOwnerEnv(t)
	for _, p := range []string{"fundamentals", "shareholding", "events", "links"} {
		if r := e.do(http.MethodGet, "/api/v1/stocks/TCS/"+p, "", "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d", p, r.Code)
		}
	}
}

func TestOwnerDataNotFoundAndAlias(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("NEWCO", "New Co")
	e.exec(`INSERT INTO symbol_alias (old_symbol, instrument_id, changed_on) SELECT 'OLDCO', id, '2026-01-01' FROM instrument WHERE symbol='NEWCO'`)
	for _, p := range []string{"fundamentals", "shareholding", "events", "links"} {
		if _, code := e.getEnv("/api/v1/stocks/NOPE/" + p); code != http.StatusNotFound {
			t.Errorf("%s: %d", p, code)
		}
		b, code := e.getEnv("/api/v1/stocks/oldco/" + p)
		if code != 200 || b.Data["redirect_symbol"] != "NEWCO" {
			t.Errorf("%s alias: %d %v", p, code, b.Data)
		}
	}
}

func TestOwnerDataFundamentalsEndpoint(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("EMPTY", "Empty Co")
	// FND-11 over HTTP
	b, code := e.getEnv("/api/v1/stocks/EMPTY/fundamentals")
	if code != 200 || b.Data["status"] != "none" || b.Data["metrics_reason"] != "no_data_entered" || b.Data["entry_hint"] == nil {
		t.Fatalf("%d %v", code, b.Data)
	}
	if b.Meta["stale"] != false || b.Meta["source"] != "none" {
		t.Fatalf("meta %v", b.Meta)
	}

	e.addStock("M&M", "Mahindra & Mahindra Ltd")
	e.fund("M&M", "standalone", "Q", "2026-03-31", "pnl.revenue", 100, "csv_import")
	e.fund("M&M", "standalone", "Q", "2026-06-30", "pnl.revenue", 110, "csv_import")
	e.fund("M&M", "standalone", "Q", "2026-06-30", "pnl.revenue", 111, "manual")
	e.fund("M&M", "standalone", "Q", "2026-06-30", "pnl.eps", 0, "derived") // never primary data
	b, code = e.getEnv("/api/v1/stocks/M%26M/fundamentals?basis=auto&period=Q")
	if code != 200 || b.Data["basis_used"] != "standalone" || b.Data["basis_note"] == nil {
		t.Fatalf("%d %v", code, b.Data)
	}
	if got := b.Data["labels"].([]any); got[0] != "Q4 FY26" || got[1] != "Q1 FY27" {
		t.Fatalf("labels %v", got)
	}
	rev := b.Data["metrics"].(map[string]any)["pnl.revenue"].([]any)
	if rev[1] != float64(111) || b.Data["source_by_metric"].(map[string]any)["pnl.revenue"] != "manual" {
		t.Fatalf("priority %v %v", rev, b.Data["source_by_metric"])
	}
	if _, has := b.Data["metrics"].(map[string]any)["pnl.eps"]; has {
		t.Fatal("derived rows must not be served as metrics")
	}
	if b.Data["derived_reason"] != "not_computed" || b.Data["last_updated"] == nil {
		t.Fatalf("%v", b.Data)
	}
	for _, q := range []string{"?basis=bogus", "?period=X"} {
		if _, code := e.getEnv("/api/v1/stocks/M%26M/fundamentals" + q); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d", q, code)
		}
	}
	// the worker snapshot feeds derived/ratios/valuation
	e.exec(`INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version)
	        SELECT id, '2026-10-01', $1::jsonb, '{}', 'v1' FROM instrument WHERE symbol='M&M'`,
		`{"fundamentals":{"standalone":{"Q":{"periods":["2026-06-30"],"derived":{"op_margin":[18.5]},"ratios":{"roe":12.5}}}}}`)
	b, _ = e.getEnv("/api/v1/stocks/M%26M/fundamentals")
	om := b.Data["derived"].(map[string]any)["op_margin"].([]any)
	if om[0] != nil || om[1] != 18.5 || b.Data["ratios"].(map[string]any)["roe"] != 12.5 {
		t.Fatalf("%v", b.Data)
	}
}

func TestOwnerDataShareholdingEndpoint(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("SHP", "Shp Co")
	b, code := e.getEnv("/api/v1/stocks/SHP/shareholding")
	if code != 200 || b.Data["reason"] != "no_data_entered" || b.Data["mf_available"] != false {
		t.Fatalf("%d %v", code, b.Data)
	}
	e.exec(`INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, fii_pct, source, filed_on)
	        SELECT id, '2026-06-30', 50.5, 12.3, 'manual', '2026-07-20' FROM instrument WHERE symbol='SHP'`)
	b, _ = e.getEnv("/api/v1/stocks/SHP/shareholding") // SHP-04 + SHP-01
	if b.Data["promoter"].([]any)[0] != 50.5 || b.Data["fii"].([]any)[0] != 12.3 || b.Data["mf"].([]any)[0] != nil ||
		b.Data["mf_available"] != false || b.Data["qoq_reason"] != "single_quarter" || b.Data["latest_filed_on"] != "2026-07-20" {
		t.Fatalf("%v", b.Data)
	}
	e.exec(`INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, mf_pct, source)
	        SELECT id, '2026-09-30', 50.7, 4.0, 'manual' FROM instrument WHERE symbol='SHP'`)
	b, _ = e.getEnv("/api/v1/stocks/SHP/shareholding")
	if b.Data["qoq_change"].(map[string]any)["promoter"] != 0.2 || b.Data["mf_available"] != true {
		t.Fatalf("%v", b.Data)
	}
}

func TestOwnerDataEventsEndpoint(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("EVT", "Evt Co")
	b, code := e.getEnv("/api/v1/stocks/EVT/events")
	if code != 200 || b.Data["reason"] != "no_data_entered" {
		t.Fatalf("%d %v", code, b.Data)
	}
	ins := `INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, source, purpose_text)
	        SELECT id, $1::date, $2, $3, 10, 2, $4, '' FROM instrument WHERE symbol='EVT'`
	e.exec(ins, "2026-05-01", "split", "confirmed", "manual")
	e.exec(ins, "2026-06-01", "split_or_bonus", "detected", "detected")
	e.exec(ins, "2026-07-01", "bonus", "rejected", "detected")
	e.exec(ins, "2015-01-01", "split", "confirmed", "manual") // outside the 5-year default window
	e.exec(`INSERT INTO event_calendar (instrument_id, event_date, event_type, details)
	        SELECT id, current_date + 10, 'results', 'Q2 results' FROM instrument WHERE symbol='EVT'`)
	e.exec(`INSERT INTO event_calendar (instrument_id, event_date, event_type)
	        SELECT id, current_date + 200, 'agm' FROM instrument WHERE symbol='EVT'`)
	b, _ = e.getEnv("/api/v1/stocks/EVT/events")
	acts := b.Data["actions"].([]any)
	if len(acts) != 3 || acts[0].(map[string]any)["status"] != "rejected" || acts[0].(map[string]any)["type"] != "bonus" {
		t.Fatalf("%v", acts)
	}
	if cal := b.Data["calendar"].([]any); len(cal) != 1 || cal[0].(map[string]any)["type"] != "results" {
		t.Fatalf("calendar %v", cal)
	}
	if len(b.Warnings) != 1 || b.Warnings[0].Code != "UNCONFIRMED_ACTION" {
		t.Fatalf("warnings %v", b.Warnings)
	}
	b, _ = e.getEnv("/api/v1/stocks/EVT/events?from=2010-01-01&to=2026-05-15")
	if len(b.Data["actions"].([]any)) != 2 || len(b.Data["calendar"].([]any)) != 0 {
		t.Fatalf("%v", b.Data)
	}
	for _, q := range []string{"?from=nope", "?from=2026-02-01&to=2026-01-01"} {
		if _, code := e.getEnv("/api/v1/stocks/EVT/events" + q); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d", q, code)
		}
	}
}

// SAF-06 / acceptance: links contain a properly encoded M%26M and nothing is fetched.
func TestOwnerDataLinksEndpoint(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("M&M", "Mahindra & Mahindra Ltd")
	r := e.get("/api/v1/stocks/M%26M/links")
	if r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	body := r.Body.String()
	if !strings.Contains(body, "symbol=M%26M") || !strings.Contains(body, "/M%26M/") ||
		!strings.Contains(body, "Mahindra+%26+Mahindra+Ltd") || strings.Contains(body, "M&M") {
		t.Fatalf("%s", body)
	}
}
