package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/mf"
)

type fakeBackfiller struct {
	calls []int32
	out   mf.Backfill
	err   error
}

func (f *fakeBackfiller) EnqueueMFRefresh(_ context.Context, code int32) (mf.Backfill, error) {
	f.calls = append(f.calls, code)
	return f.out, f.err
}

type mfEnv struct {
	*authEnv
	cookie string
	bf     *fakeBackfiller
}

func newMFEnv(t *testing.T) *mfEnv {
	t.Helper()
	e := newAuthEnv(t)
	bf := &fakeBackfiller{out: mf.Backfill{Status: "queued", JobID: ptr(int64(7))}}
	svc := mf.New(e.pool, bf)
	svc.Now = func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, MF: svc})
	return &mfEnv{authEnv: e, cookie: e.login(ownerPassword), bf: bf}
}

func ptr[T any](v T) *T { return &v }

func (e *mfEnv) get(path string) resp { return e.do(http.MethodGet, path, "", e.cookie, nil) }

func (e *mfEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *mfEnv) scheme(code int, name, house, category, plan, option, status string) {
	e.t.Helper()
	e.exec(`INSERT INTO mf_scheme (code, name, fund_house, category, plan, option_type, status)
	        VALUES ($1,$2,$3,$4,$5,$6,$7)`, code, name, house, category, plan, option, status)
}

// navs inserts one NAV per calendar day from..to, rising by step per day from nav0.
func (e *mfEnv) navs(code int, from, to string, nav0, step float64) {
	e.t.Helper()
	e.exec(`INSERT INTO mf_nav (scheme_code, nav_date, nav)
	        SELECT $1, d::date, $4::float8 + ($5::float8) * (d::date - $2::date)
	        FROM generate_series($2::date, $3::date, interval '1 day') d`, code, from, to, nav0, step)
	e.exec(`UPDATE mf_scheme SET last_nav_date = $2 WHERE code = $1`, code, to)
}

