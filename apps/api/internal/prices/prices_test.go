package prices

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// Hand-computed example: Mon-Wed of one ISO week and Fri of the same week, then a Monday of the
// next week. Weekly candle = open of first, high max, low min, close of last, volume sum; dated
// with the last trading day of the week.
func TestWeeklyHandComputed(t *testing.T) {
	daily := []Bar{
		{day("2026-10-05"), 100, 110, 95, 105, 10}, // Mon
		{day("2026-10-06"), 105, 120, 100, 118, 20},
		{day("2026-10-07"), 118, 119, 90, 92, 30},
		{day("2026-10-09"), 92, 99, 91, 98, 40}, // Fri (Thu holiday: no forward fill)
		{day("2026-10-12"), 98, 101, 97, 100, 5},
	}
	want := []Bar{
		{day("2026-10-09"), 100, 120, 90, 98, 100},
		{day("2026-10-12"), 98, 101, 97, 100, 5},
	}
	if got := Weekly(daily); !reflect.DeepEqual(got, want) {
		t.Fatalf("weekly = %+v, want %+v", got, want)
	}
}

func TestWeeklyYearBoundary(t *testing.T) {
	// 2026-12-31 (Thu) and 2027-01-01 (Fri) are ISO week 53 of 2026.
	got := Weekly([]Bar{{day("2026-12-31"), 1, 2, 1, 2, 1}, {day("2027-01-01"), 2, 3, 2, 3, 1}})
	if len(got) != 1 || got[0].Close != 3 {
		t.Fatalf("got %+v", got)
	}
}

func series(n int) []Bar {
	out := make([]Bar, n)
	d := day("1990-01-01")
	for i := range out {
		for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			d = d.AddDate(0, 0, 1)
		}
		c := 100 + float64(i%97)
		out[i] = Bar{d, c, c + 1, c - 1, c, 1}
		d = d.AddDate(0, 0, 1)
	}
	return out
}

// API-04 (unit part): never more than 2,000 points; weekly candles when daily exceeds it.
func TestReduceLimits(t *testing.T) {
	d := series(1500)
	if got, iv := Reduce(d); len(got) != 1500 || iv != "1d" {
		t.Fatalf("fits: %d %s", len(got), iv)
	}
	d = series(5000) // about 19 years
	got, iv := Reduce(d)
	if iv != "1w" || len(got) > MaxPoints || len(got) < 900 {
		t.Fatalf("weekly: %d %s", len(got), iv)
	}
	d = series(12000) // about 46 years: weekly still > 2000, LTTB
	got, iv = Reduce(d)
	if iv != "1w" || len(got) != MaxPoints {
		t.Fatalf("lttb: %d %s", len(got), iv)
	}
	if !got[0].Date.Equal(Weekly(d)[0].Date) || !got[len(got)-1].Date.Equal(Weekly(d)[len(Weekly(d))-1].Date) {
		t.Fatal("first and last candles must be kept")
	}
	for i := 1; i < len(got); i++ {
		if !got[i].Date.After(got[i-1].Date) {
			t.Fatal("not ascending")
		}
	}
}

func TestLTTBKeepsSpike(t *testing.T) {
	d := series(500)
	d[250].Close = 10000
	got := LTTB(d, 50)
	found := false
	for _, b := range got {
		found = found || b.Close == 10000
	}
	if !found || len(got) != 50 {
		t.Fatalf("spike lost or wrong size %d", len(got))
	}
}

