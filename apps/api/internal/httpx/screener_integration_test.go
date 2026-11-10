package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/screener"
)

// pinned "now" of the screener service: all owner-data stamps below are explicit timestamps relative
// to it, so nothing depends on the wall clock or the database clock.
var scrNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

type scrEnv struct {
	*stockEnv
}

func newScrEnv(t *testing.T) *scrEnv {
	t.Helper()
	e := newAuthEnv(t)
	svc := screener.New(e.pool)
	svc.Now = func() time.Time { return scrNow }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Screener: svc})
	return &scrEnv{&stockEnv{authEnv: e, cookie: e.login(ownerPassword)}}
}

// stock inserts an active equity and its screener row (metrics is a JSON object).
func (e *scrEnv) stock(symbol, sector, industry, metrics string) {
	e.t.Helper()
	e.exec(`INSERT INTO instrument (symbol, name, sector, industry) VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''))`,
		symbol, symbol+" Ltd", sector, industry)
	if metrics != "" {
		e.exec(`INSERT INTO screener_row (instrument_id, as_of, metrics)
		        SELECT id, '2026-10-16', $2::jsonb FROM instrument WHERE symbol = $1`, symbol, metrics)
	}
}

func (e *scrEnv) fundAt(symbol string, fetched time.Time) {
	e.t.Helper()
	e.exec(`INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, value, source, fetched_at)
	        SELECT id, 'consolidated', 'Q', '2026-06-30', 'pnl.revenue', 100, 'manual', $2 FROM instrument WHERE symbol = $1`, symbol, fetched)
}

func (e *scrEnv) post(path, body string) resp {
	return e.do(http.MethodPost, path, body, e.cookie, nil)
}

type scrBody struct {
	Data struct {
		Items []struct {
			Symbol       string            `json:"symbol"`
			AsOf         string            `json:"as_of"`
			Values       map[string]any    `json:"values"`
			ValueReasons map[string]string `json:"value_reasons"`
			Coverage     float64           `json:"coverage"`
			LastUpdated  *string           `json:"last_updated"`
			Source       *string           `json:"last_updated_source"`
			Stale        bool              `json:"stale"`
			StaleReason  *string           `json:"stale_reason"`
		} `json:"items"`
		NextCursor *string           `json:"next_cursor"`
		Total      *int              `json:"total"`
		Units      map[string]string `json:"units"`
	} `json:"data"`
	Meta struct {
		Excluded map[string]int64 `json:"excluded_for_missing"`
		Stale    bool             `json:"stale"`
	} `json:"meta"`
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (e *scrEnv) query(body string) (scrBody, int) {
	e.t.Helper()
	r := e.post("/api/v1/screener/query", body)
	var b scrBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		e.t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return b, r.Code
}

func (b scrBody) symbols() string {
	var s []string
	for _, it := range b.Data.Items {
		s = append(s, it.Symbol)
	}
	return strings.Join(s, ",")
}

func (e *scrEnv) seedScreener() {
	e.stock("AAA", "IT", "Software", `{"roe":25,"pe":18,"market_cap_cr":50000,"sector":"IT","price":100}`)
	e.stock("BBB", "IT", "Software", `{"roe":12,"pe":30,"market_cap_cr":8000,"sector":"IT"}`)
	e.stock("CCC", "Banks", "Private Banks", `{"roe":17,"market_cap_cr":120000,"sector":"Banks","debt_equity":0}`)
	e.stock("DDD", "IT", "Software", `{"pe":22,"market_cap_cr":3000,"sector":"IT","roe":"not a number"}`)
	e.stock("EEE", "", "", "") // no screener row at all
	e.fundAt("AAA", scrNow.AddDate(0, 0, -10))
	e.fundAt("BBB", scrNow.AddDate(0, 0, -200))
	e.exec(`INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, source, fetched_at)
	        SELECT id, '2026-06-30', 50, 'manual', $1 FROM instrument WHERE symbol = 'CCC'`, scrNow.AddDate(0, 0, -3))
}

func TestScreenerRoutesNeedSessionAndCSRF(t *testing.T) {
	e := newScrEnv(t)
	for _, c := range []struct{ m, p string }{
		{"GET", "/stocks/AAA/peers"}, {"GET", "/compare?symbols=A,B"}, {"POST", "/screener/query"},
		{"GET", "/screener/saved"}, {"POST", "/screener/saved"}, {"DELETE", "/screener/saved/x"},
	} {
		if r := e.do(c.m, "/api/v1"+c.p, "{}", "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without session: %d", c.m, c.p, r.Code)
		}
		if c.m != "GET" {
			r := e.do(c.m, "/api/v1"+c.p, "{}", e.cookie, map[string]string{CSRFHeader: ""})
			if r.Code != http.StatusForbidden {
				t.Errorf("%s %s without CSRF header: %d", c.m, c.p, r.Code)
			}
		}
	}
}