type mfBody struct {
	Data     json.RawMessage `json:"data"`
	Meta     map[string]any  `json:"meta"`
	Warnings []struct {
		Code string `json:"code"`
	} `json:"warnings"`
	Error struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func decodeMF(t *testing.T, r resp) mfBody {
	t.Helper()
	var b mfBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return b
}

func (b mfBody) hasWarning(code string) bool {
	for _, w := range b.Warnings {
		if w.Code == code {
			return true
		}
	}
	return false
}

func dataInto(t *testing.T, b mfBody, dst any) {
	t.Helper()
	if err := json.Unmarshal(b.Data, dst); err != nil {
		t.Fatalf("decode data: %v: %s", err, b.Data)
	}
}

func seedVariants(e *mfEnv) {
	e.scheme(100001, "Alpha Flexi Cap Fund - Direct Plan - Growth Option", "Alpha MF", "Equity: Flexi Cap", "direct", "growth", "active")
	e.scheme(100002, "Alpha Flexi Cap Fund - Direct Plan - IDCW", "Alpha MF", "Equity: Flexi Cap", "direct", "idcw", "active")
	e.scheme(100003, "Alpha Flexi Cap Fund - Regular Plan - Growth", "Alpha MF", "Equity: Flexi Cap", "regular", "growth", "active")
	e.scheme(100004, "Alpha Flexi Cap Fund - Regular Plan - IDCW", "Alpha MF", "Equity: Flexi Cap", "regular", "idcw", "active")
	e.scheme(100005, "Beta Liquid Fund - Direct Plan - Growth", "Beta MF", "Debt: Liquid", "direct", "growth", "inactive")
}

type searchData struct {
	Items []struct {
		Code     int32  `json:"code"`
		Plan     string `json:"plan"`
		Option   string `json:"option"`
		Variants []struct {
			Code int32 `json:"code"`
		} `json:"variants"`
		Name string `json:"name"`
	} `json:"items"`
	NextCursor  *string `json:"next_cursor"`
	Attribution string  `json:"attribution"`
}

func (e *mfEnv) search(query string) (searchData, resp) {
	e.t.Helper()
	r := e.get("/api/v1/mf/schemes" + query)
	var sd searchData
	if r.Code == http.StatusOK {
		dataInto(e.t, decodeMF(e.t, r), &sd)
	}
	return sd, r
}

// MF-01: Direct + Growth by default, explicit filters, include_all, grouping.
func TestMFSearchDefaultsAndGrouping(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)

	sd, _ := e.search("")
	if len(sd.Items) != 1 || sd.Items[0].Code != 100001 {
		t.Fatalf("default = %+v", sd.Items)
	}
	if sd.Attribution != mf.Attribution {
		t.Fatalf("attribution = %q", sd.Attribution)
	}
	if sd, _ = e.search("?include_all=true"); len(sd.Items) != 5 {
		t.Fatalf("include_all = %d items", len(sd.Items))
	}
	if sd, _ = e.search("?plan=regular&option=idcw"); len(sd.Items) != 1 || sd.Items[0].Code != 100004 {
		t.Fatalf("regular idcw = %+v", sd.Items)
	}
	if sd, _ = e.search("?include_all=true&plan=regular"); len(sd.Items) != 2 {
		t.Fatalf("include_all+regular = %d", len(sd.Items))
	}
	sd, _ = e.search("?include_all=true&group=true")
	if len(sd.Items) != 2 {
		t.Fatalf("groups = %+v", sd.Items)
	}
	if sd.Items[0].Name != "Alpha Flexi Cap Fund" || len(sd.Items[0].Variants) != 4 {
		t.Fatalf("group 0 = %+v", sd.Items[0])
	}
	// Words may come in any order and any case; the filters AND together.
	if sd, _ = e.search("?q=CAP%20alpha&include_all=true"); len(sd.Items) != 4 {
		t.Fatalf("q = %d", len(sd.Items))
	}
	if sd, _ = e.search("?q=liquid"); len(sd.Items) != 0 {
		t.Fatal("inactive scheme must be hidden by default")
	}
	// LIKE wildcards in the query are literal.
	if sd, _ = e.search("?q=%25&include_all=true"); len(sd.Items) != 0 {
		t.Fatalf("%% matched %d items", len(sd.Items))
	}
	if sd, _ = e.search("?category=" + "Debt:%20Liquid&include_all=true"); len(sd.Items) != 1 {
		t.Fatalf("category = %d", len(sd.Items))
	}
	for _, q := range []string{"?plan=other", "?option=div", "?limit=0", "?include_all=maybe"} {
		if _, r := e.search(q); r.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s -> %d", q, r.Code)
		}
	}
	if _, r := e.search("?cursor=%21%21"); r.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad cursor -> %d", r.Code)
	}
}

func TestMFSearchCursorPagination(t *testing.T) {
	e := newMFEnv(t)
	for i := 0; i < 7; i++ {
		e.scheme(200000+i, fmt.Sprintf("Gamma Fund %02d - Direct - Growth", i), "G", "Equity", "direct", "growth", "active")
	}
	seen := map[int32]bool{}
	var order []int32
	q := "?limit=3"
	for pages := 0; pages < 5; pages++ {
		sd, r := e.search(q)
		if r.Code != 200 {
			t.Fatalf("page %d: %d", pages, r.Code)
		}
		for _, it := range sd.Items {
			if seen[it.Code] {
				t.Fatalf("duplicate %d", it.Code)
			}
			seen[it.Code] = true
			order = append(order, it.Code)
		}
		if sd.NextCursor == nil {
			break
		}
		q = "?limit=3&cursor=" + *sd.NextCursor
	}
	if len(order) != 7 {
		t.Fatalf("got %v", order)
	}
	for i := 1; i < len(order); i++ {
		if order[i] < order[i-1] {
			t.Fatalf("not sorted by name: %v", order)
		}
	}
}

type detailData struct {
	Code      int32  `json:"code"`
	Option    string `json:"option"`
	LatestNav *struct {
		Value float64 `json:"value"`
		Date  string  `json:"date"`
	} `json:"latest_nav"`
	Returns      map[string]*float64 `json:"returns"`
	ReturnBasis  map[string]string   `json:"return_basis"`
	ReturnReason map[string]string   `json:"return_reasons"`
	Risk         *struct {
		Volatility *float64 `json:"volatility_pct"`
		Reason     *string  `json:"volatility_reason"`
	} `json:"risk"`
	Backfill    *mf.Backfill `json:"backfill"`
	Attribution string       `json:"attribution"`
	NavCount    int64        `json:"nav_count"`
}

