package httpx

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/admin"
	"github.com/india-analyzer/api/internal/market"
	"github.com/india-analyzer/api/internal/predict"
)

// B14 review fixes (PRDX-, MKTX-, ADMX- rows of docs/07). Same pinned clock as insights tests:
// Tuesday 2026-10-20 17:30 IST, expected last trading date Monday 2026-10-19.

func (e *insEnv) meta(path string) map[string]any {
	e.t.Helper()
	code, m := e.getJSON(path)
	if code != 200 {
		e.t.Fatalf("%s: %d %v", path, code, m)
	}
	return m["meta"].(map[string]any)
}

// history inserts n daily bars (one per calendar day, ending before endExclusive) with a flat close.
func (e *insEnv) history(sym string, firstDay string, n int, close float64, vol int64) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        SELECT i.id, d::date, $3, $3, $3, $3, $3, $4, 'import' FROM instrument i,
	        generate_series($2::date, $2::date + ($5::int - 1), '1 day') d WHERE i.symbol = $1`, sym, firstDay, close, vol, n)
}

func (e *insEnv) bar(sym, date string, close float64, vol int64) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        SELECT id, $2::date, $3, $3, $3, $3, $3, $4, 'import' FROM instrument WHERE symbol = $1`, sym, date, close, vol)
}

// MKTX-01 (B14 review 1): meta.as_of is the newest index or mover date (never the clock), meta.stale
// comes from the holiday-aware calendar, and an empty database has a null as_of with a reason.
func TestReviewOverviewMeta(t *testing.T) {
	e := newInsEnv(t)
	meta := e.meta("/api/v1/market/overview")
	if v, ok := meta["as_of"]; !ok || v != nil || meta["as_of_reason"] != "no_data" || meta["stale"] != false {
		t.Fatalf("empty meta = %v", meta)
	}

	// Index at Fri 10-16, movers at Mon 10-19: the as-of is the newer of the two.
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50','2026-10-15',24000),('NIFTY50','2026-10-16',24100)`)
	e.stock("AAA", "Aaa Ltd")
	e.history("AAA", "2026-08-01", 58, 100, 1_000_000)
	e.bar("AAA", "2026-10-16", 100, 1_000_000)
	e.bar("AAA", "2026-10-19", 101, 1_000_000)
	meta = e.meta("/api/v1/market/overview")
	if meta["as_of"] != "2026-10-19T00:00:00Z" || meta["stale"] != false {
		t.Fatalf("meta = %v", meta)
	}
}

func TestReviewOverviewStale(t *testing.T) {
	e := newInsEnv(t)
	// Newest data Wed 10-14 while Mon 10-19 is expected: stale, with a positive age.
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50','2026-10-13',24000),('NIFTY50','2026-10-14',24100)`)
	meta := e.meta("/api/v1/market/overview")
	if meta["as_of"] != "2026-10-14T00:00:00Z" || meta["stale"] != true || meta["stale_age_hours"].(float64) <= 0 {
		t.Fatalf("meta = %v", meta)
	}
}

