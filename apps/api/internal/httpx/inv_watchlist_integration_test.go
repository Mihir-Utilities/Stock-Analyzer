package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"
)

// Watchlist seasonality (INV-W01..W08, docs/03 section 11): the API picks today's IST month from the
// newest snapshot's analysis.seasonality block; nothing is recomputed when the month changes.

type wlSeasonality struct {
	Month          int      `json:"month"`
	MonthName      string   `json:"month_name"`
	AsOf           string   `json:"as_of"`
	DataSince      string   `json:"data_since"`
	YearsOfHistory *float64 `json:"years_of_history"`
	NYears         int      `json:"n_years"`
	NGreen         int      `json:"n_green"`
	GreenPct       *float64 `json:"green_pct"`
	GreenPctReason *string  `json:"green_pct_reason"`
	SmallSample    bool     `json:"small_sample"`
	MinYears       int      `json:"min_years"`
	AvgPct         *float64 `json:"avg_pct"`
	MedianPct      *float64 `json:"median_pct"`
	MtdReturnPct   *float64 `json:"mtd_return_pct"`
	MtdReason      *string  `json:"mtd_reason"`
	MtdAsOf        *string  `json:"mtd_as_of"`
}

type wlStock struct {
	Symbol            string         `json:"symbol"`
	LTP               *float64       `json:"ltp"`
	ChangePct         *float64       `json:"change_pct"`
	PriceStale        bool           `json:"price_stale"`
	Seasonality       *wlSeasonality `json:"seasonality"`
	SeasonalityReason *string        `json:"seasonality_reason"`
}

// seasonalityJSON is a worker-shaped block where month m has n_years = m (so the chosen month is
// visible) and a share only from min_years = 3.
func seasonalityJSON(asOf string, runYear, runMonth int, mtd string, filler int) string {
	var months []string
	for m := 1; m <= 12; m++ {
		green, reason := "null", `"too_few_years"`
		if m >= 3 {
			green, reason = fmt.Sprintf("%d.5", m*5), "null"
		}
		months = append(months, fmt.Sprintf(`{"month":%d,"n_years":%d,"n_green":%d,"green_pct":%s,"green_pct_reason":%s,`+
			`"avg_pct":1.25,"median_pct":1.5,"best":{"pct":5.0,"year":2019},"worst":{"pct":-2.0,"year":2020},"small_sample":%t}`,
			m, m, m/2, green, reason, m < 5))
	}
	mtdReason := "null"
	if mtd == "null" {
		mtdReason = `"no_base"`
	}
	pad := ""
	if filler > 0 {
		rng := rand.New(rand.NewSource(7)) //nolint:gosec // deterministic test data, incompressible-ish like real prices
		nums := make([]string, filler)
		for i := range nums {
			nums[i] = fmt.Sprintf("%.4f", 50+rng.Float64()*950)
		}
		pad = `,"series":{"sma50":[` + strings.Join(nums, ",") + `]}`
	}
	return fmt.Sprintf(`{"as_of":%q,"bars":900%s,"analysis":{"seasonality":{"as_of":%q,"bars":900,"first_bar":"2019-03-01",`+
		`"last_bar":%q,"years_of_history":7.7,"min_years":3,"small_sample_years":5,`+
		`"running":{"year":%d,"month":%d,"mtd_return_pct":%s,"mtd_reason":%s,"base_date":"2026-09-30","as_of":%q},`+
		`"months":[%s],"best_month":null,"worst_month":null,"best_worst_reason":"too_few_months","years":{}}}}`,
		asOf, pad, asOf, asOf, runYear, runMonth, mtd, mtdReason, asOf, strings.Join(months, ","))
}

func (e *pfEnv) snapshot(id int, asOf, indicators string) {
	e.t.Helper()
	e.exec(`INSERT INTO analysis_snapshot (instrument_id, as_of, indicators, scores, version)
	        VALUES ($1, $2, $3::jsonb, '{}'::jsonb, 'b16-test')`, id, asOf, indicators)
}

func (e *pfEnv) watch(symbol string) {
	e.t.Helper()
	if r, _ := e.req(http.MethodPost, "/watchlist", `{"type":"stock","symbol":"`+symbol+`"}`, nil); r.Code != 201 {
		e.t.Fatalf("add %s: %d %s", symbol, r.Code, r.Body.String())
	}
}

func (e *pfEnv) watchlist() map[string]wlStock {
	e.t.Helper()
	r, b := e.req(http.MethodGet, "/watchlist", "", nil)
	if r.Code != 200 {
		e.t.Fatalf("watchlist: %d %s", r.Code, r.Body.String())
	}
	var wl struct {
		Stocks []wlStock `json:"stocks"`
	}
	b.into(e.t, &wl)
	out := map[string]wlStock{}
	for _, s := range wl.Stocks {
		out[s.Symbol] = s
	}
	return out
}

