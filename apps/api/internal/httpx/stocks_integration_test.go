package httpx

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/instruments"
)

type stockEnv struct {
	*authEnv
	cookie string
}

func newStockEnv(t *testing.T) *stockEnv {
	t.Helper()
	e := newAuthEnv(t)
	svc := instruments.New(e.pool)
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Stocks: svc})
	return &stockEnv{authEnv: e, cookie: e.login(ownerPassword)}
}

func (e *stockEnv) get(path string) resp { return e.do(http.MethodGet, path, "", e.cookie, nil) }

func (e *stockEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *stockEnv) addStock(symbol, name string, extra ...string) {
	e.t.Helper()
	e.exec(`INSERT INTO instrument (symbol, name) VALUES ($1, $2)`, symbol, name)
	for _, x := range extra {
		e.exec(x)
	}
}

func (e *stockEnv) addBar(symbol string, date string) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source)
	        SELECT id, $2::date, 10, 11, 9, 10, 10, 'import' FROM instrument WHERE symbol = $1`, symbol, date)
}

type profileBody struct {
	Data struct {
		ID             int32  `json:"id"`
		Symbol         string `json:"symbol"`
		RedirectSymbol string `json:"redirect_symbol"`
		Tracked        bool   `json:"tracked"`
		PriceMode      string `json:"price_mode"`
		BrokerOK       *bool  `json:"broker_ok"`
		Hint           string `json:"hint"`
		Quote          any    `json:"quote"`
		Freshness      struct {
			PricesStale     bool    `json:"prices_stale"`
			HolidaysMissing bool    `json:"holidays_missing"`
			PricesAsOf      *string `json:"prices_as_of"`
		} `json:"freshness"`
		Flags struct {
			NoPrices       bool    `json:"no_prices"`
			LimitedHistory bool    `json:"limited_history"`
			SeriesWarning  *string `json:"series_warning"`
		} `json:"flags"`
	} `json:"data"`
	Meta map[string]any `json:"meta"`
}

func decodeProfile(t *testing.T, r resp) profileBody {
	t.Helper()
	var b profileBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return b
}

type listBody struct {
	Data struct {
		Items []struct {
			Symbol string `json:"symbol"`
		} `json:"items"`
		NextCursor *string `json:"next_cursor"`
	} `json:"data"`
}

func (e *stockEnv) list(query string) (symbols []string, next *string, code int) {
	e.t.Helper()
	r := e.get("/api/v1/stocks" + query)
	var b listBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		e.t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	for _, it := range b.Data.Items {
		symbols = append(symbols, it.Symbol)
	}
	return symbols, b.Data.NextCursor, r.Code
}

// Stocks routes need a session.
func TestStocksRequireSession(t *testing.T) {
	e := newStockEnv(t)
	for _, p := range []string{"/api/v1/stocks", "/api/v1/stocks/index", "/api/v1/stocks/TCS"} {
		if r := e.do(http.MethodGet, p, "", "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d", p, r.Code)
		}
	}
}

// API-01
func TestUnknownSymbolIs404(t *testing.T) {
	e := newStockEnv(t)
	r := e.get("/api/v1/stocks/XYZ")
	if r.Code != http.StatusNotFound {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var env struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.Body.Bytes(), &env)
	if env.Error.Code != "NOT_FOUND" || env.Error.Details["symbol"] != "XYZ" {
		t.Fatalf("%s", r.Body.String())
	}
}

// Symbols with special characters resolve, in any case, through the URL-encoded path.
// API-20
func TestSymbolsWithSpecialCharactersResolve(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("M&M", "Mahindra & Mahindra Ltd")
	e.addStock("BAJAJ-AUTO", "Bajaj Auto Ltd")
	for path, want := range map[string]string{
		"/api/v1/stocks/M%26M": "M&M", "/api/v1/stocks/m%26m": "M&M",
		"/api/v1/stocks/BAJAJ-AUTO": "BAJAJ-AUTO", "/api/v1/stocks/bajaj-auto": "BAJAJ-AUTO",
	} {
		r := e.get(path)
		if r.Code != 200 {
			t.Fatalf("%s: %d %s", path, r.Code, r.Body.String())
		}
		if got := decodeProfile(t, r).Data.Symbol; got != want {
			t.Errorf("%s: symbol %q want %q", path, got, want)
		}
	}
}

// API-02, API-24
func TestAliasReturnsRedirectSymbol(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("NEWCO", "New Co Ltd")
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol, changed_on)
	        SELECT id, 'OLDCO', '2026-01-05' FROM instrument WHERE symbol = 'NEWCO'`)
	r := e.get("/api/v1/stocks/oldco")
	if r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	b := decodeProfile(t, r)
	if b.Data.RedirectSymbol != "NEWCO" || b.Data.Symbol != "" {
		t.Fatalf("%s", r.Body.String())
	}
	var opened *time.Time
	if err := e.pool.QueryRow(context.Background(), `SELECT last_opened_at FROM instrument WHERE symbol='NEWCO'`).Scan(&opened); err != nil {
		t.Fatal(err)
	}
	if opened != nil {
		t.Error("an alias redirect must not count as opening the stock")
	}
	// An instrument symbol wins over an alias of the same text.
	e.addStock("OLDCO", "Reused Symbol Ltd")
	if got := decodeProfile(t, e.get("/api/v1/stocks/OLDCO")).Data.Symbol; got != "OLDCO" {
		t.Errorf("live symbol must win over alias, got %q", got)
	}
}