// MKTX-02 (B14 review 2): movers use the trading day just before the newest bar date; a partial import
// or a multi-day gap gives no_common_dates, a holiday between is honoured, and flat or illiquid stocks
// give no_qualifying_movers.
func TestReviewMoversDateAlignment(t *testing.T) {
	e := newInsEnv(t)
	for _, s := range []string{"A", "B"} {
		e.stock(s, s+" Ltd")
		e.history(s, "2026-08-01", 58, 100, 1_000_000)
	}
	gainers := func() []any {
		return e.data("/api/v1/market/overview")["movers"].(map[string]any)["gainers"].([]any)
	}

	// Partial import: A has Fri 10-16 and Mon 10-19, B only Mon 10-19 (its previous bar is old).
	e.bar("A", "2026-10-16", 100, 1_000_000)
	e.bar("A", "2026-10-19", 110, 1_000_000)
	e.bar("B", "2026-10-19", 120, 1_000_000)
	g := gainers()
	if len(g) != 1 || g[0].(map[string]any)["symbol"] != "A" {
		t.Fatalf("a stock without the previous trading day's bar must not rank (its change would span days): %v", g)
	}

	// Multi-day gap: nobody has Fri 10-16; everybody's previous bar is Wed 10-14.
	e2 := newInsEnv(t)
	for _, s := range []string{"A", "B"} {
		e2.stock(s, s+" Ltd")
		e2.history(s, "2026-08-01", 58, 100, 1_000_000)
		e2.bar(s, "2026-10-14", 100, 1_000_000)
		e2.bar(s, "2026-10-19", 110, 1_000_000)
	}
	d := e2.data("/api/v1/market/overview")
	if len(d["movers"].(map[string]any)["gainers"].([]any)) != 0 || d["movers_reason"] != "no_common_dates" {
		t.Fatalf("multi-day gap = %v", d["movers"])
	}
	// The Friday is a trading holiday: Thursday 10-15 is not a bar either, so the previous trading
	// day is Thu 10-15 and still nothing lines up; with bars on Thu the movers appear.
	e2.exec(`INSERT INTO market_holiday (holiday_date, segment, source) VALUES ('2026-10-16','trading','seed')`)
	e2.bar("A", "2026-10-15", 100, 1_000_000)
	d = e2.data("/api/v1/market/overview")
	g2 := d["movers"].(map[string]any)["gainers"].([]any)
	if len(g2) != 1 || g2[0].(map[string]any)["symbol"] != "A" {
		t.Fatalf("holiday-aware previous day: %v", d["movers"])
	}

	// Flat prices: data lines up but nothing moved: a distinct reason from no_prices_imported.
	e3 := newInsEnv(t)
	e3.stock("F", "Flat Ltd")
	e3.history("F", "2026-08-01", 58, 100, 1_000_000)
	e3.bar("F", "2026-10-16", 100, 1_000_000)
	e3.bar("F", "2026-10-19", 100, 1_000_000)
	if r := e3.data("/api/v1/market/overview")["movers_reason"]; r != "no_qualifying_movers" {
		t.Fatalf("reason = %v", r)
	}
}

// MKTX-03 (B14 review 3): liquidity is the 60-day average traded value, not one day's turnover.
func TestReviewMoversUse60DayADV(t *testing.T) {
	e := newInsEnv(t)
	e.stock("SPIKE", "Spike Ltd")
	e.history("SPIKE", "2026-08-01", 58, 100, 10) // illiquid for 58 days
	e.bar("SPIKE", "2026-10-16", 100, 10)
	e.bar("SPIKE", "2026-10-19", 150, 1_000_000) // one day of 15 crore, but a 60-day average of 0.25 crore
	e.stock("STEADY", "Steady Ltd")
	e.history("STEADY", "2026-08-01", 58, 100, 1_000_000)
	e.bar("STEADY", "2026-10-16", 100, 1_000_000)
	e.bar("STEADY", "2026-10-19", 101, 1_000_000)
	g := e.data("/api/v1/market/overview")["movers"].(map[string]any)["gainers"].([]any)
	if len(g) != 1 || g[0].(map[string]any)["symbol"] != "STEADY" {
		t.Fatalf("a one-day volume spike must not qualify: %v", g)
	}
}

// MKTX-04 (nits): only the whitelisted codes show; the VIX has its own unit.
func TestReviewIndexWhitelist(t *testing.T) {
	e := newInsEnv(t)
	e.exec(`INSERT INTO market_series (code, trade_date, value) VALUES ('NIFTY50','2026-10-19',24240),('FOO','2026-10-19',1),('INDIAVIX','2026-10-19',13.5)`)
	d := e.data("/api/v1/market/overview")
	idx := d["indices"].([]any)
	if len(idx) != 1 || idx[0].(map[string]any)["code"] != "NIFTY50" {
		t.Fatalf("indices = %v", idx)
	}
	if v := d["vix"].(map[string]any); v["code"] != "INDIAVIX" || strings.Contains(v["unit"].(string), "index points") {
		t.Fatalf("vix = %v", v)
	}
}

