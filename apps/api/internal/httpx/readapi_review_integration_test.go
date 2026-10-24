package httpx

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/india-analyzer/api/internal/instruments"
)

// Review fixes for B03, B04, B05 and B10 (docs/07 rows API-90..API-97, MF-96..MF-104, FND-90..FND-91).

// reviewErr decodes the error envelope without depending on other test files' helpers.
func reviewErr(t *testing.T, r resp) (code string, details map[string]any) {
	t.Helper()
	var env struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return env.Error.Code, env.Error.Details
}

// API-90: index names compare without spaces and case; NEXT50 (docs/03 section 3) sets bit 128.
func TestIndexFlagsNext50(t *testing.T) {
	e := newStockEnv(t)
	for _, s := range []string{"AAA", "BBB", "CCC", "DDD"} {
		e.addStock(s, s+" Ltd")
	}
	tag := func(sym, index string) {
		e.exec(`INSERT INTO index_constituent (index_name, instrument_id, as_of) SELECT $2, id, '2026-09-30' FROM instrument WHERE symbol = $1`, sym, index)
	}
	tag("AAA", "NEXT50")
	tag("BBB", "NIFTY 100")
	tag("CCC", "Next 50")
	tag("DDD", "NIFTY MIDCAP 150")
	r := e.get("/api/v1/stocks/index")
	var b indexBody
	_ = json.Unmarshal(r.Body.Bytes(), &b)
	flags := map[string]int{}
	for _, it := range b.Data.Items {
		flags[it[1].(string)] = int(it[3].(float64))
	}
	for _, s := range []string{"AAA", "BBB", "CCC"} {
		if flags[s]&instruments.FlagInNifty100 == 0 {
			t.Errorf("%s flags = %d, want in_nifty100 set", s, flags[s])
		}
	}
	if flags["DDD"]&instruments.FlagInNifty100 != 0 {
		t.Errorf("DDD must not be in_nifty100, flags = %d", flags["DDD"])
	}
}

// BRK-07 + BRK-08 on the profile: a stock whose only bars are suspect has no prices, exactly as
// /prices says; a valid bar older than a suspect one is the as-of.
func TestProfileIgnoresSuspectBars(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("ONLYBAD", "Only Suspect Ltd")
	e.addBarFull("ONLYBAD", "2026-10-01", 10, 11, 9, 10, 10, true)
	b := decodeProfile(t, e.get("/api/v1/stocks/ONLYBAD"))
	if !b.Data.Flags.NoPrices || b.Data.Freshness.PricesAsOf != nil || b.Data.Hint == "" {
		t.Fatalf("profile must report no prices: %+v", b.Data)
	}
	if _, code := e.prices("/api/v1/stocks/ONLYBAD/prices"); code != 404 {
		t.Fatalf("/prices code = %d", code)
	}

	e.addStock("MIXED", "Mixed Ltd")
	e.addBarFull("MIXED", "2026-09-29", 10, 11, 9, 10, 10, false)
	e.addBarFull("MIXED", "2026-10-01", 10, 11, 9, 10, 10, true)
	m := decodeProfile(t, e.get("/api/v1/stocks/MIXED"))
	if m.Data.Flags.NoPrices || m.Data.Freshness.PricesAsOf == nil || *m.Data.Freshness.PricesAsOf != "2026-09-29" {
		t.Fatalf("as-of must be the last valid bar: %+v", m.Data.Freshness)
	}
}

// API-92: NUL bytes and invalid UTF-8 never reach Postgres (422 for filters, 404 for symbols).
func TestNulAndInvalidUTF8AreRejected(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	for _, q := range []string{"?q=%00", "?q=%ff%fe", "?sector=%00", "?index=%00", "?q=a%00b"} {
		if r := e.get("/api/v1/stocks" + q); r.Code != 422 {
			t.Errorf("/stocks%s -> %d %s", q, r.Code, r.Body.String())
		}
	}
	for _, p := range []string{"/stocks/%00", "/stocks/%00/prices", "/stocks/%00/indicators", "/stocks/T%00S", "/stocks/%ff"} {
		if r := e.get("/api/v1" + p); r.Code != 404 {
			t.Errorf("%s -> %d %s", p, r.Code, r.Body.String())
		}
	}
}