const metricsShort = `{"end_date":"2026-10-19","end_nav":13.0,"first_nav_date":"2026-04-02",
 "returns":{"1m":2.5,"3m":6.1,"6m":null,"ytd":null,"1y":null,"3y":null,"5y":null,"since":9.9},
 "return_reasons":{"6m":"insufficient_history","ytd":"insufficient_history","1y":"insufficient_history","3y":"insufficient_history","5y":"insufficient_history"},
 "volatility":null,"volatility_reason":"insufficient_history","volatility_years":null,"max_drawdown":-3.2,
 "sharpe_like":null,"sharpe_reason":"insufficient_history","risk_free_rate":0.065,"rolling_1y":null,"nav_jumps":[]}`

// MF-04: a window longer than the history is null with a reason, never 0.
func TestMFDetailShortHistoryIsNull(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2026-04-02", "2026-10-19", 10, 0.015)
	e.exec(`INSERT INTO mf_return_cache (scheme_code, as_of, metrics) VALUES (100001, '2026-10-19', $1::jsonb)`, metricsShort)

	r := e.get("/api/v1/mf/schemes/100001")
	if r.Code != 200 {
		t.Fatalf("status %d: %s", r.Code, r.Body.String())
	}
	b := decodeMF(t, r)
	var d detailData
	dataInto(t, b, &d)
	if d.Returns["r_1m"] == nil || *d.Returns["r_1m"] != 2.5 {
		t.Fatalf("r_1m = %v", d.Returns["r_1m"])
	}
	for _, k := range []string{"r_6m", "r_ytd", "r_1y", "r_3y", "r_5y"} {
		v, present := d.Returns[k]
		if !present || v != nil || d.ReturnReason[k] != "insufficient_history" {
			t.Errorf("%s = %v (present=%v) reason=%q", k, v, present, d.ReturnReason[k])
		}
	}
	if d.ReturnBasis["r_1y"] != "cagr" || d.ReturnBasis["r_3m"] != "absolute" || d.ReturnBasis["r_since"] != "absolute" {
		t.Fatalf("basis = %v", d.ReturnBasis)
	}
	if d.Risk == nil || d.Risk.Volatility != nil || d.Risk.Reason == nil {
		t.Fatalf("risk = %+v", d.Risk)
	}
	if d.LatestNav == nil || d.LatestNav.Date != "2026-10-19" || d.Attribution != mf.Attribution {
		t.Fatalf("latest/attribution = %+v %q", d.LatestNav, d.Attribution)
	}
	if b.Meta["source"] != "mfapi.in" || b.Meta["as_of"] != "2026-10-19T00:00:00Z" || b.Meta["stale"] != false {
		t.Fatalf("meta = %v", b.Meta)
	}
	var opened *time.Time
	if err := e.pool.QueryRow(context.Background(), `SELECT last_opened_at FROM mf_scheme WHERE code=100001`).Scan(&opened); err != nil || opened == nil {
		t.Fatalf("last_opened_at not set: %v", err)
	}
}

func TestMFDetailWarnings(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100002, "2026-01-01", "2026-10-19", 10, 0.01) // IDCW, no cache row
	b := decodeMF(t, e.get("/api/v1/mf/schemes/100002"))
	if !b.hasWarning("IDCW_NOT_COMPARABLE") || !b.hasWarning("METRICS_PENDING") || b.hasWarning("SCHEME_MAY_BE_MERGED") {
		t.Fatalf("warnings = %+v", b.Warnings)
	}
	e.navs(100005, "2026-01-01", "2026-09-01", 10, 0.01) // inactive, last NAV 49 days old
	b = decodeMF(t, e.get("/api/v1/mf/schemes/100005"))
	if !b.hasWarning("SCHEME_MAY_BE_MERGED") || b.Meta["stale"] != true {
		t.Fatalf("inactive: %+v meta=%v", b.Warnings, b.Meta)
	}
}