// PRDX-01 (B14 review 4): an active model with no stored row says awaiting_predictions, never
// insufficient_history; an untracked or delisted stock says not_tracked.
func TestReviewPredictionNoRowReasons(t *testing.T) {
	e := newInsEnv(t)
	e.run("dir_5d", "active", true, goodValid, goodBase)
	e.stock("NEW", "New Ltd")
	e.addStock("UNTRK", "Untracked Ltd")
	e.stock("GONE", "Gone Ltd")
	e.exec(`UPDATE instrument SET status = 'delisted' WHERE symbol = 'GONE'`)
	for sym, want := range map[string]string{"NEW": "awaiting_predictions", "UNTRK": "not_tracked", "GONE": "not_tracked"} {
		h := hz(e.data("/api/v1/stocks/"+sym+"/prediction"), 5)
		if h["shown"] != false || h["hidden_reason"] != want {
			t.Fatalf("%s: %v", sym, h)
		}
		if _, ok := h["p_up"]; ok {
			t.Fatalf("%s leaks p_up", sym)
		}
	}
	// A stale stored row of a stock that stopped being tracked is hidden too (never shown).
	run := e.run("dir_21d", "active", true, goodValid, goodBase)
	e.pred("UNTRK", 21, run, "2026-10-19", 0.6, -0.04, 0.01, 0.05, true, nil)
	if h := hz(e.data("/api/v1/stocks/UNTRK/prediction"), 21); h["hidden_reason"] != "not_tracked" || h["shown"] != false {
		t.Fatalf("untracked with a row = %v", h)
	}
}

// PRDX-02 (B14 review 5): the by-run track-record query uses the prediction(model_run_id) index and
// there is one aggregation per request. No wall clock: the plan is asserted.
func TestReviewTrackRecordUsesIndex(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata")
	small := e.run("dir_5d", "active", true, goodValid, goodBase)
	big := e.run("dir_21d", "active", true, goodValid, goodBase)
	e.exec(`INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, ref_close, shown)
	        SELECT i.id, ('2024-01-01'::date + g), 5, $1, 0.55, 100, true FROM instrument i, generate_series(1, 20) g WHERE i.symbol = 'TCS'`, small)
	e.exec(`INSERT INTO prediction (instrument_id, as_of, horizon_days, model_run_id, p_up, ref_close, shown)
	        SELECT i.id, ('2000-01-01'::date + g), 21, $1, 0.55, 100, true FROM instrument i, generate_series(1, 20000) g WHERE i.symbol = 'TCS'`, big)
	e.exec(`ANALYZE prediction`)
	var plan string
	row := e.pool.QueryRow(context.Background(), `EXPLAIN (FORMAT JSON) SELECT p.model_run_id, count(o.prediction_id), count(o.direction_correct),
		count(*) FILTER (WHERE o.direction_correct), count(o.in_band), count(*) FILTER (WHERE o.in_band), min(p.as_of)
		FROM prediction p LEFT JOIN prediction_outcome o ON o.prediction_id = p.id
		WHERE p.model_run_id = ANY($1::bigint[]) AND p.p_up IS NOT NULL GROUP BY p.model_run_id`, []int64{small})
	if err := row.Scan(&plan); err != nil {
		t.Fatal(err)
	}
	var root []map[string]any
	if err := json.Unmarshal([]byte(plan), &root); err != nil {
		t.Fatal(err)
	}
	var seq, byIdx bool
	var walk func(n map[string]any)
	walk = func(n map[string]any) {
		if n["Relation Name"] == "prediction" {
			seq = seq || n["Node Type"] == "Seq Scan"
			byIdx = byIdx || n["Index Name"] == "prediction_model_run_idx"
		}
		if kids, ok := n["Plans"].([]any); ok {
			for _, k := range kids {
				walk(k.(map[string]any))
			}
		}
	}
	walk(root[0]["Plan"].(map[string]any))
	if seq || !byIdx {
		t.Fatalf("track record must read prediction through prediction_model_run_idx, not a Seq Scan: %s", plan)
	}
	// Both horizons answer from one aggregation and stay correct.
	d := e.data("/api/v1/stocks/TCS/prediction")
	if hz(d, 5)["track_record"].(map[string]any)["resolved"].(float64) != 0 {
		t.Fatalf("5d track record = %v", hz(d, 5)["track_record"])
	}
	if hz(d, 21)["track_record"].(map[string]any)["since"] != "2000-01-02" {
		t.Fatalf("21d track record = %v", hz(d, 21)["track_record"])
	}
}