// SCR-01: filters, ops, sort, missing metrics excluded and counted, null instead of 0.
func TestScreenerQueryFiltersSortAndExclusions(t *testing.T) {
	e := newScrEnv(t)
	e.seedScreener()
	b, code := e.query(`{"filters":[{"metric":"roe","op":">","value":15}],"sort":{"metric":"roe","dir":"desc"}}`)
	if code != 200 || b.symbols() != "AAA,CCC" {
		t.Fatalf("roe>15: %d %s", code, b.symbols())
	}
	// BBB has roe 12 (kept in the universe), DDD has a non-number (missing), EEE has no row.
	if b.Meta.Excluded["roe"] != 1 {
		t.Errorf("excluded_for_missing: %v", b.Meta.Excluded)
	}
	if b.Data.Items[0].Values["roe"].(float64) != 25 || b.Data.Units["roe"] != "PERCENT" || b.Data.Items[0].AsOf != "2026-10-16" {
		t.Errorf("value, unit, as_of: %+v %v", b.Data.Items[0], b.Data.Units)
	}
	// ties and ordering: sort asc puts missing last, symbol breaks ties.
	b, _ = e.query(`{"sort":{"metric":"roe","dir":"asc"},"columns":["roe","pe"]}`)
	if b.symbols() != "BBB,CCC,AAA,DDD" {
		t.Errorf("asc order with nulls last: %s", b.symbols())
	}
	ddd := b.Data.Items[3]
	if v, ok := ddd.Values["roe"]; !ok || v != nil || ddd.ValueReasons["roe"] != "not_available" {
		t.Errorf("unknown must be null with a reason, never 0: %v %v", ddd.Values, ddd.ValueReasons)
	}
	if ddd.Coverage <= 0 || ddd.Coverage >= 1 {
		t.Errorf("coverage %v", ddd.Coverage)
	}
	// between, text in, text =
	b, _ = e.query(`{"filters":[{"metric":"market_cap_cr","op":"between","value":[5000,100000]},{"metric":"sector","op":"in","value":["it"]}]}`)
	if b.symbols() != "AAA,BBB" {
		t.Errorf("between+in: %s", b.symbols())
	}
	b, _ = e.query(`{"filters":[{"metric":"sector","op":"=","value":"Banks"}],"columns":["sector"]}`)
	if b.symbols() != "CCC" || b.Data.Items[0].Values["sector"] != "Banks" {
		t.Errorf("text =: %s", b.symbols())
	}
	// A zero is a real value and is matched as such (debt_equity = 0 for a debt-free company).
	b, _ = e.query(`{"filters":[{"metric":"debt_equity","op":"=","value":0}]}`)
	if b.symbols() != "CCC" {
		t.Errorf("zero value: %s", b.symbols())
	}
	// Inactive and non-equity stocks are outside the default universe.
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE symbol = 'BBB'`)
	e.exec(`UPDATE instrument SET instrument_kind = 'etf' WHERE symbol = 'DDD'`)
	b, _ = e.query(`{}`)
	if b.symbols() != "AAA,CCC" {
		t.Errorf("universe: %s", b.symbols())
	}
	b, _ = e.query(`{"universe":{"kind":"etf"}}`)
	if b.symbols() != "DDD" {
		t.Errorf("etf universe: %s", b.symbols())
	}
	b, _ = e.query(`{"universe":{"company_type":"financial"}}`)
	if b.symbols() != "" {
		t.Errorf("financial universe: %s", b.symbols())
	}
	e.exec(`INSERT INTO index_constituent (index_name, instrument_id, as_of) SELECT 'NIFTY 50', id, '2026-10-01' FROM instrument WHERE symbol = 'AAA'`)
	b, _ = e.query(`{"universe":{"index":"nifty50"}}`)
	if b.symbols() != "AAA" {
		t.Errorf("index universe (no spaces, any case): %s", b.symbols())
	}
}

// D-R: every screener row carries a last updated date and a stale flag.
func TestScreenerRowsCarryLastUpdatedAndStale(t *testing.T) {
	e := newScrEnv(t)
	e.seedScreener()
	e.exec(`INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, value, source, fetched_at)
	        SELECT id, 'consolidated', 'Q', '2026-06-30', 'ratio.roe', 1, 'derived', $1 FROM instrument WHERE symbol = 'DDD'`, scrNow.AddDate(0, 0, -1))
	b, _ := e.query(`{"columns":["roe"]}`)
	by := map[string]int{}
	for i, it := range b.Data.Items {
		by[it.Symbol] = i
	}
	aaa, bbb, ccc, ddd := b.Data.Items[by["AAA"]], b.Data.Items[by["BBB"]], b.Data.Items[by["CCC"]], b.Data.Items[by["DDD"]]
	if aaa.LastUpdated == nil || *aaa.LastUpdated != "2026-10-10" || *aaa.Source != "fundamentals" || aaa.Stale {
		t.Errorf("AAA: %+v", aaa)
	}
	if *bbb.LastUpdated != "2026-04-03" || !bbb.Stale || *bbb.StaleReason != screener.StaleFundamentals {
		t.Errorf("BBB (200 days): %+v", bbb)
	}
	if *ccc.LastUpdated != "2026-10-17" || *ccc.Source != "shareholding" || ccc.Stale {
		t.Errorf("CCC: %+v", ccc)
	}
	if ddd.LastUpdated != nil || !ddd.Stale || *ddd.StaleReason != screener.StaleNoOwnerData {
		t.Errorf("DDD derived-only data must not count as owner data: %+v", ddd)
	}
	if !b.Meta.Stale {
		t.Error("meta.stale is true when any listed stock is stale")
	}
}

func TestScreenerPaginationCursor(t *testing.T) {
	e := newScrEnv(t)
	for i := 0; i < 5; i++ {
		e.stock(fmt.Sprintf("S%d", i), "IT", "Software", fmt.Sprintf(`{"roe":%d}`, 10+i))
	}
	spec := `"sort":{"metric":"roe","dir":"desc"}`
	b, _ := e.query(`{` + spec + `,"limit":2}`)
	if b.symbols() != "S4,S3" || b.Data.NextCursor == nil || *b.Data.Total != 5 {
		t.Fatalf("page 1: %s %v", b.symbols(), b.Data.NextCursor)
	}
	b2, _ := e.query(`{` + spec + `,"limit":2,"cursor":"` + *b.Data.NextCursor + `"}`)
	if b2.symbols() != "S2,S1" || b2.Data.NextCursor == nil {
		t.Fatalf("page 2: %s", b2.symbols())
	}
	b3, _ := e.query(`{` + spec + `,"limit":2,"cursor":"` + *b2.Data.NextCursor + `"}`)
	if b3.symbols() != "S0" || b3.Data.NextCursor != nil {
		t.Fatalf("page 3: %s %v", b3.symbols(), b3.Data.NextCursor)
	}
	// a cursor from another screen, and a limit above 200 (clamped, not an error)
	if _, code := e.query(`{"sort":{"metric":"roe","dir":"asc"},"cursor":"` + *b.Data.NextCursor + `"}`); code != 422 {
		t.Errorf("foreign cursor: %d", code)
	}
	if _, code := e.query(`{"limit":100000}`); code != 200 {
		t.Errorf("limit clamp: %d", code)
	}
}

// SEC-04: every user-controlled field, over HTTP against a real database. Rejected inputs are 422 naming
// the field; injection payloads that are valid *values* are bound parameters and match nothing.
func TestScreenerInjectionOverHTTP(t *testing.T) {
	e := newScrEnv(t)
	e.seedScreener()
	reject := []struct{ name, body, field string }{
		{"metric", `{"filters":[{"metric":"roe; DROP TABLE instrument;--","op":">","value":1}]}`, "filters[0].metric"},
		{"metric quote", `{"filters":[{"metric":"roe' OR '1'='1","op":">","value":1}]}`, "filters[0].metric"},
		{"metric json path", `{"filters":[{"metric":"metrics->>'roe'","op":">","value":1}]}`, "filters[0].metric"},
		{"metric empty", `{"filters":[{"metric":"","op":">","value":1}]}`, "filters[0].metric"},
		{"second filter", `{"filters":[{"metric":"roe","op":">","value":1},{"metric":"nope","op":">","value":1}]}`, "filters[1].metric"},
		{"op", `{"filters":[{"metric":"roe","op":"> 1 OR 1=1 --","value":1}]}`, "filters[0].op"},
		{"op like", `{"filters":[{"metric":"roe","op":"like","value":1}]}`, "filters[0].op"},
		{"value string", `{"filters":[{"metric":"roe","op":">","value":"1; DROP TABLE x"}]}`, "filters[0].value"},
		{"value huge", `{"filters":[{"metric":"roe","op":">","value":1e99}]}`, "filters[0].value"},
		{"sort metric", `{"sort":{"metric":"roe; DROP TABLE instrument","dir":"asc"}}`, "sort.metric"},
		{"sort dir", `{"sort":{"metric":"roe","dir":"asc; DROP TABLE instrument"}}`, "sort.dir"},
		{"column", `{"columns":["roe","x) --"]}`, "columns[1]"},
		{"universe kind", `{"universe":{"kind":"equity' OR '1'='1"}}`, "universe.kind"},
		{"universe company_type", `{"universe":{"company_type":"x"}}`, "universe.company_type"},
		{"limit", `{"limit":0}`, "limit"},
		{"limit text", `{"limit":"5"}`, "limit"},
		{"cursor", `{"cursor":"not-a-cursor"}`, "cursor"},
	}
	for _, c := range reject {
		r := e.post("/api/v1/screener/query", c.body)
		var b scrBody
		_ = json.Unmarshal(r.Body.Bytes(), &b)
		if r.Code != 422 || b.Error.Code != "UNPROCESSABLE" || !strings.Contains(r.Body.String(), `"`+c.field+`"`) {
			t.Errorf("%s: %d %s", c.name, r.Code, r.Body.String())
		}
	}
	for _, body := range []string{`{`, `[]`, `{"filters":[],"surprise":1}`, `{"filters":[{"metric":"roe","op":">","value":1,"extra":1}]}`} {
		if r := e.post("/api/v1/screener/query", body); r.Code != 400 {
			t.Errorf("malformed body %s: %d", body, r.Code)
		}
	}
	// Values that look like SQL are plain data: no match, no error, tables intact.
	payload := `x'; DROP TABLE instrument;--`
	pb, _ := json.Marshal(payload)
	for _, body := range []string{
		`{"filters":[{"metric":"sector","op":"=","value":` + string(pb) + `}]}`,
		`{"filters":[{"metric":"sector","op":"in","value":[` + string(pb) + `,"y"]}]}`,
		`{"universe":{"index":` + string(pb) + `}}`,
	} {
		b, code := e.query(body)
		if code != 200 || len(b.Data.Items) != 0 {
			t.Errorf("payload %s: %d %s", body, code, b.symbols())
		}
	}
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM instrument`).Scan(&n); err != nil || n != 5 {
		t.Fatalf("instrument table damaged: %d %v", n, err)
	}
	// The saved-screen name and the delete path segment.
	for _, name := range []string{"a'; DROP TABLE app_setting;--", "a/b", "", "x\u0000y", strings.Repeat("a", 61)} {
		nb, _ := json.Marshal(name)
		if r := e.post("/api/v1/screener/saved", `{"name":`+string(nb)+`,"spec":{}}`); r.Code != 422 || !strings.Contains(r.Body.String(), `"name"`) {
			t.Errorf("name %q: %d %s", name, r.Code, r.Body.String())
		}
	}
	for _, seg := range []string{"a%27%3B%20DROP", "..%2F..%2Fx", "%00", "a%2525"} {
		if r := e.do(http.MethodDelete, "/api/v1/screener/saved/"+seg, "", e.cookie, nil); r.Code != 404 && r.Code != 422 {
			t.Errorf("delete %s: %d", seg, r.Code)
		}
	}
}

func TestScreenerSavedCRUD(t *testing.T) {
	e := newScrEnv(t)
	spec := `{"filters":[{"metric":"roe","op":">","value":15}],"sort":{"metric":"roe","dir":"desc"}}`
	r := e.post("/api/v1/screener/saved", `{"name":"My screen (1)","spec":`+spec+`}`)
	if r.Code != 201 {
		t.Fatalf("create: %d %s", r.Code, r.Body.String())
	}
	// idempotent upsert by name (case-insensitive): 200, still one screen, new spec stored
	r = e.post("/api/v1/screener/saved", `{"name":"my SCREEN (1)","spec":{"filters":[{"metric":"pe","op":"<","value":15}]}}`)
	if r.Code != 200 {
		t.Fatalf("replace: %d %s", r.Code, r.Body.String())
	}
	r = e.do(http.MethodGet, "/api/v1/screener/saved", "", e.cookie, nil)
	var list struct {
		Data struct {
			Items []struct {
				Name string `json:"name"`
				Spec struct {
					Filters []struct{ Metric string } `json:"filters"`
				} `json:"spec"`
			} `json:"items"`
			Presets  []struct{ Name string } `json:"presets"`
			MaxSaved int                     `json:"max_saved"`
		} `json:"data"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &list); err != nil || len(list.Data.Items) != 1 || list.Data.Items[0].Spec.Filters[0].Metric != "pe" {
		t.Fatalf("list: %v %s", err, r.Body.String())
	}
	if len(list.Data.Presets) != 4 || list.Data.MaxSaved != 30 {
		t.Errorf("presets/max: %+v", list.Data)
	}
	if r := e.post("/api/v1/screener/saved", `{"name":"x"}`); r.Code != 422 {
		t.Errorf("missing spec: %d", r.Code)
	}
	if r := e.post("/api/v1/screener/saved", `{"name":"x","spec":{"filters":[{"metric":"bad","op":">","value":1}]}}`); r.Code != 422 || !strings.Contains(r.Body.String(), "spec.filters[0].metric") {
		t.Errorf("bad spec: %d %s", r.Code, r.Body.String())
	}
	big := `{"name":"big","spec":{"universe":{"index":"x"},"columns":[` + strings.Repeat(`"roe",`, 3) + `"pe"],"filters":[` +
		strings.TrimSuffix(strings.Repeat(`{"metric":"sector","op":"in","value":`+manyLong()+`},`, 12), ",") + `]}}`
	if r := e.post("/api/v1/screener/saved", big); r.Code != 422 || !strings.Contains(r.Body.String(), `"spec"`) {
		t.Errorf("spec over 8 KiB: %d %.200s", r.Code, r.Body.String())
	}
	// delete (URL-encoded name with spaces and brackets), then 404
	if r := e.do(http.MethodDelete, "/api/v1/screener/saved/"+url.PathEscape("My screen (1)"), "", e.cookie, nil); r.Code != 200 {
		t.Errorf("delete: %d %s", r.Code, r.Body.String())
	}
	if r := e.do(http.MethodDelete, "/api/v1/screener/saved/My%20screen%20(1)", "", e.cookie, nil); r.Code != 404 {
		t.Errorf("delete again: %d", r.Code)
	}
}