func setClock(t *testing.T, at time.Time) {
	t.Helper()
	old := pfNow
	pfNow = at
	t.Cleanup(func() { pfNow = old })
}

func TestINVW01W03W04WatchlistSeasonality(t *testing.T) {
	e := newPFEnv(t) // pinned clock: 2026-10-23 12:00 IST
	cur := e.instrument("CUR", "")
	old := e.instrument("OLD", "")
	e.bar(cur, "2026-10-22", 100)
	e.bar(cur, "2026-10-23", 103)
	e.bar(old, "2026-09-30", 100)
	e.watch("CUR")
	e.watch("OLD")
	// CUR: the snapshot already has bars of October; the running month is October (MTD +3.0).
	e.snapshot(cur, "2026-10-23", seasonalityJSON("2026-10-23", 2026, 10, "3.0", 0))
	// OLD: the newest snapshot is from September.
	e.snapshot(old, "2026-09-30", seasonalityJSON("2026-09-30", 2026, 9, "1.0", 0))

	wl := e.watchlist()
	c := wl["CUR"].Seasonality
	if c == nil || wl["CUR"].SeasonalityReason != nil {
		t.Fatalf("CUR: %+v reason=%v", c, wl["CUR"].SeasonalityReason)
	}
	// W01 fields; the October entry (n_years = 10 in the fixture)
	if c.Month != 10 || c.MonthName != "October" || c.NYears != 10 || c.MinYears != 3 || c.DataSince != "2019-03-01" || c.AsOf != "2026-10-23" {
		t.Fatalf("CUR fields: %+v", c)
	}
	if c.GreenPct == nil || *c.GreenPct != 50.5 || c.GreenPctReason != nil || c.SmallSample {
		t.Fatalf("CUR share: %+v", c)
	}
	if c.YearsOfHistory == nil || *c.YearsOfHistory != 7.7 || c.AvgPct == nil || c.MedianPct == nil {
		t.Fatalf("CUR stats: %+v", c)
	}
	if c.MtdReturnPct == nil || *c.MtdReturnPct != 3.0 || c.MtdReason != nil || c.MtdAsOf == nil || *c.MtdAsOf != "2026-10-23" {
		t.Fatalf("CUR mtd: %+v", c)
	}
	// W04: an older-month snapshot keeps the share but its MTD is null (no_bar_this_month)
	o := wl["OLD"].Seasonality
	if o == nil || o.Month != 10 || o.NYears != 10 || o.GreenPct == nil {
		t.Fatalf("OLD: %+v", o)
	}
	if o.MtdReturnPct != nil || o.MtdReason == nil || *o.MtdReason != "no_bar_this_month" || o.MtdAsOf != nil {
		t.Fatalf("OLD mtd: %+v", o)
	}
}

func TestINVW02MonthSelectionAtTheIstMonthBoundary(t *testing.T) {
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.bar(id, "2026-11-27", 100)
	e.watch("TCS")
	e.snapshot(id, "2026-11-27", seasonalityJSON("2026-11-27", 2026, 11, "2.0", 0))
	// 2026-11-11 IST: November
	setClock(t, time.Date(2026, 11, 11, 6, 30, 0, 0, time.UTC))
	if s := e.watchlist()["TCS"].Seasonality; s == nil || s.Month != 11 || s.MonthName != "November" || s.NYears != 11 {
		t.Fatalf("11 Nov: %+v", s)
	}
	// 23:59 IST on 30 November (18:29 UTC): still November
	setClock(t, time.Date(2026, 11, 30, 18, 29, 0, 0, time.UTC))
	if s := e.watchlist()["TCS"].Seasonality; s == nil || s.Month != 11 || s.MtdReturnPct == nil {
		t.Fatalf("30 Nov 23:59: %+v", s)
	}
	// 00:00 IST on 1 December (18:30 UTC on the 30th): December, no recompute, MTD gone
	setClock(t, time.Date(2026, 11, 30, 18, 30, 0, 0, time.UTC))
	s := e.watchlist()["TCS"].Seasonality
	if s == nil || s.Month != 12 || s.MonthName != "December" || s.NYears != 12 {
		t.Fatalf("1 Dec 00:00: %+v", s)
	}
	if s.MtdReturnPct != nil || s.MtdReason == nil || *s.MtdReason != "no_bar_this_month" {
		t.Fatalf("1 Dec mtd: %+v", s)
	}
}