// PRDX-03 (B14 review 6): the model state ignores skipped and failed train runs, and names a timeout
// and a dry run honestly.
func TestReviewTrainStateFilters(t *testing.T) {
	e := newInsEnv(t)
	e.stock("TCS", "Tata")
	ins := func(started, status, details string) {
		e.exec(`INSERT INTO ingestion_run (job, started_at, finished_at, status, details)
		        VALUES ('train_models', $1, $1, $2, $3::jsonb)`, started, status, details)
	}
	state := func() (string, string) {
		d := e.data("/api/v1/stocks/TCS/prediction")
		r, _ := d["state_reason"].(string)
		return d["state"].(string), r
	}
	ins("2026-10-17T05:00:00Z", "ok", `{"status":"insufficient_universe","eligible":3}`)
	// A later skipped run (already running) has no status key and must not mask the real result.
	ins("2026-10-18T05:00:00Z", "skipped", `{"reason":"already_running"}`)
	// A later failed run is ignored too.
	ins("2026-10-19T05:00:00Z", "failed", `{"errors":[]}`)
	if s, _ := state(); s != "insufficient_universe" {
		t.Fatalf("state = %s", s)
	}
	ins("2026-10-19T06:00:00Z", "partial", `{"status":"aborted_timeout"}`)
	if s, r := state(); s != "training_aborted" || !strings.Contains(r, "time limit") {
		t.Fatalf("aborted = %s %q", s, r)
	}
	ins("2026-10-19T07:00:00Z", "ok", `{"status":"dry_run"}`)
	if s, r := state(); s != "no_model" || !strings.Contains(r, "dry run") {
		t.Fatalf("dry run = %s %q", s, r)
	}
}

// PRDX-04 (B14 review 7): the corporate-action rule of docs/05 10.6 is re-applied at read time.
func TestReviewPredictionActionAtReadTime(t *testing.T) {
	e := newInsEnv(t)
	run := e.run("dir_5d", "active", true, goodValid, goodBase)
	cases := []struct {
		sym, status, ex string
		want            any // nil = shown
	}{
		{"DET", "detected", "2025-01-01", "near_corporate_action"},     // unconfirmed, any date
		{"SOON", "confirmed", "2026-10-23", "near_corporate_action"},   // 3 trading days ahead
		{"RECENT", "confirmed", "2026-10-14", "near_corporate_action"}, // within 5 trading days of as_of
		{"FAR", "confirmed", "2026-12-01", nil},
		{"OLDACT", "confirmed", "2026-08-01", nil},
		{"REJ", "rejected", "2026-10-23", nil},
	}
	for _, c := range cases {
		e.stock(c.sym, c.sym+" Ltd")
		e.pred(c.sym, 5, run, "2026-10-19", 0.55, -0.04, 0.01, 0.05, true, nil)
		e.exec(`INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, source)
		        SELECT id, $2::date, 'split', $3, 'manual' FROM instrument WHERE symbol = $1`, c.sym, c.ex, c.status)
		h := hz(e.data("/api/v1/stocks/"+c.sym+"/prediction"), 5)
		if h["hidden_reason"] != c.want || (c.want == nil) != (h["shown"] == true) {
			t.Fatalf("%s: %v", c.sym, h)
		}
		if c.want != nil {
			if _, ok := h["p_up"]; ok {
				t.Fatalf("%s leaks p_up", c.sym)
			}
		}
	}
}

