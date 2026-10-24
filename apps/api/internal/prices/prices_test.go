package prices

import (
	"encoding/json"
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
