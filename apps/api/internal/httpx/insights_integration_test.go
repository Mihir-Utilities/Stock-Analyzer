package httpx

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/admin"
	"github.com/india-analyzer/api/internal/market"
	"github.com/india-analyzer/api/internal/predict"
)

// Pinned clock: Tuesday 2026-10-20 17:30 IST. The expected last trading date is Monday 2026-10-19
// (before the 18:00 IST end-of-day cutoff). No test reads the wall clock.
var insNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

type insEnv struct{ *stockEnv }

func newInsEnv(t *testing.T) *insEnv {
	t.Helper()
	e := newAuthEnv(t)
	p := predict.New(e.pool)
	p.Now = func() time.Time { return insNow }
	m := market.New(e.pool)
	m.Now = func() time.Time { return insNow }
	a := admin.New(e.pool, 380, "abc1234")
	a.Now = func() time.Time { return insNow }
	e.h = NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Predict: p, Market: m, Admin: a})
	return &insEnv{&stockEnv{authEnv: e, cookie: e.login(ownerPassword)}}
}

// stock adds a tracked active equity (the worker predicts it).
func (e *insEnv) stock(symbol, name string) {
	e.t.Helper()
	e.addStock(symbol, name)
	e.exec(`UPDATE instrument SET is_tracked = true, tracked_reason = 'imported' WHERE symbol = $1`, symbol)
}

func (e *insEnv) getJSON(path string) (int, map[string]any) {
	e.t.Helper()
	r := e.get(path)
	var m map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &m); err != nil {
		e.t.Fatalf("decode %s: %v: %s", path, err, r.Body.String())
	}
	return r.Code, m
}

func (e *insEnv) data(path string) map[string]any {
	e.t.Helper()
	code, m := e.getJSON(path)
	if code != 200 {
		e.t.Fatalf("%s: %d %v", path, code, m)
	}
	return m["data"].(map[string]any)
}