func manyLong() string {
	xs := make([]string, 50)
	for i := range xs {
		xs[i] = fmt.Sprintf("%s%d", strings.Repeat("x", 50), i)
	}
	b, _ := json.Marshal(xs)
	return string(b)
}

func TestScreenerSavedCapAndConcurrency(t *testing.T) {
	e := newScrEnv(t)
	// 30 parallel saves of different names: advisory lock serialises the read-modify-write, none is lost.
	codes := make([]int, screener.MaxSaved)
	var wg sync.WaitGroup
	for i := 0; i < screener.MaxSaved; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = e.post("/api/v1/screener/saved", fmt.Sprintf(`{"name":"s%02d","spec":{}}`, i)).Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 201 {
			t.Errorf("save %d: %d", i, c)
		}
	}
	r := e.do(http.MethodGet, "/api/v1/screener/saved", "", e.cookie, nil)
	var list struct {
		Data struct{ Items []struct{ Name string } } `json:"data"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &list)
	if len(list.Data.Items) != 30 || list.Data.Items[0].Name != "s00" || list.Data.Items[29].Name != "s29" {
		t.Fatalf("lost updates: %d", len(list.Data.Items))
	}
	r = e.post("/api/v1/screener/saved", `{"name":"one-too-many","spec":{}}`)
	if r.Code != 409 || !strings.Contains(r.Body.String(), "saved_screens_limit") {
		t.Errorf("31st: %d %s", r.Code, r.Body.String())
	}
	if r := e.post("/api/v1/screener/saved", `{"name":"S05","spec":{"filters":[{"metric":"pe","op":"<","value":1}]}}`); r.Code != 200 {
		t.Errorf("replace at cap: %d", r.Code)
	}
}

// B13R-5: a burst past the cap yields exactly 30 creates and the rest 409; the advisory lock means
// no check-then-write race can store a 31st screen.
func TestScreenerSavedCapHoldsUnderBurst(t *testing.T) {
	e := newScrEnv(t)
	const n = screener.MaxSaved + 6
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = e.post("/api/v1/screener/saved", fmt.Sprintf(`{"name":"b%02d","spec":{}}`, i)).Code
		}(i)
	}
	wg.Wait()
	created, conflict := 0, 0
	for _, c := range codes {
		switch c {
		case 201:
			created++
		case 409:
			conflict++
		default:
			t.Errorf("unexpected status %d", c)
		}
	}
	if created != screener.MaxSaved || conflict != 6 {
		t.Errorf("created %d conflict %d", created, conflict)
	}
	var stored int
	if err := e.pool.QueryRow(context.Background(), `SELECT jsonb_array_length(value) FROM app_setting WHERE key = 'saved_screens'`).Scan(&stored); err != nil || stored != screener.MaxSaved {
		t.Errorf("stored %d %v", stored, err)
	}
}

func (e *scrEnv) bars(symbol string, closes map[string]float64) {
	e.t.Helper()
	for d, c := range closes {
		e.addBarFull(symbol, d, c, c, c, c, c, false)
	}
}

type cmpBody struct {
	Data struct {
		Range   string `json:"range"`
		Symbols []struct {
			Symbol       string  `json:"symbol"`
			Bars         int     `json:"bars"`
			ShortHistory bool    `json:"short_history"`
			PricesReason *string `json:"prices_reason"`
			LastUpdated  *string `json:"last_updated"`
			Stale        bool    `json:"stale"`
		} `json:"symbols"`
		Rebased struct {
			BaseDate *string              `json:"base_date"`
			Dates    []string             `json:"dates"`
			Series   map[string][]float64 `json:"series"`
			Reason   *string              `json:"reason"`
		} `json:"rebased"`
		Metrics       map[string]map[string]any    `json:"metrics"`
		MetricReasons map[string]map[string]string `json:"metric_reasons"`
		Best          map[string]*string           `json:"best"`
	} `json:"data"`
	Error struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (e *scrEnv) compare(q string) (cmpBody, int) {
	e.t.Helper()
	r := e.get("/api/v1/compare?" + q)
	var b cmpBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		e.t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return b, r.Code
}

// MF-14 analogue for stocks and FND-14: different starts rebase at the first common date and are flagged;
// a missing market cap (and every other missing metric) is null with a reason, never 0.
func TestCompareRebaseShortHistoryAndNulls(t *testing.T) {
	e := newScrEnv(t)
	e.stock("AAA", "IT", "Software", `{"roe":25,"pe":18,"debt_equity":0.4}`)
	e.stock("BBB", "IT", "Software", `{"roe":12,"pe":12,"market_cap_cr":900}`)
	e.stock("CCC", "IT", "Software", "") // no screener row
	// 10 trading dates for AAA, only the last 4 for BBB (short history); CCC has no prices.
	aaa, bbb := map[string]float64{}, map[string]float64{}
	for i := 1; i <= 10; i++ {
		d := fmt.Sprintf("2026-10-%02d", i)
		aaa[d] = float64(100 + i)
		if i > 6 {
			bbb[d] = float64(50 + 2*(i-6))
		}
	}
	e.bars("AAA", aaa)
	e.bars("BBB", bbb)
	b, code := e.compare("symbols=aaa,BBB&range=1Y&metrics=pe,roe,market_cap_cr,debt_equity")
	if code != 200 {
		t.Fatalf("%d", code)
	}
	if b.Data.Rebased.Reason != nil || *b.Data.Rebased.BaseDate != "2026-10-07" || len(b.Data.Rebased.Dates) != 4 {
		t.Fatalf("rebased: %+v", b.Data.Rebased)
	}
	if b.Data.Rebased.Series["AAA"][0] != 100 || b.Data.Rebased.Series["BBB"][0] != 100 || b.Data.Rebased.Series["BBB"][1] != 103.8462 {
		t.Errorf("series: %v", b.Data.Rebased.Series)
	}
	for _, s := range b.Data.Symbols {
		switch s.Symbol {
		case "AAA":
			if s.ShortHistory || s.Bars != 10 {
				t.Errorf("AAA: %+v", s)
			}
		case "BBB":
			if !s.ShortHistory || s.Bars != 4 {
				t.Errorf("BBB must be flagged short_history (4 of 10 dates): %+v", s)
			}
		}
		if s.LastUpdated != nil || !s.Stale {
			t.Errorf("%s: no owner data means stale with no date: %+v", s.Symbol, s)
		}
	}
	// FND-14: market cap missing on AAA -> null + reason; best only where two usable values exist.
	if v, ok := b.Data.Metrics["AAA"]["market_cap_cr"]; !ok || v != nil || b.Data.MetricReasons["AAA"]["market_cap_cr"] != "not_available" {
		t.Errorf("AAA market cap: %v %v", v, b.Data.MetricReasons["AAA"])
	}
	if b.Data.Metrics["BBB"]["debt_equity"] != nil {
		t.Errorf("BBB debt_equity must be null: %v", b.Data.Metrics["BBB"])
	}
	if p := b.Data.Best["pe"]; p == nil || *p != "BBB" {
		t.Errorf("best pe (lowest): %v", p)
	}
	if p := b.Data.Best["roe"]; p == nil || *p != "AAA" {
		t.Errorf("best roe (highest): %v", p)
	}
	if p, ok := b.Data.Best["debt_equity"]; !ok || p != nil {
		t.Errorf("one value cannot win: %v %v", p, ok)
	}
	if _, ok := b.Data.Best["market_cap_cr"]; ok {
		t.Error("market cap has no best direction")
	}
	// a third stock without prices and without a row: partial, not an error
	b, code = e.compare("symbols=AAA,BBB,CCC&metrics=pe")
	if code != 200 || b.Data.Rebased.Series["CCC"] != nil {
		t.Fatalf("CCC: %d %+v", code, b.Data.Rebased.Series)
	}
	if b.Data.Symbols[2].PricesReason == nil || !b.Data.Symbols[2].ShortHistory || b.Data.MetricReasons["CCC"]["pe"] != "no_screener_row" {
		t.Errorf("CCC: %+v %v", b.Data.Symbols[2], b.Data.MetricReasons["CCC"])
	}
	// range window counts back from the last bar: 1M still includes everything here
	if b, _ := e.compare("symbols=AAA,BBB&range=1M"); len(b.Data.Rebased.Dates) != 4 {
		t.Errorf("1M: %v", b.Data.Rebased.Dates)
	}
}

func TestCompareNoCommonDatesAliasAndErrors(t *testing.T) {
	e := newScrEnv(t)
	e.stock("AAA", "IT", "Software", `{"pe":10}`)
	e.stock("BBB", "IT", "Software", `{"pe":20}`)
	e.bars("AAA", map[string]float64{"2026-10-01": 10, "2026-10-02": 11})
	e.bars("BBB", map[string]float64{"2026-10-05": 10, "2026-10-06": 11})
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol) SELECT id, 'OLDAAA' FROM instrument WHERE symbol = 'AAA'`)
	b, code := e.compare("symbols=OLDAAA,BBB")
	if code != 200 || b.Data.Rebased.Reason == nil || *b.Data.Rebased.Reason != "no_common_dates" || len(b.Data.Rebased.Dates) != 0 {
		t.Fatalf("no common dates: %d %+v", code, b.Data.Rebased)
	}
	if b.Data.Symbols[0].Symbol != "AAA" || b.Data.Metrics["BBB"]["pe"].(float64) != 20 {
		t.Errorf("alias resolved to the current symbol; metrics still shown: %+v", b.Data.Symbols)
	}
	for q, want := range map[string]int{
		"symbols=AAA": 422, "symbols=AAA,AAA": 422, "": 422, "symbols=AAA,BBB&range=9Y": 422, "symbols=AAA,BBB&metrics=zzz": 422,
		"symbols=AAA,NOPE": 404, "symbols=AAA,B%3BB": 422, "symbols=A,B,C,D,E,F": 422, "symbols=AAA,BBB%00": 422,
	} {
		if r := e.get("/api/v1/compare?" + q); r.Code != want {
			t.Errorf("%q: %d want %d: %s", q, r.Code, want, r.Body.String())
		}
	}
}