func TestMFDetailNoNavEnqueuesBackfill(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	b := decodeMF(t, e.get("/api/v1/mf/schemes/100003"))
	var d detailData
	dataInto(t, b, &d)
	if d.Backfill == nil || d.Backfill.Status != "queued" || d.Backfill.JobID == nil || *d.Backfill.JobID != 7 {
		t.Fatalf("backfill = %+v", d.Backfill)
	}
	if len(e.bf.calls) != 1 || e.bf.calls[0] != 100003 || d.LatestNav != nil || !b.hasWarning("NO_NAV_DATA") {
		t.Fatalf("calls=%v latest=%v", e.bf.calls, d.LatestNav)
	}
	// A refused enqueue (cooldown) still answers 200 with status none.
	e.bf.out, e.bf.err = mf.Backfill{Status: "none"}, errors.New("rate limited")
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100003")), &d)
	if d.Backfill == nil || d.Backfill.Status != "none" {
		t.Fatalf("backfill = %+v", d.Backfill)
	}
}

// MF-13: wrong scheme code is a 404 with suggestions.
func TestMFUnknownCode(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	for _, p := range []string{"/mf/schemes/100999", "/mf/schemes/100999/nav", "/mf/schemes/100999/sip?amount=500&start=2024-01-01", "/mf/schemes/abc"} {
		r := e.get("/api/v1" + p)
		b := decodeMF(t, r)
		if r.Code != 404 || b.Error.Code != "NOT_FOUND" {
			t.Fatalf("%s -> %d %s", p, r.Code, r.Body.String())
		}
	}
	b := decodeMF(t, e.get("/api/v1/mf/schemes/100999"))
	// Suggestions are active schemes sharing the first four digits (B10-4): none for 1009...,
	// the four active variants for 1000..., and the inactive scheme 100005 is never offered.
	sug, ok := b.Error.Details["suggestions"].([]any)
	if !ok || len(sug) != 0 {
		t.Fatalf("suggestions for 1009-prefix = %v", b.Error.Details["suggestions"])
	}
	b = decodeMF(t, e.get("/api/v1/mf/schemes/100099"))
	if sug, _ = b.Error.Details["suggestions"].([]any); len(sug) != 4 {
		t.Fatalf("suggestions for 1000-prefix = %v", sug)
	}
}

func TestMFRequiresSession(t *testing.T) {
	e := newMFEnv(t)
	if r := e.do(http.MethodGet, "/api/v1/mf/schemes", "", "", nil); r.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", r.Code)
	}
}

type navData struct {
	Points      [][]any `json:"points"`
	RawCount    int     `json:"raw_count"`
	Downsampled bool    `json:"downsampled"`
	Log         bool    `json:"log"`
	Range       string  `json:"range"`
}

func TestMFNavSeries(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2018-01-01", "2026-10-19", 10, 0.001) // 3,214 rows
	var n navData
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100001/nav?range=MAX&log=true")), &n)
	if len(n.Points) != 2000 || !n.Downsampled || n.RawCount != 3214 || !n.Log {
		t.Fatalf("len=%d raw=%d down=%v", len(n.Points), n.RawCount, n.Downsampled)
	}
	if n.Points[0][0] != "2018-01-01" || n.Points[1999][0] != "2026-10-19" {
		t.Fatalf("ends = %v .. %v", n.Points[0], n.Points[1999])
	}
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100001/nav?range=1M")), &n)
	if n.Downsampled || len(n.Points) != 31 || n.Points[0][0] != "2026-09-19" {
		t.Fatalf("1M: len=%d first=%v", len(n.Points), n.Points[0])
	}
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100001/nav")), &n)
	if n.Range != "1Y" {
		t.Fatalf("default range = %q", n.Range)
	}
	if r := e.get("/api/v1/mf/schemes/100001/nav?range=2Y"); r.Code != 422 {
		t.Fatalf("bad range -> %d", r.Code)
	}
	// Known scheme without NAV rows: 404 DATA_UNAVAILABLE, not an empty chart.
	r := e.get("/api/v1/mf/schemes/100003/nav")
	if b := decodeMF(t, r); r.Code != 404 || b.Error.Code != "DATA_UNAVAILABLE" {
		t.Fatalf("no nav -> %d %s", r.Code, r.Body.String())
	}
}