// BRK-07, BRK-12 (no refresh/backfill in manual mode; the explicit 422 PRICE_MODE_MANUAL endpoints are B09) and the manual-mode amendment: opening tracks the stock, never enqueues a job.
func TestOpenStockManualModeTracksAndEnqueuesNothing(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("TCS", "Tata Consultancy Services Ltd")
	r := e.get("/api/v1/stocks/TCS")
	if r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	b := decodeProfile(t, r)
	if b.Data.PriceMode != "manual" || !b.Data.Tracked || b.Data.BrokerOK != nil || b.Data.Quote != nil {
		t.Fatalf("%s", r.Body.String())
	}
	if !b.Data.Flags.NoPrices || b.Data.Hint != "Import prices.csv for TCS" || b.Data.Freshness.PricesAsOf != nil {
		t.Fatalf("no_prices state wrong: %s", r.Body.String())
	}
	if strings.Contains(r.Body.String(), `"backfill"`) {
		t.Error("manual mode has no backfill block")
	}
	var reason string
	var jobs int
	var opened *time.Time
	ctx := context.Background()
	if err := e.pool.QueryRow(ctx, `SELECT tracked_reason, last_opened_at FROM instrument WHERE symbol='TCS'`).Scan(&reason, &opened); err != nil {
		t.Fatal(err)
	}
	if reason != "opened" || opened == nil {
		t.Errorf("tracked_reason=%q last_opened_at=%v", reason, opened)
	}
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM refresh_job`).Scan(&jobs); err != nil || jobs != 0 {
		t.Errorf("refresh_job rows = %d (%v), want 0", jobs, err)
	}
}

// An already tracked stock keeps its tracked_reason.
// API-25
func TestOpenKeepsExistingTrackedReason(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("INFY", "Infosys Ltd", `UPDATE instrument SET is_tracked = true, tracked_reason = 'imported' WHERE symbol = 'INFY'`)
	if r := e.get("/api/v1/stocks/INFY"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	var reason string
	if err := e.pool.QueryRow(context.Background(), `SELECT tracked_reason FROM instrument WHERE symbol='INFY'`).Scan(&reason); err != nil || reason != "imported" {
		t.Fatalf("reason=%q err=%v", reason, err)
	}
}

// API-06: concurrent opens of a never-opened stock never create jobs and leave one consistent state.
func TestConcurrentOpensAreIdempotent(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("WIPRO", "Wipro Ltd")
	var wg sync.WaitGroup
	codes := make([]int, 12)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = e.get("/api/v1/stocks/WIPRO").Code
		}()
	}
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Errorf("request %d: %d", i, c)
		}
	}
	var jobs, tracked int
	ctx := context.Background()
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM refresh_job`).Scan(&jobs)
	_ = e.pool.QueryRow(ctx, `SELECT count(*) FROM instrument WHERE is_tracked AND tracked_reason = 'opened'`).Scan(&tracked)
	if jobs != 0 || tracked != 1 {
		t.Errorf("jobs=%d tracked=%d", jobs, tracked)
	}
}