// run inserts a model run and returns its id.
func (e *insEnv) run(name, status string, pass bool, valid, baseline string) int64 {
	e.t.Helper()
	var id int64
	err := e.pool.QueryRow(context.Background(), `INSERT INTO model_run (model_name, trained_at, train_start, train_end, n_rows,
		valid_metrics, baseline_metrics, guardrail_pass, status) VALUES ($1, '2026-10-04T10:00:00Z', '2020-01-01', '2026-09-30', 1000,
		$2::jsonb, $3::jsonb, $4, $5) RETURNING id`, name, valid, baseline, pass, status).Scan(&id)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

const goodValid = `{"guardrail":{"passed":true,"reason":null,"summary":{"folds":12,"auc_mean":0.536,"brier_mean":0.2491}}}`
const goodBase = `{"b1_brier_mean":0.2503}`

func (e *insEnv) pred(symbol string, h int, run int64, asOf string, p, q10, q50, q90 any, shown bool, reason any) int64 {
	e.t.Helper()
	var id int64
	err := e.pool.QueryRow(context.Background(), `INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, ret_q10, ret_q50, ret_q90,
		ref_close, shown, hidden_reason) SELECT id, $2::date, $3, $4, $5::real, $6::real, $7::real, $8::real, 3500, $9, $10::text
		FROM instrument WHERE symbol = $1 RETURNING id`, symbol, asOf, h, run, p, q10, q50, q90, shown, reason).Scan(&id)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

func hz(d map[string]any, days int) map[string]any {
	for _, x := range d["horizons"].([]any) {
		m := x.(map[string]any)
		if int(m["days"].(float64)) == days {
			return m
		}
	}
	return nil
}

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

// forbidden keys: a single target price must not exist anywhere in a prediction response.
func assertNoTargetPrice(t *testing.T, v any) {
	t.Helper()
	var walk func(any)
	walk = func(x any) {
		switch y := x.(type) {
		case map[string]any:
			for k, c := range y {
				lk := strings.ToLower(k)
				if strings.Contains(lk, "target") || lk == "price" || lk == "fair_value" || lk == "expected_price" {
					t.Fatalf("single price key %q in prediction response", k)
				}
				walk(c)
			}
		case []any:
			for _, c := range y {
				walk(c)
			}
		}
	}
	walk(v)
}

// PRD-01 (ML-04): no model and fewer than 20 eligible stocks -> insufficient_universe, every horizon
// hidden with no_model, no number anywhere, experimental flag and disclaimer present.
func TestPredictionInsufficientUniverse(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata Consultancy")
	e.exec(`INSERT INTO ingestion_run (job, started_at, finished_at, status, details)
	        VALUES ('train_models', '2026-10-17T05:00:00Z', '2026-10-17T05:01:00Z', 'ok', '{"status":"insufficient_universe","eligible":3}')`)
	d := e.data("/api/v1/stocks/TCS/prediction")
	if d["experimental"] != true || d["disclaimer"] == "" {
		t.Fatalf("experimental flag/disclaimer missing: %v", d)
	}
	if d["state"] != "insufficient_universe" || d["state_reason"] == nil {
		t.Fatalf("state = %v", d["state"])
	}
	for _, days := range []int{5, 21} {
		h := hz(d, days)
		if h == nil || h["shown"] != false || h["hidden_reason"] != "no_model" {
			t.Fatalf("horizon %d = %v", days, h)
		}
		for _, k := range []string{"p_up", "bucket", "band"} {
			if _, ok := h[k]; ok {
				t.Fatalf("hidden horizon carries %s", k)
			}
		}
	}
	if d["model"] != nil || d["track_record"] != nil || d["ref_close"] != nil || d["as_of"] != nil {
		t.Fatalf("numbers without a model: %v", d)
	}
	if d["ref_close_reason"] == nil {
		t.Fatal("null ref_close needs a reason")
	}
	assertNoTargetPrice(t, d)
}

// PRD-01b: without any train run the state is plain no_model.
func TestPredictionNoModelState(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata Consultancy")
	d := e.data("/api/v1/stocks/TCS/prediction")
	if d["state"] != "no_model" || hz(d, 5)["hidden_reason"] != "no_model" {
		t.Fatalf("%v", d)
	}
	if d["trend"].(map[string]any)["score"] != nil || d["trend"].(map[string]any)["reason"] == nil {
		t.Fatalf("trend without analysis must be null with a reason: %v", d["trend"])
	}
}

// PRD-02 (ML-05): a failing guardrail hides the horizon with the enum reason; a run that failed for
// lack of folds reports insufficient_history; a live-gated active model hides stored shown rows.
func TestPredictionGuardrailFails(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata Consultancy")
	e.run("dir_5d", "candidate", false, `{"guardrail":{"passed":false,"reason":"auc_mean","summary":{}}}`, `{}`)
	e.run("dir_21d", "candidate", false, `{"guardrail":{"passed":false,"reason":"insufficient_folds","summary":{}}}`, `{}`)
	d := e.data("/api/v1/stocks/TCS/prediction")
	if hz(d, 5)["hidden_reason"] != "model_not_better_than_baseline" || hz(d, 5)["shown"] != false {
		t.Fatalf("5d = %v", hz(d, 5))
	}
	if hz(d, 21)["hidden_reason"] != "insufficient_history" {
		t.Fatalf("21d = %v", hz(d, 21))
	}
	if d["state"] != "guardrail_failed" {
		t.Fatalf("state = %v", d["state"])
	}

	// Live gate (ML-07 side): an active run switched off after its rows were stored.
	run := e.run("dir_5d", "active", false, goodValid, goodBase)
	e.pred("TCS", 5, run, "2026-10-19", 0.54, -0.04, 0.0, 0.05, true, nil)
	h := hz(e.data("/api/v1/stocks/TCS/prediction"), 5)
	if h["shown"] != false || h["hidden_reason"] != "model_not_better_than_baseline" {
		t.Fatalf("gated horizon = %v", h)
	}
	if _, ok := h["p_up"]; ok {
		t.Fatal("gated horizon leaks p_up")
	}
	if h["model"] == nil || h["track_record"] == nil {
		t.Fatal("the model card stays visible while gated")
	}
}

// PRD-03 (ML-06): stock-level hidden reasons stored by the worker are surfaced with the enum value
// and never with numbers; stale data is also detected at read time (more than 3 trading days).
func TestPredictionHiddenReasons(t *testing.T) {
	e := newInsEnv(t)
	run := e.run("dir_5d", "active", true, goodValid, goodBase)
	for sym, reason := range map[string]string{
		"ILLIQ": "low_liquidity", "ACTN": "near_corporate_action", "NEWCO": "insufficient_history", "OLD": "stale_data",
	} {
		e.stock(sym, sym+" Ltd")
		e.pred(sym, 5, run, "2026-10-19", nil, nil, nil, nil, false, reason)
	}
	for sym, reason := range map[string]string{
		"ILLIQ": "low_liquidity", "ACTN": "near_corporate_action", "NEWCO": "insufficient_history", "OLD": "stale_data",
	} {
		h := hz(e.data("/api/v1/stocks/"+sym+"/prediction"), 5)
		if h["shown"] != false || h["hidden_reason"] != reason {
			t.Fatalf("%s: %v", sym, h)
		}
		if _, ok := h["p_up"]; ok {
			t.Fatalf("%s leaks p_up", sym)
		}
	}
	// A row stored as shown but older than 3 trading days at read time is hidden as stale_data.
	e.stock("AGED", "Aged Ltd")
	e.pred("AGED", 5, run, "2026-10-09", 0.55, -0.04, 0.0, 0.05, true, nil)
	if h := hz(e.data("/api/v1/stocks/AGED/prediction"), 5); h["shown"] != false || h["hidden_reason"] != "stale_data" {
		t.Fatalf("aged = %v", h)
	}
	// An unknown reason text never reaches the client.
	e.stock("ODD", "Odd Ltd")
	e.pred("ODD", 5, run, "2026-10-19", nil, nil, nil, nil, false, "something_else")
	if h := hz(e.data("/api/v1/stocks/ODD/prediction"), 5); h["hidden_reason"] != "model_not_better_than_baseline" {
		t.Fatalf("odd = %v", h)
	}
	// An active model but no stored row for the stock.
	e.stock("BARE", "Bare Ltd")
	if h := hz(e.data("/api/v1/stocks/BARE/prediction"), 5); h["hidden_reason"] != "awaiting_predictions" {
		t.Fatalf("bare = %v", h)
	}
	// The other horizon has no model at all.
	if h := hz(e.data("/api/v1/stocks/BARE/prediction"), 21); h["hidden_reason"] != "no_model" {
		t.Fatalf("21d = %v", h)
	}
}

// PRD-04: a shown horizon carries bucket, fractions, price levels, model card and live track record;
// there is no single target price.
func TestPredictionShown(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata Consultancy")
	run := e.run("dir_5d", "active", true, goodValid, goodBase)
	cur := e.pred("TCS", 5, run, "2026-10-19", 0.54, -0.041, 0.002, 0.046, true, nil)
	_ = cur
	// Resolved live record: 3 resolved (2 direction hits, 2 in band) and 1 open.
	type oc struct {
		asOf        string
		dir, inBand bool
	}
	for _, o := range []oc{{"2026-04-01", true, true}, {"2026-04-08", true, false}, {"2026-04-15", false, true}} {
		id := e.pred("TCS", 5, run, o.asOf, 0.6, -0.04, 0.01, 0.05, true, nil)
		e.exec(`INSERT INTO prediction_outcome (prediction_id, resolved_on, realized_return, direction_correct, in_band)
		        VALUES ($1, '2026-10-01', 0.01, $2, $3)`, id, o.dir, o.inBand)
	}
	e.exec(`INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version)
	        SELECT id, '2026-10-19', '{}', '{"trend":{"score":72,"label":"up"},"risk":{"score":41,"label":"medium"}}', 'v1' FROM instrument WHERE symbol='TCS'`)

	d := e.data("/api/v1/stocks/TCS/prediction")
	if d["state"] != "ok" || d["as_of"] != "2026-10-19" || d["ref_close"].(float64) != 3500 {
		t.Fatalf("head = %v", d)
	}
	h := hz(d, 5)
	if h["shown"] != true || h["hidden_reason"] != nil || h["bucket"] != "slightly_up" || !approx(h["p_up"].(float64), 0.54) {
		t.Fatalf("5d = %v", h)
	}
	b := h["band"].(map[string]any)
	if !approx(b["q10"].(float64), -0.041) || !approx(b["q50"].(float64), 0.002) || !approx(b["q90"].(float64), 0.046) {
		t.Fatalf("band = %v", b)
	}
	if !approx(b["price_q10"].(float64), 3356.5) || !approx(b["price_q50"].(float64), 3507) || !approx(b["price_q90"].(float64), 3661) {
		t.Fatalf("band prices = %v", b)
	}
	m := h["model"].(map[string]any)
	if m["version"] != "dir_5d@2026-10-04" || !approx(m["oos_auc"].(float64), 0.536) || !approx(m["oos_brier"].(float64), 0.2491) ||
		!approx(m["baseline_brier"].(float64), 0.2503) || m["folds"].(float64) != 12 {
		t.Fatalf("model = %v", m)
	}
	tr := h["track_record"].(map[string]any)
	if tr["resolved"].(float64) != 3 || !approx(tr["direction_hit_rate"].(float64), 2.0/3) || !approx(tr["band_coverage_80"].(float64), 2.0/3) || tr["since"] != "2026-04-01" {
		t.Fatalf("track record = %v", tr)
	}
	if d["model"] == nil || d["track_record"] == nil {
		t.Fatal("top-level model card and track record mirror the first horizon with a model")
	}
	tr2 := d["trend"].(map[string]any)
	if tr2["score"].(float64) != 72 || tr2["label"] != "up" || d["risk"].(map[string]any)["label"] != "medium" {
		t.Fatalf("scores = %v", d)
	}
	if hz(d, 21)["hidden_reason"] != "no_model" {
		t.Fatalf("21d = %v", hz(d, 21))
	}
	assertNoTargetPrice(t, d)
}

// PRD-05: alias redirect, unknown symbol 404, bad symbol 404, auth required, method rules.
func TestPredictionRoutes(t *testing.T) {
	e := newInsEnv(t)
	e.addStock("NEWSYM", "New Ltd")
	e.exec(`INSERT INTO symbol_alias (instrument_id, old_symbol, changed_on) SELECT id, 'OLDSYM', '2026-01-01' FROM instrument WHERE symbol='NEWSYM'`)
	if d := e.data("/api/v1/stocks/oldsym/prediction"); d["redirect_symbol"] != "NEWSYM" {
		t.Fatalf("alias = %v", d)
	}
	if code, m := e.getJSON("/api/v1/stocks/NOPE/prediction"); code != 404 || m["error"].(map[string]any)["code"] != "NOT_FOUND" {
		t.Fatalf("unknown = %d %v", code, m)
	}
	if code, _ := e.getJSON("/api/v1/stocks/A%00B/prediction"); code != 404 {
		t.Fatalf("nul = %d", code)
	}
	r := e.do(http.MethodGet, "/api/v1/stocks/NEWSYM/prediction", "", "", nil)
	if r.Code != 401 {
		t.Fatalf("unauthenticated = %d", r.Code)
	}
}

// MKT-01: empty database -> empty indices with a reason, null vix, no movers, never zeros.
func TestMarketOverviewEmpty(t *testing.T) {
	e := newInsEnv(t)
	d := e.data("/api/v1/market/overview")
	if len(d["indices"].([]any)) != 0 || d["indices_reason"] != "no_index_series" {
		t.Fatalf("indices = %v", d)
	}
	if d["vix"] != nil || d["vix_reason"] != "no_index_series" {
		t.Fatalf("vix = %v", d["vix"])
	}
	mv := d["movers"].(map[string]any)
	if len(mv["gainers"].([]any)) != 0 || len(mv["losers"].([]any)) != 0 || d["movers_reason"] != "no_prices_imported" {
		t.Fatalf("movers = %v", d)
	}
	ms := d["market_status"].(map[string]any)
	if ms["is_open"] != false || ms["next_open"] != "2026-10-21T03:45:00Z" || ms["holiday_list_loaded"] != false {
		t.Fatalf("status = %v", ms)
	}
}

// MKT-02: indices and VIX from market_series with change on the previous row; movers rank tracked
// stocks, apply the turnover floor, skip unconfirmed actions and suspect bars.
func TestMarketOverviewData(t *testing.T) {
	e := newInsEnv(t)
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES
		('NIFTY50','2026-10-16',24000),('NIFTY50','2026-10-19',24240),('INDIAVIX','2026-10-19',13.5)`)
	bar := func(sym, date string, close float64, vol int64) {
		e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
		        SELECT id, $2::date, $3, $3, $3, $3, $3, $4, 'import' FROM instrument WHERE symbol = $1`, sym, date, close, vol)
	}
	for _, s := range []string{"UP1", "UP2", "DN1", "THIN", "SPLIT", "FLAT", "UNTRK"} {
		e.addStock(s, s+" Ltd")
		if s != "UNTRK" {
			e.exec(`UPDATE instrument SET is_tracked = true, tracked_reason = 'imported' WHERE symbol = $1`, s)
		}
		prev, cur := 100.0, 100.0
		switch s {
		case "UP1":
			cur = 105
		case "UP2":
			cur = 102
		case "DN1":
			cur = 97
		case "THIN":
			cur = 150
		case "SPLIT":
			cur = 50
		case "UNTRK":
			cur = 200
		}
		vol := int64(1_000_000)
		if s == "THIN" {
			vol = 10 // 100*10/1e7 crore: far below the floor
		}
		bar(s, "2026-10-16", prev, vol)
		bar(s, "2026-10-19", cur, vol)
		// 58 older bars complete the 60-bar window of the 60-day average traded value.
		e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
		        SELECT i.id, d::date, $2, $2, $2, $2, $2, $3, 'import' FROM instrument i,
		        generate_series('2026-08-01'::date, '2026-08-01'::date + 57, '1 day') d WHERE i.symbol = $1`, s, prev, vol)
	}
	// A liquid stock with only the two newest bars has no 60-day average: not a mover.
	e.addStock("NEWBIE", "Newbie Ltd")
	e.exec(`UPDATE instrument SET is_tracked = true, tracked_reason = 'imported' WHERE symbol = 'NEWBIE'`)
	bar("NEWBIE", "2026-10-16", 100, 1_000_000)
	bar("NEWBIE", "2026-10-19", 190, 1_000_000)
	e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
	        SELECT id, '2026-10-19', 'split', 'detected', 'detected' FROM instrument WHERE symbol = 'SPLIT'`)

	d := e.data("/api/v1/market/overview")
	idx := d["indices"].([]any)
	if len(idx) != 1 {
		t.Fatalf("indices = %v", idx)
	}
	n := idx[0].(map[string]any)
	if n["code"] != "NIFTY50" || n["value"].(float64) != 24240 || n["change"].(float64) != 240 || !approx(n["change_pct"].(float64), 1.0) || n["as_of"] != "2026-10-19" {
		t.Fatalf("nifty = %v", n)
	}
	v := d["vix"].(map[string]any)
	if v["value"].(float64) != 13.5 || v["change"] != nil || v["change_reason"] != "no_previous_value" {
		t.Fatalf("vix = %v", v)
	}
	mv := d["movers"].(map[string]any)
	g, l := mv["gainers"].([]any), mv["losers"].([]any)
	if len(g) != 2 || g[0].(map[string]any)["symbol"] != "UP1" || g[1].(map[string]any)["symbol"] != "UP2" || !approx(g[0].(map[string]any)["change_pct"].(float64), 5) {
		t.Fatalf("gainers = %v", g)
	}
	if len(l) != 1 || l[0].(map[string]any)["symbol"] != "DN1" || !approx(l[0].(map[string]any)["change_pct"].(float64), -3) {
		t.Fatalf("losers = %v", l)
	}
	if _, ok := d["movers_reason"]; ok {
		t.Fatal("movers_reason only when empty")
	}
	if n["unit"] != "index points" || v["unit"] == "index points" {
		t.Fatalf("units: nifty %v, vix %v (the VIX is not an index level in points)", n["unit"], v["unit"])
	}
	// Meta as-of is the newest data date (never the clock) and stale comes from the calendar.
	_, m := e.getJSON("/api/v1/market/overview")
	meta := m["meta"].(map[string]any)
	if meta["as_of"] != "2026-10-19T00:00:00Z" || meta["stale"] != false {
		t.Fatalf("meta = %v", meta)
	}
}