// PRDX-05 (nits): quantiles must be ordered and finite, else the horizon is hidden as stale_data;
// meta carries the data date and the calendar staleness.
func TestReviewPredictionNumbersAndMeta(t *testing.T) {
	e := newInsEnv(t)
	run := e.run("dir_5d", "active", true, goodValid, goodBase)
	e.stock("BAD", "Bad Ltd")
	e.pred("BAD", 5, run, "2026-10-19", 0.55, 0.05, 0.01, -0.04, true, nil) // q10 > q90
	if h := hz(e.data("/api/v1/stocks/BAD/prediction"), 5); h["shown"] != false || h["hidden_reason"] != "stale_data" {
		t.Fatalf("unordered quantiles = %v", h)
	}
	e.stock("OK", "Ok Ltd")
	e.pred("OK", 5, run, "2026-10-19", 0.55, -0.04, 0.01, 0.05, true, nil)
	meta := e.meta("/api/v1/stocks/OK/prediction")
	if meta["as_of"] != "2026-10-19T00:00:00Z" || meta["stale"] != false {
		t.Fatalf("meta = %v", meta)
	}
	// No stored row: no data date, a null as_of with a reason (not the clock).
	e.stock("NOROW", "No Row Ltd")
	meta = e.meta("/api/v1/stocks/NOROW/prediction")
	if v, ok := meta["as_of"]; !ok || v != nil || meta["as_of_reason"] != "no_data" {
		t.Fatalf("meta without a row = %v", meta)
	}
	// An old row is stale in meta as well.
	e.stock("OLD", "Old Ltd")
	e.pred("OLD", 5, run, "2026-10-09", 0.55, -0.04, 0.01, 0.05, true, nil)
	if m := e.meta("/api/v1/stocks/OLD/prediction"); m["stale"] != true || m["stale_age_hours"].(float64) <= 0 {
		t.Fatalf("old meta = %v", m)
	}
}

