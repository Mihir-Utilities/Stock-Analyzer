package alerts

import (
	"encoding/json"
	"strings"
	"testing"
)

func fieldNames(f []FieldError) []string {
	out := make([]string, len(f))
	for i, e := range f {
		out[i] = e.Field
	}
	return out
}

// ALR-58: every kind has a parameter schema; bounds are inclusive where the spec gives a range.
func TestValidateParams(t *testing.T) {
	cases := []struct {
		name, kind, params string
		okJSON             string   // expected canonical JSON when valid
		badFields          []string // expected failing fields when invalid
	}{
		{"price ok", "price_above", `{"price":4000}`, `{"price":4000}`, nil},
		{"price below zero", "price_below", `{"price":0}`, "", []string{"params.price"}},
		{"price negative", "price_above", `{"price":-1}`, "", []string{"params.price"}},
		{"price missing", "price_above", `{}`, "", []string{"params.price"}},
		{"price null params", "price_above", `null`, "", []string{"params.price"}},
		{"price string", "price_above", `{"price":"4000"}`, "", []string{"params.price"}},
		{"price huge", "price_above", `{"price":1e999}`, "", []string{"params.price"}},
		{"unknown key", "price_above", `{"price":10,"extra":1}`, "", []string{"params.extra"}},
		{"day change ok low", "day_change_pct", `{"pct":0.1,"direction":"up"}`, `{"direction":"up","pct":0.1}`, nil},
		{"day change ok high", "day_change_pct", `{"pct":50,"direction":"either"}`, `{"direction":"either","pct":50}`, nil},
		{"day change too low", "day_change_pct", `{"pct":0.05,"direction":"up"}`, "", []string{"params.pct"}},
		{"day change too high", "day_change_pct", `{"pct":50.1,"direction":"down"}`, "", []string{"params.pct"}},
		{"day change bad direction", "day_change_pct", `{"pct":5,"direction":"sideways"}`, "", []string{"params.direction"}},
		{"day change no direction", "day_change_pct", `{"pct":5}`, "", []string{"params.direction"}},
		{"wk52 none", "wk52_high", `{}`, `{}`, nil},
		{"wk52 absent params", "wk52_low", ``, `{}`, nil},
		{"wk52 with params", "wk52_high", `{"x":1}`, "", []string{"params.x"}},
		{"results declared none", "results_declared", `{}`, `{}`, nil},
		{"ma ok", "ma_cross", `{"fast":50,"slow":200,"direction":"golden"}`, `{"direction":"golden","fast":50,"slow":200}`, nil},
		{"ma slow equals fast", "ma_cross", `{"fast":50,"slow":50,"direction":"death"}`, "", []string{"params.slow"}},
		{"ma slow below fast", "ma_cross", `{"fast":60,"slow":40,"direction":"death"}`, "", []string{"params.slow"}},
		{"ma fast too low", "ma_cross", `{"fast":4,"slow":200,"direction":"golden"}`, "", []string{"params.fast"}},
		{"ma slow too high", "ma_cross", `{"fast":50,"slow":301,"direction":"golden"}`, "", []string{"params.slow"}},
		{"ma fractional", "ma_cross", `{"fast":50.5,"slow":200,"direction":"golden"}`, "", []string{"params.fast"}},
		{"rsi ok", "rsi_above", `{"level":70}`, `{"level":70}`, nil},
		{"rsi zero", "rsi_below", `{"level":0}`, "", []string{"params.level"}},
		{"rsi 100", "rsi_above", `{"level":100}`, "", []string{"params.level"}},
		{"results upcoming ok", "results_upcoming", `{"days_before":14}`, `{"days_before":14}`, nil},
		{"results upcoming zero", "results_upcoming", `{"days_before":0}`, "", []string{"params.days_before"}},
		{"results upcoming 15", "results_upcoming", `{"days_before":15}`, "", []string{"params.days_before"}},
		{"holding ok", "holding_change", `{"holder":"fii","delta_pct":0.1}`, `{"delta_pct":0.1,"holder":"fii"}`, nil},
		{"holding bad holder", "holding_change", `{"holder":"retail","delta_pct":1}`, "", []string{"params.holder"}},
		{"holding delta high", "holding_change", `{"holder":"mf","delta_pct":20.5}`, "", []string{"params.delta_pct"}},
		{"nav ok", "nav_below", `{"nav":55.5}`, `{"nav":55.5}`, nil},
		{"nav zero", "nav_above", `{"nav":0}`, "", []string{"params.nav"}},
		{"not an object", "price_above", `[1]`, "", []string{"params"}},
		{"unknown kind", "bogus", `{}`, "", []string{"kind"}},
		{"several errors sorted", "day_change_pct", `{"pct":99,"direction":"x","z":1}`, "", []string{"params.direction", "params.pct", "params.z"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, errs := ValidateParams(tc.kind, json.RawMessage(tc.params))
			if tc.badFields == nil {
				if len(errs) > 0 {
					t.Fatalf("unexpected errors %v", errs)
				}
				if string(got) != tc.okJSON {
					t.Fatalf("canonical params = %s, want %s", got, tc.okJSON)
				}
				return
			}
			if len(errs) == 0 {
				t.Fatalf("expected errors %v, got params %s", tc.badFields, got)
			}
			if g, w := strings.Join(fieldNames(errs), ","), strings.Join(tc.badFields, ","); g != w {
				t.Fatalf("fields = %s, want %s (%v)", g, w, errs)
			}
		})
	}
}

// ALR-59: a kind only applies to its target type (nav_* to funds, the rest to stocks).
func TestTargetFor(t *testing.T) {
	for kind, want := range map[string]string{"price_above": "stock", "ma_cross": "stock", "holding_change": "stock", "nav_above": "mf", "nav_below": "mf", "x": ""} {
		if got := TargetFor(kind); got != want {
			t.Errorf("TargetFor(%q) = %q, want %q", kind, got, want)
		}
	}
}

// Every DDL kind has a schema (guards a kind added to the CHECK but not here).
func TestEveryKindHasSchema(t *testing.T) {
	if len(kindTarget) != 13 {
		t.Fatalf("expected the 13 kinds of docs/03 section 13, have %d", len(kindTarget))
	}
}