// MKT-03: market status rule (pure).
func TestComputeStatus(t *testing.T) {
	hol := map[string]string{"2026-10-20": "Dussehra"}
	cases := []struct {
		name, now string
		open      bool
		next      string
		holiday   string
	}{
		{"open mid-day", "2026-10-21T05:00:00Z", true, "2026-10-22T03:45:00Z", ""},                    // Wed 10:30 IST
		{"before open", "2026-10-21T03:00:00Z", false, "2026-10-21T03:45:00Z", ""},                    // Wed 08:30 IST
		{"at open", "2026-10-21T03:45:00Z", true, "2026-10-22T03:45:00Z", ""},                         // 09:15 IST
		{"at close", "2026-10-21T10:00:00Z", false, "2026-10-22T03:45:00Z", ""},                       // 15:30 IST closed
		{"holiday", "2026-10-20T05:00:00Z", false, "2026-10-21T03:45:00Z", "Dussehra"},                // Tue holiday
		{"friday evening", "2026-10-23T12:00:00Z", false, "2026-10-26T03:45:00Z", ""},                 // -> Monday
		{"saturday", "2026-10-24T05:00:00Z", false, "2026-10-26T03:45:00Z", ""},                       // weekend
		{"IST date differs from UTC date", "2026-10-20T19:00:00Z", false, "2026-10-21T03:45:00Z", ""}, // Wed 00:30 IST
	}
	for _, c := range cases {
		now, _ := time.Parse(time.RFC3339, c.now)
		st := market.ComputeStatus(now, hol, true)
		got := ""
		if st.Holiday != nil {
			got = *st.Holiday
		}
		if st.IsOpen != c.open || st.NextOpen != c.next || got != c.holiday {
			t.Errorf("%s: %+v want open=%v next=%s holiday=%q", c.name, st, c.open, c.next, c.holiday)
		}
	}
}