// D05a-A6: columnar series become [[date, value]] pairs; nulls stay null at warm-up positions.
func TestExpandIndicators(t *testing.T) {
	ind := `{"as_of":"2026-10-09","series":{"format":"columnar","dates":["2026-10-08","2026-10-09"],
	  "sma50":[null,1.5],"macd":{"macd":[0.1,0.2],"signal":[null,0.3],"hist":[null,null]}},
	  "analysis":{"format":"columnar","drawdown":[0,-1.5],"return_histogram":{"edges":[1],"counts":[2],"n":2}}}`
	got, err := ExpandIndicators([]byte(ind), []byte(`{"trend":{"score":60}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	s := m["series"].(map[string]any)
	if _, ok := s["dates"]; ok {
		t.Fatal("dates must not leak")
	}
	if !reflect.DeepEqual(s["sma50"], []any{[]any{"2026-10-08", nil}, []any{"2026-10-09", 1.5}}) {
		t.Fatalf("sma50 = %v", s["sma50"])
	}
	sig := s["macd"].(map[string]any)["signal"]
	if !reflect.DeepEqual(sig, []any{[]any{"2026-10-08", nil}, []any{"2026-10-09", 0.3}}) {
		t.Fatalf("signal = %v", sig)
	}
	an := m["analysis"].(map[string]any)
	if _, ok := an["format"]; ok {
		t.Fatal("format marker must be dropped")
	}
	if !reflect.DeepEqual(an["drawdown"], []any{[]any{"2026-10-08", 0.0}, []any{"2026-10-09", -1.5}}) {
		t.Fatalf("drawdown = %v", an["drawdown"])
	}
	if _, ok := an["return_histogram"].(map[string]any)["edges"]; !ok {
		t.Fatal("histogram passes through")
	}
	if m["scores"].(map[string]any)["trend"] == nil {
		t.Fatal("scores missing")
	}
}

// docs/03 section 4: series are limited to the last 750 trading days; the most recent are kept.
func TestIndicatorsSeriesCap750(t *testing.T) {
	const n = 900
	dates, vals := make([]string, n), make([]float64, n)
	for i := range dates {
		dates[i] = day("2020-01-01").AddDate(0, 0, i).Format(time.DateOnly)
		vals[i] = float64(i)
	}
	ind := map[string]any{
		"series":   map[string]any{"format": "columnar", "dates": dates, "sma50": vals, "macd": map[string]any{"macd": vals}},
		"analysis": map[string]any{"drawdown": vals},
	}
	raw, _ := json.Marshal(ind)
	got, err := ExpandIndicators(raw, []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	s := got["series"].(map[string]any)
	for name, v := range map[string]any{
		"sma50": s["sma50"], "macd": s["macd"].(map[string]any)["macd"], "drawdown": got["analysis"].(map[string]any)["drawdown"],
	} {
		p := v.([][2]any)
		if len(p) != MaxSeriesPoints {
			t.Fatalf("%s has %d points, want %d", name, len(p), MaxSeriesPoints)
		}
		if p[len(p)-1][0] != dates[n-1] || p[len(p)-1][1] != float64(n-1) || p[0][0] != dates[n-MaxSeriesPoints] {
			t.Fatalf("%s must keep the most recent points: first=%v last=%v", name, p[0], p[len(p)-1])
		}
	}
}

func TestParseParams(t *testing.T) {
	p, err := ParseParams(map[string][]string{})
	if err != nil || p.Range != "1Y" || !p.Adjusted {
		t.Fatalf("defaults: %+v %v", p, err)
	}
	for _, bad := range []map[string][]string{
		{"range": {"2Y"}}, {"adjusted": {"yes"}}, {"downsample": {"lttb"}},
	} {
		if _, err := ParseParams(bad); err == nil {
			t.Fatalf("%v should fail", bad)
		}
	}
	p, err = ParseParams(map[string][]string{"range": {"MAX"}, "adjusted": {"false"}, "downsample": {"auto"}})
	if err != nil || p.Range != "MAX" || p.Adjusted {
		t.Fatalf("%+v %v", p, err)
	}
}

// INV-A04: the investment-context blocks carry their own dates and pass through unchanged, while
// the old arrays are still aligned to series.dates; INV-A01: an old snapshot without them works.
func TestExpandIndicatorsPassesInvBlocksThrough(t *testing.T) {
	blocks := `"month_year":[[2023,1,-10.0],[2023,2,null]],"month_year_reasons":[[2023,2,"incomplete_month_data"]],
	  "year_returns":[{"year":2023,"return_pct":-1.99,"kind":"full"}],
	  "seasonality":{"as_of":"2026-10-07","months":[{"month":1,"n_years":2}],"running":{"year":2026,"month":10}},
	  "position":{"as_of":"2026-10-07"},"drawdown_profile":{"as_of":"2026-10-07"},"holding_periods":{"windows":[]},
	  "entry_study":{"rows":[]},"vol_regime":{"band":"typical"},"sip_backtest":{"variants":[{"day":null}]},
	  "risk_adjusted":{"window":"3y"}`
	ind := `{"as_of":"2026-10-07","series":{"format":"columnar","dates":["2026-10-06","2026-10-07"],"sma50":[null,99.5]},
	  "analysis":{"format":"columnar","drawdown":[0,-1],` + blocks + `}}`
	got, err := ExpandIndicators([]byte(ind), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	an := got["analysis"].(map[string]any)
	if fmt.Sprint(an["drawdown"]) != "[[2026-10-06 0] [2026-10-07 -1]]" {
		t.Fatalf("drawdown not aligned: %v", an["drawdown"])
	}
	var want map[string]any
	if err := json.Unmarshal([]byte("{"+blocks+"}"), &want); err != nil {
		t.Fatal(err)
	}
	for k, v := range want {
		if !reflect.DeepEqual(an[k], v) {
			t.Errorf("%s changed: %v != %v", k, an[k], v)
		}
	}
	old, err := ExpandIndicators([]byte(`{"analysis":{"format":"columnar","drawdown":[0]}}`), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := old["analysis"].(map[string]any)["seasonality"]; ok {
		t.Fatal("an old snapshot must not gain blocks")
	}
}

// RST-W01: the relative_strength block (docs/03 4a.RST) passes through unchanged. Its nested
// ratio_rebased array is not zipped with the dates; an older snapshot without it gains nothing.
func TestExpandIndicatorsPassesRelativeStrengthThrough(t *testing.T) {
	block := `{"as_of":"2026-10-07","bars":3,"basis":"price return (adj_close), excludes dividends",
	  "vs_index":{"index_code":"NIFTY50","aligned_rows":2,"windows":[{"key":"1m","rows":21,"excess_pp":null,"reason":"insufficient_overlap"}],
	  "ratio_rebased":[100,null,99.5],"ratio_base_date":"2026-10-05","ratio_reason":null},"vs_index_reason":null,
	  "vs_peers":null,"vs_peers_reason":"no_sector"}`
	ind := `{"as_of":"2026-10-07","series":{"format":"columnar","dates":["2026-10-05","2026-10-06","2026-10-07"],"sma50":[null,null,99.5]},
	  "analysis":{"format":"columnar","drawdown":[0,-1,0],"relative_strength":` + block + `}}`
	got, err := ExpandIndicators([]byte(ind), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	an := got["analysis"].(map[string]any)
	var want map[string]any
	if err := json.Unmarshal([]byte(block), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(an["relative_strength"], want) {
		t.Fatalf("relative_strength changed: %v != %v", an["relative_strength"], want)
	}
	if fmt.Sprint(an["drawdown"]) != "[[2026-10-05 0] [2026-10-06 -1] [2026-10-07 0]]" {
		t.Fatalf("drawdown not aligned: %v", an["drawdown"])
	}
	old, err := ExpandIndicators([]byte(`{"analysis":{"format":"columnar","drawdown":[0]}}`), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := old["analysis"].(map[string]any)["relative_strength"]; ok {
		t.Fatal("an old snapshot must not gain the block")
	}
}

// SWD-A01: analysis.swing_dips and swing_dips_reason pass through unchanged, including the null
// block with reason compute_error; an old snapshot without them still works.
func TestExpandIndicatorsPassesSwingDipsThrough(t *testing.T) {
	for name, blocks := range map[string]string{
		"block": `"swing_dips":{"as_of":"2026-10-07","bars":15,"window_rows":252,
		  "thresholds":[{"threshold_pct":10,"dips":3,"recovered":2,"open":1,"median_days_to_recover":null,
		    "median_days_to_recover_reason":"too_few_episodes","records":[{"status":"open","recovery_date":null}]}],
		  "zigzag":[{"threshold_pct":10,"legs":4,"bounced":3,"open":1}]},"swing_dips_reason":null`,
		"compute_error": `"swing_dips":null,"swing_dips_reason":"compute_error"`,
	} {
		t.Run(name, func(t *testing.T) {
			ind := `{"as_of":"2026-10-07","series":{"format":"columnar","dates":["2026-10-06","2026-10-07"]},
			  "analysis":{"format":"columnar","drawdown":[0,-1],` + blocks + `}}`
			got, err := ExpandIndicators([]byte(ind), []byte(`{}`))
			if err != nil {
				t.Fatal(err)
			}
			an := got["analysis"].(map[string]any)
			var want map[string]any
			if err := json.Unmarshal([]byte("{"+blocks+"}"), &want); err != nil {
				t.Fatal(err)
			}
			for k, v := range want {
				if got, ok := an[k]; !ok || !reflect.DeepEqual(got, v) {
					t.Errorf("%s changed: %v != %v", k, got, v)
				}
			}
		})
	}
	old, err := ExpandIndicators([]byte(`{"analysis":{"format":"columnar","drawdown":[0]}}`), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := old["analysis"].(map[string]any)["swing_dips"]; ok {
		t.Fatal("an old snapshot must not gain the swing_dips block")
	}
}

// RST-X01: REAL worker output (fixtures/relative_strength, written by the worker contract test)
// goes through ExpandIndicators: the block is unchanged, ratio_rebased has one value per drawdown
// pair, and pair i carries the date series.dates[i] (also when the history is shorter than 750).
func TestExpandIndicatorsWithRealRelativeStrengthOutput(t *testing.T) {
	for _, name := range []string{"real_120.json", "real_800.json"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "fixtures", "relative_strength", name))
		if err != nil {
			t.Fatal(err)
		}
		var in map[string]any
		if err := json.Unmarshal(raw, &in); err != nil {
			t.Fatal(err)
		}
		dates := in["series"].(map[string]any)["dates"].([]any)
		want := in["analysis"].(map[string]any)["relative_strength"]
		got, err := ExpandIndicators(raw, []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		an := got["analysis"].(map[string]any)
		if !reflect.DeepEqual(an["relative_strength"], want) {
			t.Fatalf("%s: relative_strength changed by ExpandIndicators", name)
		}
		ratio := want.(map[string]any)["vs_index"].(map[string]any)["ratio_rebased"].([]any)
		dd := an["drawdown"].([][2]any)
		if len(dd) != len(ratio) || len(dd) != len(dates) {
			t.Fatalf("%s: drawdown %d, ratio %d, dates %d must be equal", name, len(dd), len(ratio), len(dates))
		}
		for i, p := range dd {
			if p[0] != dates[i] {
				t.Fatalf("%s: pair %d has date %v, want %v", name, i, p[0], dates[i])
			}
		}
	}
}
