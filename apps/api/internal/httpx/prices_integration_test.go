package httpx

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/instruments"
	"github.com/india-analyzer/api/internal/prices"
)

func newPriceEnv(t *testing.T) *stockEnv {
	t.Helper()
	e := newStockEnv(t)
	inst := instruments.New(e.pool)
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Stocks: inst, Prices: prices.New(e.pool, inst)})
	return e
}

type pricesBody struct {
	Data struct {
		Bars           [][]any          `json:"bars"`
		Adjusted       bool             `json:"adjusted"`
		Actions        []map[string]any `json:"actions"`
		LimitedHistory bool             `json:"limited_history"`
		Depth          struct {
			FirstBar string `json:"first_bar"`
			LastBar  string `json:"last_bar"`
			Bars     int    `json:"bars"`
		} `json:"depth"`
		RedirectSymbol string `json:"redirect_symbol"`
	} `json:"data"`
	Meta     map[string]any   `json:"meta"`
	Warnings []map[string]any `json:"warnings"`
	Error    struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (e *stockEnv) prices(path string) (pricesBody, int) {
	e.t.Helper()
	r := e.get(path)
	var b pricesBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		e.t.Fatalf("decode: %v: %s", err, r.Body.String())
	}
	return b, r.Code
}

func (e *stockEnv) addBarFull(symbol, date string, o, h, l, c, adj float64, suspect bool) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, suspect)
	        SELECT id, $2::date, $3, $4, $5, $6, $7, 100, 'import', $8 FROM instrument WHERE symbol = $1`,
		symbol, date, o, h, l, c, adj, suspect)
}

// API-05: empty DB is DATA_UNAVAILABLE (404), never a 500; unknown symbol is NOT_FOUND.
func TestPricesEmptyIsDataUnavailable(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	for _, path := range []string{"/api/v1/stocks/TCS/prices", "/api/v1/stocks/TCS/indicators"} {
		b, code := e.prices(path)
		if code != 404 || b.Error.Code != "DATA_UNAVAILABLE" || b.Error.Details["reason"] != "no_prices_imported" {
			t.Fatalf("%s: %d %+v", path, code, b.Error)
		}
	}
	if b, code := e.prices("/api/v1/stocks/NOPE/prices"); code != 404 || b.Error.Code != "NOT_FOUND" {
		t.Fatalf("unknown: %d %+v", code, b.Error)
	}
}

// BRK-08: suspect rows are never returned, and an adjusted request scales OHLC by adj_close/close.
func TestPricesSuspectExcludedAndAdjusted(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	e.addBarFull("TCS", "2026-10-05", 200, 220, 190, 210, 105, false) // factor 0.5
	e.addBarFull("TCS", "2026-10-06", 5000, 9000, 1, 7000, 7000, true)
	e.addBarFull("TCS", "2026-10-07", 100, 110, 90, 100, 100, false)

	b, code := e.prices("/api/v1/stocks/TCS/prices")
	if code != 200 || len(b.Data.Bars) != 2 || !b.Data.Adjusted {
		t.Fatalf("%d bars=%v", code, b.Data.Bars)
	}
	first := b.Data.Bars[0] // [date, o, h, l, c, v]
	if first[0] != "2026-10-05" || first[1] != 100.0 || first[2] != 110.0 || first[3] != 95.0 || first[4] != 105.0 {
		t.Fatalf("adjusted bar %v", first)
	}
	if b.Meta["interval"] != "1d" || b.Meta["source"] != "import" || b.Meta["as_of"] == nil {
		t.Fatalf("meta %v", b.Meta)
	}
	if b.Data.Depth.Bars != 2 || b.Data.Depth.LastBar != "2026-10-07" {
		t.Fatalf("depth %+v", b.Data.Depth)
	}

	b, _ = e.prices("/api/v1/stocks/tcs/prices?adjusted=false")
	if b.Data.Adjusted || b.Data.Bars[0][4] != 210.0 || b.Data.Bars[0][1] != 200.0 {
		t.Fatalf("raw bar %v", b.Data.Bars[0])
	}
}

// Confirmed split is a marker; a detected one is only an UNCONFIRMED_ACTION warning.
func TestPricesActionsAndUnconfirmedWarning(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	e.addBarFull("TCS", "2026-10-05", 100, 110, 90, 100, 100, false)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, source)
	        SELECT id, '2026-09-12', 'split', 'confirmed', 10, 2, 'manual' FROM instrument WHERE symbol='TCS'`)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
	        SELECT id, '2026-09-20', 'split_or_bonus', 'detected', 'detected' FROM instrument WHERE symbol='TCS'`)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
	        SELECT id, '2026-09-21', 'bonus', 'rejected', 'manual' FROM instrument WHERE symbol='TCS'`)
	b, _ := e.prices("/api/v1/stocks/TCS/prices")
	if len(b.Data.Actions) != 1 || b.Data.Actions[0]["date"] != "2026-09-12" ||
		b.Data.Actions[0]["type"] != "split" || b.Data.Actions[0]["label"] != "10:2 split" {
		t.Fatalf("actions %v", b.Data.Actions)
	}
	if len(b.Warnings) != 1 || b.Warnings[0]["code"] != "UNCONFIRMED_ACTION" ||
		b.Warnings[0]["message"] != "Possible split or bonus on 2026-09-20 not yet confirmed" {
		t.Fatalf("warnings %v", b.Warnings)
	}
}