// MKT-04: GET /market/holidays: year_loaded true/false, validation.
func TestMarketHolidays(t *testing.T) {
	e := newInsEnv(t)
	d := e.data("/api/v1/market/holidays?year=2026")
	if d["year_loaded"] != false || len(d["holidays"].([]any)) != 0 || d["note"] == nil {
		t.Fatalf("empty year = %v", d)
	}
	e.exec(`INSERT INTO market_holiday (holiday_date, segment, description, source) VALUES
		('2026-10-20','trading','Dussehra','seed'), ('2026-11-08','clearing','Diwali clearing','seed')`)
	d = e.data("/api/v1/market/holidays?year=2026")
	hs := d["holidays"].([]any)
	if d["year_loaded"] != true || len(hs) != 1 || hs[0].(map[string]any)["date"] != "2026-10-20" {
		t.Fatalf("loaded year = %v", d)
	}
	if d := e.data("/api/v1/market/holidays"); d["year"].(float64) != 2026 {
		t.Fatalf("default year = %v", d["year"])
	}
	if code, _ := e.getJSON("/api/v1/market/holidays?year=abc"); code != 422 {
		t.Fatalf("bad year = %d", code)
	}
	if d := e.data("/api/v1/market/overview"); d["market_status"].(map[string]any)["holiday"] != "Dussehra" || d["market_status"].(map[string]any)["holiday_list_loaded"] != true {
		t.Fatalf("overview status = %v", d["market_status"])
	}
}