type sipData struct {
	Invested     string   `json:"invested"`
	Value        *string  `json:"value"`
	Installments int      `json:"installments"`
	Skipped      int      `json:"skipped_installments"`
	AbsReturnPct *float64 `json:"absolute_return_pct"`
	XIRRPct      *float64 `json:"xirr_pct"`
	End          string   `json:"end"`
	Schedule     []struct {
		Date    string `json:"date"`
		NavDate string `json:"nav_date"`
	} `json:"schedule"`
}

// MF-10 and MF-11 through the API.
func TestMFSip(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2024-03-10", "2026-10-19", 10, 0) // flat NAV
	base := "/api/v1/mf/schemes/100001/sip?amount=1000&"

	var s sipData
	b := decodeMF(t, e.get(base+"start=2024-01-01&end=2024-06-30&day=1"))
	dataInto(t, b, &s)
	if s.Skipped != 3 || s.Installments != 3 || s.Invested != "3000.00" || s.Value == nil || *s.Value != "3000.00" {
		t.Fatalf("MF-10: %+v", s)
	}
	if !b.hasWarning("INSTALLMENTS_SKIPPED") {
		t.Fatalf("warnings = %+v", b.Warnings)
	}
	if s.Schedule[0].Date != "2024-04-01" {
		t.Fatalf("schedule = %+v", s.Schedule)
	}

	// Execution on the next available NAV: first NAV is 2024-03-10, installment day 5 -> April.
	dataInto(t, decodeMF(t, e.get(base+"start=2024-03-01&end=2025-03-01&day=5")), &s)
	if s.Skipped != 1 || s.Installments != 11 || s.XIRRPct == nil || *s.XIRRPct != 0 {
		t.Fatalf("%+v xirr=%v", s, s.XIRRPct)
	}

	// end beyond the latest NAV is clamped with a warning; end defaults to the latest NAV.
	b = decodeMF(t, e.get(base+"start=2026-01-01&end=2027-01-01"))
	dataInto(t, b, &s)
	if s.End != "2026-10-19" || !b.hasWarning("END_CLAMPED") {
		t.Fatalf("end = %s warnings=%+v", s.End, b.Warnings)
	}
	dataInto(t, decodeMF(t, e.get(base+"start=2026-01-01")), &s)
	if s.End != "2026-10-19" {
		t.Fatalf("default end = %s", s.End)
	}

	// All installments before the first NAV: no value, nulls rather than zeros.
	b = decodeMF(t, e.get(base+"start=2020-01-01&end=2020-03-01"))
	dataInto(t, b, &s)
	if s.Value != nil || s.XIRRPct != nil || s.AbsReturnPct != nil || s.Installments != 0 || s.Skipped != 3 || !b.hasWarning("NO_INSTALLMENTS") {
		t.Fatalf("%+v", s)
	}

	// MF-11: day 29-31 (and 0, text) are rejected; other validation.
	for _, q := range []string{
		"start=2024-05-01&day=29", "start=2024-05-01&day=31", "start=2024-05-01&day=0", "start=2024-05-01&day=x",
		"start=2024-05-01&end=2024-04-01", "start=nope", "end=2024-04-01", "start=1980-01-01",
	} {
		if r := e.get(base + q); r.Code != 422 {
			t.Errorf("%s -> %d", q, r.Code)
		}
	}
	for _, a := range []string{"0", "-5", "abc", "10.123", "", "1e12"} {
		if r := e.get("/api/v1/mf/schemes/100001/sip?start=2024-05-01&amount=" + a); r.Code != 422 {
			t.Errorf("amount=%q -> %d", a, r.Code)
		}
	}
	if r := e.get("/api/v1/mf/schemes/100001/sip?start=2024-05-01&day=28&amount=1000"); r.Code != 200 {
		t.Errorf("day 28 -> %d", r.Code)
	}
}