// SYS-13, API-27 through the profile: holiday data present vs missing.
func TestProfileFreshnessRule(t *testing.T) {
	e := newStockEnv(t)
	svc := instruments.New(e.pool)
	// 2026-10-14 is a Wednesday, after the 18:00 IST cutoff (12:30 UTC): expected last bar 2026-10-14.
	svc.Now = func() time.Time { return time.Date(2026, 10, 14, 13, 0, 0, 0, time.UTC) }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Stocks: svc})
	e.addStock("AAA", "Aaa Ltd")
	e.addBar("AAA", "2026-10-13") // one trading day behind
	b := decodeProfile(t, e.get("/api/v1/stocks/AAA"))
	if !b.Data.Freshness.HolidaysMissing || b.Data.Freshness.PricesStale {
		t.Fatalf("no holiday rows: missing=%v stale=%v (1 day old must not be stale)", b.Data.Freshness.HolidaysMissing, b.Data.Freshness.PricesStale)
	}
	e.exec(`INSERT INTO market_holiday (holiday_date, description, source) VALUES ('2026-11-08', 'Diwali', 'import')`)
	b = decodeProfile(t, e.get("/api/v1/stocks/AAA"))
	if b.Data.Freshness.HolidaysMissing || !b.Data.Freshness.PricesStale {
		t.Fatalf("with holiday rows: missing=%v stale=%v, want stale", b.Data.Freshness.HolidaysMissing, b.Data.Freshness.PricesStale)
	}
	if b.Meta["stale"] != true || b.Meta["stale_age_hours"] != float64(24) {
		t.Errorf("meta: %v", b.Meta)
	}
	e.addBar("AAA", "2026-10-14")
	b = decodeProfile(t, e.get("/api/v1/stocks/AAA"))
	if b.Data.Freshness.PricesStale || b.Data.Freshness.PricesAsOf == nil || *b.Data.Freshness.PricesAsOf != "2026-10-14" {
		t.Fatalf("fresh bar: %+v", b.Data.Freshness)
	}
}

// API-26
func TestProfileSeriesWarningAndLimitedHistory(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("BEBE", "Be Series Ltd", `UPDATE instrument SET series = 'BE', listing_date = '2000-01-01' WHERE symbol = 'BEBE'`)
	e.addBar("BEBE", "2025-06-02") // history starts far later than 5 years back
	b := decodeProfile(t, e.get("/api/v1/stocks/BEBE"))
	if b.Data.Flags.SeriesWarning == nil || *b.Data.Flags.SeriesWarning != "BE" || !b.Data.Flags.LimitedHistory || b.Data.Flags.NoPrices {
		t.Fatalf("%+v", b.Data.Flags)
	}
	// A young listing with a complete history is not "limited".
	e.addStock("NEWL", "New Listing Ltd", `UPDATE instrument SET listing_date = '2026-09-01' WHERE symbol = 'NEWL'`)
	e.addBar("NEWL", "2026-09-01")
	if decodeProfile(t, e.get("/api/v1/stocks/NEWL")).Data.Flags.LimitedHistory {
		t.Error("young listing flagged as limited history")
	}
}

type indexBody struct {
	Data struct {
		Count int     `json:"count"`
		Items [][]any `json:"items"`
	} `json:"data"`
}