// ADM-01 (SYS-10, SYS-14 admin part): a year with no trading-holiday row is reported on every read
// (persistent); clearing-only rows do not count; loading the list clears it.
func TestAdminHolidayMissingYears(t *testing.T) {
	e := newInsEnv(t)
	years := func() []any { return e.data("/api/v1/admin/status")["holiday_list_missing_years"].([]any) }
	if y := years(); len(y) != 1 || y[0].(float64) != 2026 {
		t.Fatalf("missing = %v", y)
	}
	if y := years(); len(y) != 1 { // persistent: reading does not clear it
		t.Fatalf("second read = %v", y)
	}
	e.exec(`INSERT INTO market_holiday (holiday_date, segment, source) VALUES ('2026-11-08','clearing','seed')`)
	if y := years(); len(y) != 1 {
		t.Fatalf("clearing-only must not count: %v", y)
	}
	// The newest imported bar's year is checked too (2025 bar, no 2025 list).
	e.addStock("TCS", "Tata")
	e.addBar("TCS", "2025-12-30")
	if y := years(); len(y) != 2 || y[0].(float64) != 2025 || y[1].(float64) != 2026 {
		t.Fatalf("with a 2025 bar = %v", y)
	}
	e.exec(`INSERT INTO market_holiday (holiday_date, segment, source) VALUES ('2026-01-26','trading','seed'), ('2025-01-26','trading','seed')`)
	if y := years(); len(y) != 0 {
		t.Fatalf("loaded lists = %v", y)
	}
}