type peersBody struct {
	Data struct {
		Symbol     string  `json:"symbol"`
		Sector     *string `json:"sector"`
		Industry   *string `json:"industry"`
		Basis      string  `json:"basis"`
		Band       string  `json:"market_cap_band"`
		Note       *string `json:"note"`
		RedirectTo string  `json:"redirect_symbol"`
		Peers      []peerJSON
		Self       peerJSON `json:"self"`
	} `json:"data"`
	Error struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

type peerJSON struct {
	Symbol       string              `json:"symbol"`
	Origin       string              `json:"origin"`
	MarketCapCr  *float64            `json:"market_cap_cr"`
	PE           *float64            `json:"pe"`
	Percentile   map[string]*float64 `json:"percentile_rank"`
	ValueReasons map[string]string   `json:"value_reasons"`
	Stale        bool                `json:"stale"`
}

func (e *scrEnv) peers(path string) (peersBody, int) {
	e.t.Helper()
	r := e.get("/api/v1/stocks/" + path)
	var raw struct {
		Data  json.RawMessage `json:"data"`
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &raw); err != nil {
		e.t.Fatal(err)
	}
	var b peersBody
	b.Error = raw.Error
	if len(raw.Data) > 0 {
		var d struct {
			Peers []peerJSON `json:"peers"`
		}
		_ = json.Unmarshal(raw.Data, &d)
		_ = json.Unmarshal(raw.Data, &b.Data)
		b.Data.Peers = d.Peers
	}
	return b, r.Code
}

func (b peersBody) peerSymbols() string {
	var s []string
	for _, p := range b.Data.Peers {
		s = append(s, p.Symbol)
	}
	return strings.Join(s, ",")
}

func (e *scrEnv) seedPeers() {
	row := func(mc, pe float64) string { return fmt.Sprintf(`{"market_cap_cr":%v,"pe":%v}`, mc, pe) }
	e.stock("SELF", "Tech", "Software", row(10000, 10))
	e.stock("PB", "Tech", "Software", row(12000, 15))
	e.stock("PC", "Tech", "Software", row(9000, 20))
	e.stock("PD", "Tech", "Software", row(30000, 25))
	e.stock("PE", "Tech", "Software", `{"market_cap_cr":2000}`)
	e.stock("PF", "Tech", "Hardware", row(11000, 12))
	e.stock("PG", "Tech", "Hardware", row(500000, 12)) // far outside both bands
	e.stock("BANK", "Banks", "PSU", row(10, 8))
	e.stock("NOCAP", "Tech", "Software", `{"pe":5}`)
	e.stock("LONER", "Tech", "Solo", row(10000, 9))
	e.stock("NOSEC", "", "", row(10000, 9))
}

// PEER-01..: industry first, market-cap bands, ranking, percentile (D05b-4), overrides, errors.
func TestPeersAlgorithm(t *testing.T) {
	e := newScrEnv(t)
	e.seedPeers()
	// industry Software has PB, PC, PD, PE (NOCAP has no market cap and is not a candidate): 4 candidates,
	// the [0.25, 4] band keeps 3, so it widens to [0.1, 10] (PE at 0.2 joins). Ranked by |ln ratio|.
	b, code := e.peers("SELF/peers")
	if code != 200 || b.peerSymbols() != "PC,PB,PD,PE" || b.Data.Basis != "industry" || b.Data.Band != "0.1-10" || b.Data.Note != nil {
		t.Fatalf("%d %s %s %s %v", code, b.peerSymbols(), b.Data.Basis, b.Data.Band, b.Data.Note)
	}
	if *b.Data.Sector != "Tech" || *b.Data.Industry != "Software" || b.Data.Self.Origin != "self" {
		t.Errorf("header: %+v", b.Data)
	}
	// pe: SELF 10, PC 20, PB 15, PD 25, PE missing -> n = 4, SELF 0, PB 33.33, PC 66.67, PD 100.
	if p := b.Data.Self.Percentile["pe"]; p == nil || *p != 0 {
		t.Errorf("self pe percentile: %v", p)
	}
	for _, pr := range b.Data.Peers {
		switch pr.Symbol {
		case "PB":
			if p := pr.Percentile["pe"]; p == nil || *p != 33.33 {
				t.Errorf("PB: %v", p)
			}
		case "PE":
			if pr.PE != nil || pr.Percentile["pe"] != nil || pr.ValueReasons["pe"] != "not_available" {
				t.Errorf("PE missing pe must be null with a reason: %+v", pr)
			}
		}
		if !pr.Stale {
			t.Errorf("%s: no owner data is stale", pr.Symbol)
		}
	}
	// limit
	if b, _ := e.peers("SELF/peers?limit=2"); b.peerSymbols() != "PC,PB" {
		t.Errorf("limit: %s", b.peerSymbols())
	}
	// overrides: remove widens the pool deterministically; add appends a stock outside the rules.
	b, _ = e.peers("SELF/peers?remove=pb&add=PG,bank")
	if b.peerSymbols() != "LONER,PF,PC,PD,PG,BANK" || b.Data.Peers[4].Origin != "added" {
		t.Errorf("add/remove: %s", b.peerSymbols())
	}
	// A sector widening: LONER is alone in its industry.
	b, code = e.peers("LONER/peers?limit=3")
	if code != 200 || b.Data.Basis != "sector" || b.Data.Band != "0.25-4" || b.peerSymbols() != "SELF,PF,PC" {
		t.Errorf("sector widening: %d %s %s %s", code, b.Data.Basis, b.Data.Band, b.peerSymbols())
	}
	// Fewer than 4 peers anywhere: what exists with the note.
	e.stock("ONLY", "Utilities", "Power", `{"market_cap_cr":100}`)
	e.stock("ONLY2", "Utilities", "Power", `{"market_cap_cr":150}`)
	b, code = e.peers("ONLY/peers")
	if code != 200 || b.peerSymbols() != "ONLY2" || b.Data.Note == nil || *b.Data.Note != "few comparable peers" {
		t.Errorf("few: %d %s %v", code, b.peerSymbols(), b.Data.Note)
	}
	// Errors.
	for path, want := range map[string][2]any{
		"NOSEC/peers": {404, "no_sector_data"}, "NOCAP/peers": {404, "no_market_cap"}, "EEE/peers": {404, ""},
		"SELF/peers?add=NOPE": {422, ""}, "SELF/peers?add=SELF": {422, ""}, "SELF/peers?limit=0": {422, ""},
		"SELF/peers?add=A%3BB": {422, ""}, "SELF/peers?add=PB&remove=PB": {422, ""},
	} {
		b, code := e.peers(path)
		if code != want[0].(int) {
			t.Errorf("%s: %d want %v", path, code, want[0])
		}
		if r := want[1].(string); r != "" && (b.Error.Code != "DATA_UNAVAILABLE" || b.Error.Details["reason"] != r) {
			t.Errorf("%s: %+v", path, b.Error)
		}
	}
	// An old symbol answers with the redirect (docs/03 section 1).
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol) SELECT id, 'OLDSELF' FROM instrument WHERE symbol = 'SELF'`)
	if b, code := e.peers("OLDSELF/peers"); code != 200 || b.Data.RedirectTo != "SELF" {
		t.Errorf("alias: %d %+v", code, b.Data)
	}
}

// B13R-1: a literal percent in the delete segment is not decoded twice (`A%2541` is the name `A%41`,
// not `AA`), so it can never delete another screen.
func TestScreenerDeleteDoesNotDoubleDecode(t *testing.T) {
	e := newScrEnv(t)
	if r := e.post("/api/v1/screener/saved", `{"name":"AA","spec":{}}`); r.Code != 201 {
		t.Fatalf("create: %d", r.Code)
	}
	if r := e.do(http.MethodDelete, "/api/v1/screener/saved/A%2541", "", e.cookie, nil); r.Code != 404 {
		t.Errorf("A%%2541 must not match: %d %s", r.Code, r.Body.String())
	}
	if r := e.do(http.MethodDelete, "/api/v1/screener/saved/A%41", "", e.cookie, nil); r.Code != 200 {
		t.Errorf("A%%41 is the name AA: %d %s", r.Code, r.Body.String())
	}
}

// B13R-2: an alias and its current symbol are one stock, so listing both is below the 2-stock minimum.
func TestCompareAliasAndCurrentSymbolIsOneStock(t *testing.T) {
	e := newScrEnv(t)
	e.stock("AAA", "IT", "Software", `{"pe":10}`)
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol) SELECT id, 'OLDAAA' FROM instrument WHERE symbol = 'AAA'`)
	if r := e.get("/api/v1/compare?symbols=OLDAAA,AAA"); r.Code != 422 || !strings.Contains(r.Body.String(), `"symbols"`) {
		t.Errorf("alias+current: %d %s", r.Code, r.Body.String())
	}
}

// B13R-3: a non-numeric market_cap_cr on a candidate is "no market cap" (skipped), never a 500.
func TestPeersIgnoreNonNumericMarketCap(t *testing.T) {
	e := newScrEnv(t)
	e.stock("SELF", "Tech", "Software", `{"market_cap_cr":1000}`)
	e.stock("GOOD", "Tech", "Software", `{"market_cap_cr":900}`)
	e.stock("BAD", "Tech", "Software", `{"market_cap_cr":"abc"}`)
	e.stock("NEG", "Tech", "Software", `{"market_cap_cr":-5}`)
	b, code := e.peers("SELF/peers")
	if code != 200 || b.peerSymbols() != "GOOD" {
		t.Fatalf("%d %s", code, b.peerSymbols())
	}
}