// Empty state: no instruments gives an empty list, never an error.
// API-05
func TestEmptyDatabaseListsAreEmpty(t *testing.T) {
	e := newStockEnv(t)
	r := e.get("/api/v1/stocks/index")
	var b indexBody
	_ = json.Unmarshal(r.Body.Bytes(), &b)
	if r.Code != 200 || b.Data.Count != 0 || b.Data.Items == nil || len(b.Data.Items) != 0 {
		t.Fatalf("index: %d %s", r.Code, r.Body.String())
	}
	syms, next, code := e.list("")
	if code != 200 || len(syms) != 0 || next != nil {
		t.Fatalf("search: %d %v %v", code, syms, next)
	}
	if got := e.get("/api/v1/stocks?q=tcs"); got.Code != 200 || !strings.Contains(got.Body.String(), `"items":[]`) {
		t.Fatalf("search q: %d %s", got.Code, got.Body.String())
	}
}

// API-23
func TestIndexFlagsETagAndSize(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("TCS", "Tata Consultancy Services Ltd")
	e.addStock("HDFCBANK", "HDFC Bank Ltd", `UPDATE instrument SET company_type='financial' WHERE symbol='HDFCBANK'`)
	e.addStock("GOLDBEES", "Nippon India ETF Gold BeES", `UPDATE instrument SET instrument_kind='etf' WHERE symbol='GOLDBEES'`)
	e.addStock("OLDX", "Old Delisted Ltd", `UPDATE instrument SET status='delisted' WHERE symbol='OLDX'`)
	e.addStock("HALTED", "Halted Ltd", `UPDATE instrument SET status='suspended' WHERE symbol='HALTED'`)
	e.exec(`INSERT INTO index_constituent (index_name, instrument_id, as_of) SELECT 'NIFTY 50', id, '2026-09-30' FROM instrument WHERE symbol IN ('TCS','HDFCBANK')`)
	e.exec(`INSERT INTO index_constituent (index_name, instrument_id, as_of) SELECT 'NIFTY NEXT 50', id, '2026-09-30' FROM instrument WHERE symbol = 'HALTED'`)
	r := e.get("/api/v1/stocks/index")
	if r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	etag := r.Header().Get("ETag")
	if etag == "" || r.Header().Get("Cache-Control") != "private, max-age=3600" {
		t.Fatalf("headers: etag=%q cc=%q", etag, r.Header().Get("Cache-Control"))
	}
	var b indexBody
	_ = json.Unmarshal(r.Body.Bytes(), &b)
	flags := map[string]int{}
	for _, it := range b.Data.Items {
		flags[it[1].(string)] = int(it[3].(float64))
	}
	want := map[string]int{
		"TCS": instruments.FlagInNifty50 | instruments.FlagInNifty100, "HDFCBANK": instruments.FlagFinancial | instruments.FlagInNifty50 | instruments.FlagInNifty100,
		"GOLDBEES": instruments.FlagNonEquity, "OLDX": instruments.FlagDelisted,
		"HALTED": instruments.FlagSuspended | instruments.FlagInNifty100,
	}
	for s, w := range want {
		if flags[s] != w {
			t.Errorf("%s flags = %d want %d", s, flags[s], w)
		}
	}
	if len(b.Data.Items) != 5 {
		t.Errorf("index must exclude nothing, got %d", len(b.Data.Items))
	}
	// Conditional request.
	r2 := e.do(http.MethodGet, "/api/v1/stocks/index", "", e.cookie, map[string]string{"If-None-Match": etag})
	if r2.Code != http.StatusNotModified || r2.Body.Len() != 0 || r2.Header().Get("ETag") != etag {
		t.Fatalf("304: %d len=%d", r2.Code, r2.Body.Len())
	}
	// Opening a stock changes the tracked flag, so the ETag changes.
	e.get("/api/v1/stocks/TCS")
	if r3 := e.get("/api/v1/stocks/index"); r3.Header().Get("ETag") == etag {
		t.Error("ETag unchanged after the list changed")
	}
}