// ADM-02: sources (no broker), latest run per job, recent errors, coverage, db block, version, policy.
func TestAdminStatus(t *testing.T) {
	e := newInsEnv(t)
	e.exec(`INSERT INTO source_health (source, checked_at, ok, latency_ms, consecutive_failures, note) VALUES
		('mfapi','2026-10-20T06:00:00Z',true,120,0,NULL),
		('amfi','2026-10-20T06:00:00Z',false,NULL,3,'timeout'),
		('broker','2026-10-20T06:00:00Z',true,10,0,'dormant')`)
	e.exec(`INSERT INTO ingestion_run (job, started_at, finished_at, status, rows_written, items_total, items_failed, error) VALUES
		('sync_mf_navs','2026-10-19T01:00:00Z','2026-10-19T01:05:00Z','failed',0,10,10,'upstream 500'),
		('sync_mf_navs','2026-10-20T01:00:00Z','2026-10-20T01:05:00Z','ok',900,10,0,NULL),
		('predict','2026-10-20T02:00:00Z','2026-10-20T02:01:00Z','partial',5,8,3,'3 symbols failed')`)
	e.addStock("TCS", "Tata")
	e.exec(`UPDATE instrument SET is_tracked = true, tracked_reason = 'imported' WHERE symbol = 'TCS'`)
	e.addBar("TCS", "2026-10-19")
	e.exec(`INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, value, source)
	        SELECT id, 'consolidated', 'Q', '2026-06-30', 'pnl.revenue', 100, 'manual' FROM instrument WHERE symbol = 'TCS'`)

	d := e.data("/api/v1/admin/status")
	src := d["sources"].([]any)
	if len(src) != 2 || src[0].(map[string]any)["source"] != "amfi" || src[1].(map[string]any)["source"] != "mfapi" {
		t.Fatalf("sources (no broker) = %v", src)
	}
	a := src[0].(map[string]any)
	if a["ok"] != false || a["consecutive_failures"].(float64) != 3 || a["note"] != "timeout" || a["latency_ms"] != nil || a["disabled_until"] != nil {
		t.Fatalf("amfi = %v", a)
	}
	jobs := d["jobs"].([]any)
	if len(jobs) != 2 {
		t.Fatalf("one latest run per job: %v", jobs)
	}
	byJob := map[string]map[string]any{}
	for _, j := range jobs {
		byJob[j.(map[string]any)["job"].(string)] = j.(map[string]any)
	}
	if byJob["sync_mf_navs"]["status"] != "ok" || byJob["sync_mf_navs"]["rows_written"].(float64) != 900 {
		t.Fatalf("latest sync run = %v", byJob["sync_mf_navs"])
	}
	errs := d["recent_errors"].([]any)
	if len(errs) != 2 || errs[0].(map[string]any)["job"] != "predict" || errs[1].(map[string]any)["error"] != "upstream 500" {
		t.Fatalf("recent errors newest first = %v", errs)
	}
	cov := d["coverage"].(map[string]any)
	if cov["instruments"].(float64) != 1 || cov["tracked"].(float64) != 1 || cov["with_prices"].(float64) != 1 ||
		cov["with_fundamentals"].(float64) != 1 || cov["with_shareholding"].(float64) != 0 {
		t.Fatalf("coverage = %v", cov)
	}
	db := d["db"].(map[string]any)
	if db["size_mb"].(float64) <= 0 || db["limit_mb"].(float64) != 380 || db["warn_level"] != "ok" || len(db["tables"].([]any)) == 0 {
		t.Fatalf("db = %v", db)
	}
	tb := db["tables"].([]any)[0].(map[string]any)
	if tb["name"] == "" || tb["mb"] == nil {
		t.Fatalf("table = %v", tb)
	}
	if d["version"] != "abc1234" {
		t.Fatalf("version = %v", d["version"])
	}
	pol := d["storage_policy"].(map[string]any)
	if pol["price_mode"] != "manual" || pol["db_soft_limit_mb"].(float64) != 380 || pol["imported_prices_auto_deleted"] != false {
		t.Fatalf("policy = %v", pol)
	}
	if _, ok := d["broker"]; ok {
		t.Fatal("no broker session state in manual price mode")
	}
}