// API-04: MAX range returns <= 2,000 points and < 150 kB gz.
func TestPricesMaxRangeBudget(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        SELECT i.id, d::date, 100 + (n % 50) + 0.1234, 103 + (n % 50), 98 + (n % 50), 101 + (n % 50) + 0.4321,
	               101 + (n % 50) + 0.4321, 1000000 + n, 'import'
	        FROM instrument i,
	             (SELECT d, row_number() OVER (ORDER BY d) AS n
	              FROM generate_series('2000-01-03'::date, '2026-10-02'::date, '1 day') d
	              WHERE extract(isodow FROM d) < 6) s(d, n)
	        WHERE i.symbol = 'TCS'`)
	r := e.get("/api/v1/stocks/TCS/prices?range=MAX")
	var b pricesBody
	if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || len(b.Data.Bars) == 0 || len(b.Data.Bars) > 2000 || b.Meta["interval"] != "1w" {
		t.Fatalf("code=%d n=%d interval=%v", r.Code, len(b.Data.Bars), b.Meta["interval"])
	}
	var zb bytes.Buffer
	zw := gzip.NewWriter(&zb)
	_, _ = zw.Write(r.Body.Bytes())
	_ = zw.Close()
	if zb.Len() >= 150*1024 {
		t.Fatalf("gz %d B", zb.Len())
	}
	t.Logf("MAX: %d points, raw %d B, gz %d B", len(b.Data.Bars), r.Body.Len(), zb.Len())
	// last candle keeps the real last bar date
	if last := b.Data.Bars[len(b.Data.Bars)-1][0]; last != "2026-10-02" {
		t.Fatalf("last candle %v", last)
	}
}

// BRK-06: history shorter than expected: limited_history true and the depth is stated.
func TestPricesLimitedHistory(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("NEW", "Newly Imported")
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, source)
	        SELECT id, (current_date - 30), 10, 11, 9, 10, 10, 'import' FROM instrument WHERE symbol='NEW'`)
	b, code := e.prices("/api/v1/stocks/NEW/prices?range=MAX")
	if code != 200 || !b.Data.LimitedHistory || b.Data.Depth.Bars != 1 {
		t.Fatalf("%d %+v", code, b.Data)
	}
}

func TestPricesValidationAndAlias(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	e.addBar("TCS", "2026-10-05")
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol) SELECT id, 'OLDTCS' FROM instrument WHERE symbol='TCS'`)
	if _, code := e.prices("/api/v1/stocks/TCS/prices?range=2Y"); code != 422 {
		t.Fatalf("range: %d", code)
	}
	if _, code := e.prices("/api/v1/stocks/TCS/prices?adjusted=maybe"); code != 422 {
		t.Fatalf("adjusted: %d", code)
	}
	for _, p := range []string{"prices", "indicators"} {
		b, code := e.prices("/api/v1/stocks/OLDTCS/" + p)
		if code != 200 || b.Data.RedirectSymbol != "TCS" {
			t.Fatalf("%s alias: %d %+v", p, code, b.Data)
		}
	}
}

const snapshotIndicators = `{"version":"d05a-1","as_of":"2026-10-07","bars":70,"last_close":100,
 "returns":{"trading":{"ret_1m":1.5}},"technicals":{"rsi14":55},"null_reasons":{},"warnings":[],"units":{"ret_*":"percent"},
 "series":{"format":"columnar","dates":["2026-10-06","2026-10-07"],"sma50":[null,99.5],
   "macd":{"macd":[0.1,0.2],"signal":[null,0.3],"hist":[null,null]}},
 "analysis":{"format":"columnar","drawdown":[0,-1],"return_histogram":{"edges":[0],"counts":[1],"n":1}}}`

func TestIndicatorsSnapshotExpandedToPairs(t *testing.T) {
	e := newPriceEnv(t)
	e.addStock("TCS", "Tata Consultancy")
	e.addBar("TCS", "2026-10-07")
	// bars exist but no snapshot yet
	if b, code := e.prices("/api/v1/stocks/TCS/indicators"); code != 404 || b.Error.Details["reason"] != "no_history" {
		t.Fatalf("no snapshot: %d %+v", code, b.Error)
	}
	e.exec(`INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version)
	        SELECT id, '2026-10-07', $1::jsonb, '{"trend":{"score":62}}'::jsonb, 'd05a-1' FROM instrument WHERE symbol='TCS'`,
		snapshotIndicators)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
	        SELECT id, '2026-09-20', 'split_or_bonus', 'detected', 'detected' FROM instrument WHERE symbol='TCS'`)
	r := e.get("/api/v1/stocks/TCS/indicators")
	var out struct {
		Data     map[string]any   `json:"data"`
		Meta     map[string]any   `json:"meta"`
		Warnings []map[string]any `json:"warnings"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil || r.Code != 200 {
		t.Fatalf("%d %v %s", r.Code, err, r.Body.String())
	}
	s := out.Data["series"].(map[string]any)
	if got := fmt.Sprint(s["sma50"]); got != "[[2026-10-06 <nil>] [2026-10-07 99.5]]" {
		t.Fatalf("sma50 %s", got)
	}
	if _, ok := s["dates"]; ok {
		t.Fatal("dates leaked")
	}
	if out.Data["scores"].(map[string]any)["trend"] == nil || out.Data["returns"] == nil || out.Data["technicals"] == nil {
		t.Fatalf("data %v", out.Data)
	}
	if out.Meta["source"] != "import" || len(out.Warnings) != 1 || out.Warnings[0]["code"] != "UNCONFIRMED_ACTION" {
		t.Fatalf("meta/warnings %v %v", out.Meta, out.Warnings)
	}
}