// API-23
func TestIndexPayloadUnder150kBGzipFor2300(t *testing.T) {
	e := newStockEnv(t)
	e.exec(`INSERT INTO instrument (symbol, name)
	        SELECT 'SYM' || lpad(g::text, 4, '0') || CASE WHEN g % 7 = 0 THEN '-X' ELSE '' END,
	               'Company Number ' || g || ' Industries Limited'
	        FROM generate_series(1, 2300) g`)
	r := e.get("/api/v1/stocks/index")
	var b indexBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil || b.Data.Count != 2300 {
		t.Fatalf("count=%d err=%v", b.Data.Count, err)
	}
	var zb bytes.Buffer
	zw := gzip.NewWriter(&zb)
	_, _ = zw.Write(r.Body.Bytes())
	_ = zw.Close()
	if zb.Len() >= 150*1024 {
		t.Fatalf("gz size %d >= 150 kB", zb.Len())
	}
	t.Logf("2300 instruments: raw %d B, gz %d B", r.Body.Len(), zb.Len())
}

// API-21
func TestSearchRankingAndFilters(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("TATA", "Zeta Holdings")                 // exact symbol
	e.addStock("TATAPOWER", "Power Corp")               // symbol prefix
	e.addStock("TATASTEEL", "Steel Corp")               // symbol prefix
	e.addStock("ABC", "Tata Consultancy Services Ltd")  // name prefix
	e.addStock("XYZ", "Tatas Consultancy Services Ltd") // trigram similar to "tata consultancy"? (not prefix of "tata")
	e.addStock("ZZZ", "Unrelated Business Ltd")         // no match
	e.addStock("ETFX", "Tata Gold ETF", `UPDATE instrument SET instrument_kind='etf' WHERE symbol='ETFX'`)
	e.addStock("GONE", "Tata Gone Ltd", `UPDATE instrument SET status='delisted' WHERE symbol='GONE'`)
	syms, _, code := e.list("?q=tata")
	if code != 200 {
		t.Fatalf("%d", code)
	}
	got := strings.Join(syms, ",")
	if !strings.HasPrefix(got, "TATA,TATAPOWER,TATASTEEL,ABC") || strings.Contains(got, "ZZZ") || strings.Contains(got, "ETFX") || strings.Contains(got, "GONE") {
		t.Fatalf("ranking/defaults: %s", got)
	}
	// Defaults can be widened.
	if syms, _, _ = e.list("?q=tata&kind=etf"); strings.Join(syms, ",") != "ETFX" {
		t.Errorf("kind=etf: %v", syms)
	}
	if syms, _, _ = e.list("?q=tata&status=delisted"); strings.Join(syms, ",") != "GONE" {
		t.Errorf("status=delisted: %v", syms)
	}
	// Lower case and LIKE metacharacters are literal.
	if syms, _, _ = e.list("?q=tatapower"); len(syms) == 0 || syms[0] != "TATAPOWER" {
		t.Errorf("case-insensitive: %v", syms)
	}
	for _, q := range []string{"%25", "_", "%25ata"} {
		if syms, _, _ = e.list("?q=" + q); len(syms) != 0 {
			t.Errorf("q=%s matched %v", q, syms)
		}
	}
	// Fuzzy: a typo still finds the company by trigram similarity (>= 0.3).
	if syms, _, _ = e.list("?q=" + "Unrelatd+Busness"); strings.Join(syms, ",") != "ZZZ" {
		t.Errorf("trigram: %v", syms)
	}
	// sector and index filters.
	e.exec(`UPDATE instrument SET sector = 'Power' WHERE symbol = 'TATAPOWER'`)
	e.exec(`INSERT INTO index_constituent (index_name, instrument_id, as_of) SELECT 'NIFTY 50', id, '2026-09-30' FROM instrument WHERE symbol = 'TATASTEEL'`)
	if syms, _, _ = e.list("?q=tata&sector=power"); strings.Join(syms, ",") != "TATAPOWER" {
		t.Errorf("sector: %v", syms)
	}
	if syms, _, _ = e.list("?q=tata&index=NIFTY50"); strings.Join(syms, ",") != "TATASTEEL" {
		t.Errorf("index: %v", syms)
	}
	// Browse without q is alphabetical.
	if syms, _, _ = e.list(""); len(syms) < 2 || syms[0] != "ABC" {
		t.Errorf("browse: %v", syms)
	}
}