// ADM-03: warn level thresholds 70/85/95/limit of DB_SOFT_LIMIT_MB (SYS-02 admin part).
func TestAdminWarnLevel(t *testing.T) {
	const mb = 1 << 20
	cases := []struct {
		bytes int64
		want  string
	}{
		{0, "ok"}, {265 * mb, "ok"}, {266 * mb, "70"}, {322 * mb, "70"}, {323 * mb, "85"}, {361 * mb, "95"}, {379 * mb, "95"}, {380 * mb, "limit"}, {500 * mb, "limit"},
	}
	for _, c := range cases {
		if got := admin.WarnLevel(c.bytes, 380); got != c.want {
			t.Errorf("%d MB: %s want %s", c.bytes/mb, got, c.want)
		}
	}
	if admin.WarnLevel(1<<30, 0) != "ok" {
		t.Error("no limit configured must not warn")
	}
}

// PRD-06: bucket thresholds of docs/03 section 6.
func TestBuckets(t *testing.T) {
	cases := map[float64]string{
		0.0: "strongly_down", 0.399: "strongly_down", 0.40: "slightly_down", 0.469: "slightly_down",
		0.47: "neutral", 0.53: "neutral", 0.531: "slightly_up", 0.60: "slightly_up", 0.601: "strongly_up", 1.0: "strongly_up",
	}
	for p, want := range cases {
		if got := predict.Bucket(p); got != want {
			t.Errorf("Bucket(%v) = %s want %s", p, got, want)
		}
	}
}

// PRD-07: trading days behind (freshness rule of docs/05 10.6), no wall clock.
func TestTradingDaysBehind(t *testing.T) {
	d := func(s string) time.Time { x, _ := time.Parse(time.DateOnly, s); return x }
	// now = Tue 2026-10-20 12:00Z: expected last trading date Mon 2026-10-19.
	cases := []struct {
		asOf string
		hol  []string
		want int
	}{
		{"2026-10-19", nil, 0},
		{"2026-10-16", nil, 1},                    // Fri -> Mon
		{"2026-10-14", nil, 3},                    // Wed -> Thu, Fri, Mon
		{"2026-10-13", nil, 4},                    // stale
		{"2026-10-14", []string{"2026-10-15"}, 2}, // a holiday is not a trading day
	}
	for _, c := range cases {
		var hs []time.Time
		for _, h := range c.hol {
			hs = append(hs, d(h))
		}
		if got := predict.TradingDaysBehind(d(c.asOf), insNow, hs); got != c.want {
			t.Errorf("%s: %d want %d", c.asOf, got, c.want)
		}
	}
}