// API-93: path symbols are percent-decoded exactly once: `A%2541` names the symbol `A%41`, not `AA`.
func TestSymbolPathIsNotDoubleDecoded(t *testing.T) {
	e := newStockEnv(t)
	e.addStock("A%41", "Literal Percent")
	e.addStock("AA", "Double Decoded")
	b := decodeProfile(t, e.get("/api/v1/stocks/A%2541"))
	if b.Data.Symbol != "A%41" {
		t.Fatalf("symbol = %q, want A%%41", b.Data.Symbol)
	}
	if r := e.get("/api/v1/stocks/M%26M"); r.Code != 404 { // decoded once to M&M (not present)
		t.Fatalf("M%%26M -> %d", r.Code)
	}
}

// API-94: /prices and /indicators need a session.
func TestPricesRequireSession(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	for _, p := range []string{"/stocks/TCS/prices", "/stocks/TCS/indicators"} {
		if r := e.do(http.MethodGet, "/api/v1"+p, "", "", nil); r.Code != http.StatusUnauthorized {
			t.Errorf("%s without a session -> %d", p, r.Code)
		}
	}
}

// API-95 (API-04 LTTB branch): 41 years of weekdays give more than 2,000 weekly candles, so the response
// must be thinned with LTTB and still keep the first and last candle, under the size budget.
func TestPricesMaxRangeBudgetLTTB(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("OLD", "Very Old Ltd")
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        SELECT i.id, d::date, 100 + (n % 50) + 0.1234, 103 + (n % 50), 98 + (n % 50), 101 + (n % 50) + 0.4321,
	               101 + (n % 50) + 0.4321, 1000000 + n, 'import'
	        FROM instrument i,
	             (SELECT d, row_number() OVER (ORDER BY d) AS n
	              FROM generate_series('1985-01-01'::date, '2026-10-02'::date, '1 day') d
	              WHERE extract(isodow FROM d) < 6) s(d, n)
	        WHERE i.symbol = 'OLD'`)
	r := e.get("/api/v1/stocks/OLD/prices?range=MAX")
	var b pricesBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || len(b.Data.Bars) != 2000 || b.Meta["interval"] != "1w" {
		t.Fatalf("code=%d n=%d interval=%v", r.Code, len(b.Data.Bars), b.Meta["interval"])
	}
	if first := b.Data.Bars[0][0]; first != "1985-01-04" {
		t.Errorf("first candle %v", first)
	}
	if last := b.Data.Bars[len(b.Data.Bars)-1][0]; last != "2026-10-02" {
		t.Errorf("last candle %v", last)
	}
	var zb bytes.Buffer
	zw := gzip.NewWriter(&zb)
	_, _ = zw.Write(r.Body.Bytes())
	_ = zw.Close()
	if zb.Len() >= 150*1024 {
		t.Fatalf("gz %d B", zb.Len())
	}
}

// MF-98: a text filter with a NUL byte or invalid UTF-8 is a 422, never a 500.
func TestMFParamsRejectNulAndInvalidUTF8(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	for _, q := range []string{"?q=%00", "?q=al%00pha", "?q=%ff", "?category=%00", "?fund_house=%00", "?fund_house=%c3%28"} {
		r := e.get("/api/v1/mf/schemes" + q)
		if r.Code != 422 {
			t.Errorf("%s -> %d %s", q, r.Code, r.Body.String())
		}
		if code, _ := reviewErr(t, r); code != "UNPROCESSABLE" {
			t.Errorf("%s code %q", q, code)
		}
	}
}

// MF-97: latest_nav and last_nav_date in search come from the same source, so an older NAV is
// never shown under a newer date between a NAV refresh and the cache recompute.
func TestMFSearchNavDateMatchesNav(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2026-10-01", "2026-10-19", 10, 0.1) // NAV refresh: mf_scheme.last_nav_date = 2026-10-19
	// the cache was computed on 2026-10-10 (NAV 10.9) and has not been recomputed yet
	e.exec(`INSERT INTO mf_return_cache (scheme_code, as_of, metrics) VALUES (100001, '2026-10-10',
	        '{"end_date":"2026-10-10","end_nav":10.9,"returns":{"1y":null}}'::jsonb)`)
	sd, r := e.search("?q=alpha&group=false")
	if r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	var raw struct {
		Items []struct {
			Code        int32    `json:"code"`
			LatestNav   *float64 `json:"latest_nav"`
			LastNavDate *string  `json:"last_nav_date"`
		} `json:"items"`
	}
	dataInto(t, decodeMF(t, r), &raw)
	_ = sd
	found := false
	for _, it := range raw.Items {
		if it.Code != 100001 {
			continue
		}
		found = true
		if it.LatestNav == nil || *it.LatestNav != 10.9 || it.LastNavDate == nil || *it.LastNavDate != "2026-10-10" {
			t.Fatalf("nav=%v date=%v: the NAV and its date must come from one source", it.LatestNav, it.LastNavDate)
		}
	}
	if !found {
		t.Fatalf("scheme missing: %s", r.Body.String())
	}
	// A scheme without a cache keeps the scheme's own last NAV date and a null NAV.
	e.navs(100003, "2026-10-01", "2026-10-15", 20, 0.1)
	r = e.get("/api/v1/mf/schemes?q=regular&plan=regular&option=growth")
	dataInto(t, decodeMF(t, r), &raw)
	if len(raw.Items) != 1 || raw.Items[0].LatestNav != nil || raw.Items[0].LastNavDate == nil || *raw.Items[0].LastNavDate != "2026-10-15" {
		t.Fatalf("no cache: %+v", raw.Items)
	}
}

// MF-99: search meta.as_of is the newest NAV date on the page (now only when there is none).
func TestMFSearchMetaAsOfIsDataDate(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2026-10-01", "2026-10-19", 10, 0.1)
	b := decodeMF(t, e.get("/api/v1/mf/schemes?q=alpha"))
	if b.Meta["as_of"] != "2026-10-19T00:00:00Z" || b.Meta["stale"] != false {
		t.Fatalf("meta = %v", b.Meta)
	}
	e.exec(`UPDATE mf_scheme SET last_nav_date = NULL`)
	b = decodeMF(t, e.get("/api/v1/mf/schemes?q=alpha"))
	if b.Meta["as_of"] != "2026-10-20T12:00:00Z" {
		t.Fatalf("no data as-of should fall back to now: %v", b.Meta)
	}
}

// MF-100: a scheme with no NAV rows answers with null returns and a reason for
// every key, not an empty object.
func TestMFDetailNoNavHasNullReturnsWithReasons(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	var d detailData
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100001")), &d)
	for _, k := range []string{"r_1m", "r_3m", "r_6m", "r_ytd", "r_1y", "r_3y", "r_5y", "r_since"} {
		v, present := d.Returns[k]
		if !present || v != nil || d.ReturnReason[k] != "no_nav_yet" {
			t.Errorf("%s = %v (present=%v) reason=%q", k, v, present, d.ReturnReason[k])
		}
	}
}

// MF-101: cache pass-through (rolling 1Y, MF-02 jumps): rolling_1y and nav_jumps from mf_return_cache reach the response
// unchanged (min/median/max/pct_positive/count; jumps with date and change_pct).
func TestMFDetailPassesRollingAndJumpsThrough(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2025-01-01", "2026-10-19", 10, 0.01)
	e.exec(`INSERT INTO mf_return_cache (scheme_code, as_of, metrics) VALUES (100001, '2026-10-19', $1::jsonb)`,
		`{"end_date":"2026-10-19","end_nav":13.0,"first_nav_date":"2025-01-01",
		  "returns":{"1m":2.5,"3m":6.1,"6m":9.0,"ytd":8.0,"1y":14.2,"3y":null,"5y":null,"since":9.9},
		  "volatility":11.5,"volatility_years":1.8,"max_drawdown":-7.5,"sharpe_like":0.8,"risk_free_rate":6.5,
		  "rolling_1y":{"min":-3.2,"median":12.1,"max":31.4,"pct_positive":82.5,"count":240},
		  "nav_jumps":[{"date":"2026-03-02","change_pct":27.5}]}`)
	var d struct {
		Rolling map[string]float64 `json:"rolling_1y"`
		Jumps   []struct {
			Date      string  `json:"date"`
			ChangePct float64 `json:"change_pct"`
		} `json:"nav_jumps"`
	}
	dataInto(t, decodeMF(t, e.get("/api/v1/mf/schemes/100001")), &d)
	if d.Rolling["min"] != -3.2 || d.Rolling["median"] != 12.1 || d.Rolling["max"] != 31.4 ||
		d.Rolling["pct_positive"] != 82.5 || d.Rolling["count"] != 240 {
		t.Fatalf("rolling_1y = %v", d.Rolling)
	}
	if len(d.Jumps) != 1 || d.Jumps[0].Date != "2026-03-02" || d.Jumps[0].ChangePct != 27.5 {
		t.Fatalf("nav_jumps = %+v", d.Jumps)
	}
}

// MF-102: a compare without a shared NAV date is UNPROCESSABLE with a reason.
func TestMFCompareNoCommonDatesUsesDocumentedCode(t *testing.T) {
	e := newMFEnv(t)
	seedVariants(e)
	e.navs(100001, "2026-10-01", "2026-10-05", 10, 0.1)
	e.navs(100003, "2026-10-10", "2026-10-15", 20, 0.1)
	r := e.get("/api/v1/mf/compare?codes=100001,100003&range=MAX")
	code, details := reviewErr(t, r)
	if r.Code != 422 || code != "UNPROCESSABLE" || details["reason"] != "no_common_dates" {
		t.Fatalf("%d %s %v", r.Code, code, details)
	}
}

// FND-90: derived, ratios and valuation carry the snapshot's as-of, and a snapshot older than the
// newest entered value raises DERIVED_STALE.
func TestFundamentalsDerivedAsOfAndStaleWarning(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("DRV", "Derived Co")
	e.fund("DRV", "consolidated", "Q", "2026-06-30", "pnl.revenue", 100, "manual")
	snap := `{"fundamentals":{"consolidated":{"Q":{"periods":["2026-06-30"],"derived":{},"ratios":{"roe":12.5}}}}}`
	e.exec(`INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version)
	        SELECT id, '2026-01-05', $1::jsonb, '{}', 'v1' FROM instrument WHERE symbol='DRV'`, snap)
	b, code := e.getEnv("/api/v1/stocks/DRV/fundamentals")
	if code != 200 || b.Data["derived_as_of"] != "2026-01-05" {
		t.Fatalf("%d derived_as_of=%v", code, b.Data["derived_as_of"])
	}
	stale := false
	for _, w := range b.Warnings {
		stale = stale || w.Code == "DERIVED_STALE"
	}
	if !stale {
		t.Fatalf("expected DERIVED_STALE, got %+v", b.Warnings)
	}
	// A snapshot computed after the entry is fresh.
	e.exec(`UPDATE analysis_snapshot SET as_of = (now() AT TIME ZONE 'Asia/Kolkata')::date + 1`)
	b, _ = e.getEnv("/api/v1/stocks/DRV/fundamentals")
	for _, w := range b.Warnings {
		if w.Code == "DERIVED_STALE" {
			t.Fatalf("fresh snapshot flagged stale")
		}
	}
	// No snapshot: null as-of.
	e.addStock("NOSNAP", "No Snapshot Co")
	e.fund("NOSNAP", "consolidated", "Q", "2026-06-30", "pnl.revenue", 100, "manual")
	b, _ = e.getEnv("/api/v1/stocks/NOSNAP/fundamentals")
	if b.Data["derived_as_of"] != nil {
		t.Fatalf("derived_as_of = %v", b.Data["derived_as_of"])
	}
}

// FND-91: a metric whose periods come from different sources is flagged.
func TestFundamentalsMixedSourcesWarning(t *testing.T) {
	e := newOwnerEnv(t)
	e.addStock("MIX", "Mixed Source Co")
	e.fund("MIX", "consolidated", "Q", "2026-03-31", "pnl.revenue", 90, "csv_import")
	e.fund("MIX", "consolidated", "Q", "2026-06-30", "pnl.revenue", 100, "manual")
	b, _ := e.getEnv("/api/v1/stocks/MIX/fundamentals")
	found := false
	for _, w := range b.Warnings {
		found = found || w.Code == "MIXED_SOURCES"
	}
	if !found {
		t.Fatalf("warnings = %+v", b.Warnings)
	}
}