// API-21
func TestSearchValidation(t *testing.T) {
	e := newStockEnv(t)
	for _, q := range []string{"?q=", "?q=%20", "?kind=bogus", "?status=bogus", "?limit=0", "?limit=abc", "?q=" + strings.Repeat("a", 101)} {
		r := e.get("/api/v1/stocks" + q)
		if r.Code != http.StatusUnprocessableEntity || !strings.Contains(r.Body.String(), `"fields"`) {
			t.Errorf("%q: %d %s", q, r.Code, r.Body.String())
		}
	}
	if r := e.get("/api/v1/stocks?cursor=%21%21"); r.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad cursor: %d", r.Code)
	}
	// An oversized limit is clamped, not rejected.
	if _, _, code := e.list("?limit=5000"); code != 200 {
		t.Errorf("limit clamp: %d", code)
	}
}

// API-03: keyset pagination is stable, complete and survives inserts between pages.
func TestSearchKeysetPaginationStable(t *testing.T) {
	e := newStockEnv(t)
	for i := 0; i < 25; i++ {
		e.addStock(fmt.Sprintf("ALPHA%02d", i), fmt.Sprintf("Plain Name %02d", i)) // symbol prefix
	}
	for i := 0; i < 10; i++ {
		e.addStock(fmt.Sprintf("S%02d", i), fmt.Sprintf("Alphabet Holdings %02d", i)) // name prefix
	}
	for i := 0; i < 6; i++ {
		e.addStock(fmt.Sprintf("T%02d", i), fmt.Sprintf("Alpha Betical Fuzz %02d", i)) // name prefix too
	}
	all, _, _ := e.list("?q=alpha&limit=200")
	if len(all) != 41 {
		t.Fatalf("unpaged = %d", len(all))
	}
	var paged []string
	cursor := ""
	inserted := false
	for pages := 0; pages < 20; pages++ {
		q := "?q=alpha&limit=7"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		syms, next, code := e.list(q)
		if code != 200 {
			t.Fatalf("page %d: %d", pages, code)
		}
		paged = append(paged, syms...)
		if next == nil {
			break
		}
		cursor = *next
		if !inserted { // a row that sorts before the cursor must not shift later pages
			e.addStock("ALPHA00A", "Late Insert")
			inserted = true
		}
	}
	seen := map[string]bool{}
	for _, s := range paged {
		if seen[s] {
			t.Fatalf("duplicate %s across pages", s)
		}
		seen[s] = true
	}
	for _, s := range all {
		if !seen[s] {
			t.Errorf("missing %s", s)
		}
	}
	if len(paged) != 41 && len(paged) != 42 {
		t.Errorf("paged = %d", len(paged))
	}
}

// API-22
func TestSearchTrigramPaginationFloatCursor(t *testing.T) {
	e := newStockEnv(t)
	for i := 0; i < 12; i++ {
		e.addStock(fmt.Sprintf("Q%02d", i), fmt.Sprintf("Reliance Industriez %s", strings.Repeat("x", i)))
	}
	all, _, _ := e.list("?q=Relience+Industries&limit=200")
	if len(all) == 0 {
		t.Fatal("no fuzzy matches")
	}
	var paged []string
	cursor := ""
	for i := 0; i < 20; i++ {
		q := "?q=Relience+Industries&limit=3"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		syms, next, _ := e.list(q)
		paged = append(paged, syms...)
		if next == nil {
			break
		}
		cursor = *next
	}
	if strings.Join(paged, ",") != strings.Join(all, ",") {
		t.Fatalf("paged %v != unpaged %v", paged, all)
	}
}