func TestINVW05W06NoSnapshotAndFewYears(t *testing.T) {
	e := newPFEnv(t)
	e.instrument("NOPX", "")
	noSnap := e.instrument("NOSNAP", "")
	young := e.instrument("YOUNG", "")
	oldSnap := e.instrument("OLDSNAP", "")
	e.bar(noSnap, "2026-10-23", 100)
	e.bar(young, "2026-10-23", 100)
	e.bar(oldSnap, "2026-10-23", 100)
	for _, s := range []string{"NOPX", "NOSNAP", "YOUNG", "OLDSNAP"} {
		e.watch(s)
	}
	// YOUNG: October has 2 years only -> no share (min_years 3), n_years and data_since still there
	young2 := strings.Replace(seasonalityJSON("2026-10-23", 2026, 10, "1.0", 0),
		`{"month":10,"n_years":10,"n_green":5,"green_pct":50.5,"green_pct_reason":null`,
		`{"month":10,"n_years":2,"n_green":1,"green_pct":null,"green_pct_reason":"too_few_years"`, 1)
	e.snapshot(young, "2026-10-23", young2)
	// OLDSNAP: a snapshot from before B16 (no seasonality block)
	e.snapshot(oldSnap, "2026-10-23", `{"as_of":"2026-10-23","bars":900,"analysis":{"format":"columnar"}}`)

	wl := e.watchlist()
	if s := wl["NOPX"]; s.Seasonality != nil || s.SeasonalityReason == nil || *s.SeasonalityReason != "no_prices_imported" {
		t.Fatalf("NOPX: %+v", s)
	}
	if s := wl["NOSNAP"]; s.Seasonality != nil || s.SeasonalityReason == nil || *s.SeasonalityReason != "no_history" {
		t.Fatalf("NOSNAP: %+v", s)
	}
	if s := wl["OLDSNAP"]; s.Seasonality != nil || s.SeasonalityReason == nil || *s.SeasonalityReason != "no_history" {
		t.Fatalf("OLDSNAP: %+v", s)
	}
	y := wl["YOUNG"].Seasonality
	if y == nil || y.NYears != 2 || y.GreenPct != nil || y.GreenPctReason == nil || *y.GreenPctReason != "too_few_years" || y.DataSince != "2019-03-01" {
		t.Fatalf("YOUNG: %+v", y)
	}
	// W07: the existing fields are unchanged next to the new ones
	if wl["YOUNG"].LTP == nil || *wl["YOUNG"].LTP != 100 {
		t.Fatalf("ltp: %+v", wl["YOUNG"])
	}
	_, b := e.req(http.MethodGet, "/watchlist", "", nil)
	var raw struct {
		Stocks []map[string]json.RawMessage `json:"stocks"`
	}
	b.into(t, &raw)
	for _, k := range []string{"id", "symbol", "name", "ltp", "ltp_as_of", "price_stale", "change_pct", "change_reason", "added_at", "note", "seasonality", "seasonality_reason"} {
		if _, ok := raw.Stocks[0][k]; !ok {
			t.Errorf("stock field %q missing", k)
		}
	}
}

func TestINVW08WatchlistCostWith50FullSizeSnapshots(t *testing.T) {
	e := newPFEnv(t)
	for i := 0; i < 50; i++ {
		sym := fmt.Sprintf("S%02d", i)
		id := e.instrument(sym, "")
		e.bar(id, "2026-10-22", 100)
		e.bar(id, "2026-10-23", 101)
		e.watch(sym)
		// ~130 KB of series next to the seasonality block, as in a 25-year stock's snapshot
		e.snapshot(id, "2026-10-23", seasonalityJSON("2026-10-23", 2026, 10, "1.0", 14000))
	}
	var size int
	if err := e.pool.QueryRow(context.Background(), `SELECT max(pg_column_size(indicators)) FROM analysis_snapshot`).Scan(&size); err != nil {
		t.Fatal(err)
	}
	var took []time.Duration
	for i := 0; i < 9; i++ {
		start := time.Now()
		if got := len(e.watchlist()); got != 50 {
			t.Fatalf("stocks = %d", got)
		}
		took = append(took, time.Since(start))
	}
	sort.Slice(took, func(a, b int) bool { return took[a] < took[b] })
	worst := took[len(took)-1]
	t.Logf("INV-W08: 50 stocks, indicators column up to %d bytes, watchlist median %v, worst of 9 %v", size, took[4], worst)
	if worst > 500*time.Millisecond {
		t.Fatalf("watchlist over budget (%v > 500ms): the INV-8 fallback column is required; record an owner question", worst)
	}
}