// PRDX-06 (nits): cross-language contract. The fixture is the worker's GuardrailResult.to_json output
// nested as store.py stores it (valid_metrics.guardrail) plus its baseline_metrics, committed as a
// static file; the API must read the model card numbers from exactly those keys.
func TestReviewValidMetricsContractFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../fixtures/ml/guardrail_valid_metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx map[string]struct {
		Passed   bool           `json:"passed"`
		Valid    map[string]any `json:"valid_metrics"`
		Baseline map[string]any `json:"baseline_metrics"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	e := newInsEnv(t)
	e.stock("TCS", "Tata")
	enc := func(v any) string { b, _ := json.Marshal(v); return string(b) }

	pass := fx["pass"]
	e.run("dir_5d", "active", pass.Passed, enc(pass.Valid), enc(pass.Baseline))
	sum := pass.Valid["guardrail"].(map[string]any)["summary"].(map[string]any)
	m := hz(e.data("/api/v1/stocks/TCS/prediction"), 5)["model"].(map[string]any)
	if !approx(m["oos_auc"].(float64), sum["auc_mean"].(float64)) || !approx(m["oos_brier"].(float64), sum["brier_mean"].(float64)) ||
		!approx(m["baseline_brier"].(float64), pass.Baseline["b1_brier_mean"].(float64)) ||
		m["folds"].(float64) != sum["folds"].(float64) || m["guardrail_pass"] != true {
		t.Fatalf("model card %v does not match the worker output %v", m, sum)
	}

	// A failed candidate and an insufficient_folds candidate map to the documented reasons.
	e.run("dir_21d", "candidate", false, enc(fx["fail"].Valid), enc(fx["fail"].Baseline))
	if h := hz(e.data("/api/v1/stocks/TCS/prediction"), 21); h["hidden_reason"] != "model_not_better_than_baseline" {
		t.Fatalf("fail fixture = %v", h)
	}
	e2 := newInsEnv(t)
	e2.stock("TCS", "Tata")
	e2.run("dir_5d", "candidate", false, enc(fx["insufficient_folds"].Valid), `{}`)
	if h := hz(e2.data("/api/v1/stocks/TCS/prediction"), 5); h["hidden_reason"] != "insufficient_history" {
		t.Fatalf("insufficient_folds fixture = %v", h)
	}
}

// ADMX-01 (B14 review 6): a skipped run never masks the last real result of a job; it is reported
// separately as last_skipped_at.
func TestReviewAdminSkippedRunDoesNotMask(t *testing.T) {
	e := newInsEnv(t)
	e.exec(`INSERT INTO ingestion_run (job, started_at, finished_at, status, rows_written, items_failed, details) VALUES
		('train_models','2026-10-19T05:00:00Z','2026-10-19T05:30:00Z','ok',12,0,'{"status":"ok"}'),
		('train_models','2026-10-20T05:00:00Z','2026-10-20T05:00:01Z','skipped',0,0,'{"reason":"already_running"}'),
		('predict','2026-10-20T04:00:00Z','2026-10-20T04:10:00Z','ok',7,0,'{}')`)
	jobs := e.data("/api/v1/admin/status")["jobs"].([]any)
	by := map[string]map[string]any{}
	for _, j := range jobs {
		by[j.(map[string]any)["job"].(string)] = j.(map[string]any)
	}
	tm := by["train_models"]
	if tm["status"] != "ok" || tm["rows_written"].(float64) != 12 || tm["last_skipped_at"] != "2026-10-20T05:00:00Z" {
		t.Fatalf("train_models = %v", tm)
	}
	if _, ok := by["predict"]["last_skipped_at"]; ok {
		t.Fatalf("no skip, no key: %v", by["predict"])
	}
}

// ADMX-02 (B14 review 8): rows is null for a table that was never analyzed (reltuples -1) and used_pct
// is null when no limit is configured; a non-ok warn level reaches the response through the handler.
func TestReviewAdminDBBlock(t *testing.T) {
	e := newInsEnv(t)
	db := e.data("/api/v1/admin/status")["db"].(map[string]any)
	sawNull := false
	for _, x := range db["tables"].([]any) {
		tb := x.(map[string]any)
		if tb["rows"] == nil {
			sawNull = true
		} else if tb["rows"].(float64) < 0 {
			t.Fatalf("negative rows: %v", tb)
		}
	}
	if !sawNull {
		t.Fatalf("a never-analyzed table must report rows null: %v", db["tables"])
	}
	if db["used_pct"] == nil || db["warn_level"] != "ok" {
		t.Fatalf("db = %v", db)
	}

	build := func(limit int) map[string]any {
		a := admin.New(e.pool, limit, "x")
		a.Now = func() time.Time { return insNow }
		h := NewRouter(Deps{Log: zerolog.Nop(), Accounts: e.svc, Pinger: &fakePinger{}, Predict: predict.New(e.pool), Market: market.New(e.pool), Admin: a})
		e2 := &insEnv{&stockEnv{authEnv: e.authEnv, cookie: e.cookie}}
		e2.h = h
		return e2.data("/api/v1/admin/status")["db"].(map[string]any)
	}
	if d := build(0); d["used_pct"] != nil || d["warn_level"] != "ok" || d["limit_mb"].(float64) != 0 {
		t.Fatalf("no limit = %v", d)
	}
	// A 1 MB soft limit is far below the size of the migrated test database: warn level "limit".
	if d := build(1); d["warn_level"] != "limit" || d["used_pct"].(float64) < 100 {
		t.Fatalf("limit 1 MB = %v", d)
	}
}

// ADMX-03 (nits): secrets in source_health.note and ingestion_run.error are scrubbed at read time.
func TestReviewAdminScrubsFreeText(t *testing.T) {
	e := newInsEnv(t)
	e.exec(`INSERT INTO source_health (source, checked_at, ok, consecutive_failures, note) VALUES
		('mfapi','2026-10-20T06:00:00Z',false,1,'GET https://user:hunter2pass@host/x failed')`)
	e.exec(`INSERT INTO ingestion_run (job, started_at, finished_at, status, error) VALUES
		('predict','2026-10-20T02:00:00Z','2026-10-20T02:01:00Z','failed','auth failed: Bearer abcdef123456789 rejected')`)
	d := e.data("/api/v1/admin/status")
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "hunter2pass") || strings.Contains(string(raw), "abcdef123456789") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if d["jobs"].([]any)[0].(map[string]any)["error"] == nil || d["sources"].([]any)[0].(map[string]any)["note"] == nil {
		t.Fatalf("scrubbed text must remain: %v", d)
	}
}