type compareData struct {
	CommonStart     string `json:"common_start"`
	CommonEnd       string `json:"common_end"`
	DifferentStarts bool   `json:"different_starts"`
	Series          []struct {
		Code   int32   `json:"code"`
		Points [][]any `json:"points"`
	} `json:"series"`
	Table []struct {
		Code             int32    `json:"code"`
		FirstNavDate     string   `json:"first_nav_date"`
		HistoryShorter   bool     `json:"history_shorter_than_range"`
		ReturnPct        *float64 `json:"return_pct"`
		ReturnBasis      string   `json:"return_basis"`
		VolatilityPct    *float64 `json:"volatility_pct"`
		VolatilityReason *string  `json:"volatility_reason"`
		MaxDrawdownPct   *float64 `json:"max_drawdown_pct"`
	} `json:"table"`
}

// MF-14: schemes with different starts are rebased to 100 at the first common date and flagged.
func TestMFCompare(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2020-01-01", "2026-10-19", 10, 0.005)
	e.navs(100003, "2023-06-15", "2026-10-19", 50, 0.01)
	e.navs(100004, "2020-01-01", "2026-10-19", 20, 0.002)

	var c compareData
	b := decodeMF(t, e.get("/api/v1/mf/compare?codes=100001,100003&range=MAX"))
	dataInto(t, b, &c)
	if c.CommonStart != "2023-06-15" || !c.DifferentStarts || !b.hasWarning("DIFFERENT_STARTS") {
		t.Fatalf("%+v warnings=%+v", c, b.Warnings)
	}
	for _, s := range c.Series {
		if s.Points[0][0] != "2023-06-15" || s.Points[0][1] != float64(100) {
			t.Fatalf("series %d starts %v", s.Code, s.Points[0])
		}
	}
	if len(c.Table) != 2 || c.Table[0].ReturnPct == nil || c.Table[0].ReturnBasis != "cagr" || c.Table[0].MaxDrawdownPct == nil {
		t.Fatalf("table = %+v", c.Table)
	}

	// Same starts: no flag. Default range is 3Y; 1M gives an absolute return and null volatility.
	b = decodeMF(t, e.get("/api/v1/mf/compare?codes=100001,100004"))
	dataInto(t, b, &c)
	if c.DifferentStarts || b.hasWarning("DIFFERENT_STARTS") || c.CommonStart != "2023-10-19" {
		t.Fatalf("same starts: %+v", c)
	}
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/compare?codes=100001,100004&range=1M")), &c)
	if c.Table[0].ReturnBasis != "absolute" || c.Table[0].VolatilityPct != nil || c.Table[0].VolatilityReason == nil {
		t.Fatalf("1M table = %+v", c.Table[0])
	}
	// A scheme younger than the range is marked.
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/compare?codes=100001,100003&range=5Y")), &c)
	if !c.Table[1].HistoryShorter || c.Table[0].HistoryShorter {
		t.Fatalf("shorter flags: %+v", c.Table)
	}

	for _, q := range []string{"", "?codes=100001", "?codes=100001,100001", "?codes=1,2,3,4,5,6", "?codes=a,b", "?codes=100001,100004&range=9Y"} {
		if r := e.get("/api/v1/mf/compare" + q); r.Code != 422 {
			t.Errorf("%q -> %d", q, r.Code)
		}
	}
	if r := e.get("/api/v1/mf/compare?codes=100001,999999"); r.Code != 404 {
		t.Errorf("unknown code -> %d", r.Code)
	}
	if r := e.get("/api/v1/mf/compare?codes=100001,100002"); r.Code != 404 { // 100002 has no NAV rows
		t.Errorf("no nav -> %d", r.Code)
	}
	// No shared date: disjoint histories.
	e.navs(100002, "2026-10-19", "2026-10-19", 10, 0)
	e.exec(`DELETE FROM mf_nav WHERE scheme_code = 100001 AND nav_date = '2026-10-19'`)
	if r := e.get("/api/v1/mf/compare?codes=100001,100002&range=1M"); r.Code != 422 {
		t.Errorf("no common dates -> %d %s", r.Code, r.Body.String())
	}
}

func TestMFCategories(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	var d struct {
		Items []string `json:"items"`
	}
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/categories")), &d)
	// The inactive scheme's category is not offered.
	if len(d.Items) != 1 || d.Items[0] != "Equity: Flexi Cap" {
		t.Fatalf("categories = %v", d.Items)
	}
}
